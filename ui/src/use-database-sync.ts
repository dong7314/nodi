import { jsonEqual as same } from "./json-equal";
import { useEffect, useRef, useState } from "react";
import { NodiApiError } from "./api-client";
import { workspaceApi, type ServerInlineDatabase } from "./server-api";
import { mergeDatabase, type ConflictChoices, type DatabaseConflict } from "./database-merge";
import type { DatabaseState } from "./InlineDatabase";
import { cacheDatabaseSnapshot, readDatabaseDraft } from "./database-cache";

// A returning editor must wait for saves from the editor that just unmounted.
const queues = new Map<string, Promise<unknown>>();
export function enqueueDatabaseSync<T>(id: string, task: () => Promise<T>): Promise<T> {
  const result = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
  queues.set(id, result);
  void result.finally(() => { if (queues.get(id) === result) queues.delete(id); }).catch(() => undefined);
  return result;
}

const draftKey = (id: string) => `nodi:database-draft:${id}`;
type Draft = { state: DatabaseState; base?: DatabaseState; revision?: number };
type Conflict = { base?: DatabaseState; local: DatabaseState; remote: ServerInlineDatabase<DatabaseState>; items: DatabaseConflict[] };
type Session = { schedule: (state: DatabaseState) => void; flush: () => void; retry: () => void; resolve: (choices: ConflictChoices) => void };

export function useDatabaseSync({
  databaseId, database, onLoad, onNotice, enabled, pageId, readOnly, realtimeEvent,
}: {
  databaseId: string; database: DatabaseState; onLoad: (state: DatabaseState) => void;
  onNotice: (message: string) => void; enabled: boolean; pageId: string | null;
  readOnly: boolean; realtimeEvent: string;
}) {
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const latest = useRef({ database, onLoad, onNotice, readOnly });
  latest.current = { database, onLoad, onNotice, readOnly };
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    if (!enabled) { setLoading(false); setError(false); setConflict(null); return; }
    let active = true, ready = false, writing = false, initializing = false;
    let revision: number | undefined;
    let baseline: DatabaseState | undefined;
    let desired = latest.current.database;
    let collision: Conflict | null = null;
    let pendingRemote: ServerInlineDatabase<DatabaseState> | null = null;
    let timer: number | undefined;
    const cache = (state: DatabaseState) => {
      try { cacheDatabaseSnapshot(databaseId, state); }
      catch { if (active) latest.current.onNotice("표의 임시 저장 공간이 부족하거나 사용할 수 없어요"); }
    };
    const show = (state: DatabaseState) => {
      desired = state;
      cache(state);
      if (active) latest.current.onLoad(state);
    };
    const remember = () => {
      try {
        if (same(desired, baseline)) localStorage.removeItem(draftKey(databaseId));
        else localStorage.setItem(draftKey(databaseId), JSON.stringify({ state: desired, base: baseline, revision }));
      } catch { if (active) latest.current.onNotice("표의 임시 저장 공간이 부족하거나 사용할 수 없어요"); }
    };
    const report = (cause: unknown) => {
      remember();
      if (active) {
        setError(true);
        latest.current.onNotice(cause instanceof Error ? cause.message : "표를 저장하지 못했어요. 연결 후 다시 시도해 주세요.");
      }
    };
    const reconcile = (remote: ServerInlineDatabase<DatabaseState>) => {
      if (active) setError(false);
      const result = baseline ? mergeDatabase(baseline, desired, remote.state) : {
        state: desired, conflicts: [{ key: "[]", path: [], local: desired, remote: remote.state }],
      };
      if (result.conflicts.length) {
        collision = { base: baseline, local: desired, remote, items: result.conflicts };
        if (active) {
          setConflict(collision);
          latest.current.onNotice("다른 위치의 변경과 충돌했어요. 작성 내용은 이 브라우저에 보관했어요. 표에서 변경을 비교해 주세요.");
        }
        remember();
        return false;
      }
      baseline = remote.state;
      revision = remote.revision;
      show(result.state);
      remember();
      return true;
    };
    const flush = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!ready || writing || collision || latest.current.readOnly) return;
      const remote = pendingRemote;
      pendingRemote = null;
      if (remote && remote.revision > (revision ?? 0) && !reconcile(remote)) return;
      if (same(desired, baseline)) return;
      writing = true;
      let failed = false;
      void enqueueDatabaseSync(databaseId, async () => {
        // Retry a bounded number of concurrent revisions; continuous contention
        // leaves a durable draft and an explicit retry instead of a busy loop.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (latest.current.readOnly) return;
          const sent = desired;
          if (same(sent, baseline)) return;
          try {
            const saved = await workspaceApi.putDatabase(databaseId, { pageId, state: sent, revision });
            baseline = saved.state;
            revision = saved.revision;
            if (active) setError(false);
            remember();
            // Other mounted views (including a private page preview) need the
            // acknowledgement even when this page has no WebSocket room.
            window.dispatchEvent(new CustomEvent(realtimeEvent, { detail: saved }));
            return;
          } catch (cause) {
            if (!(cause instanceof NodiApiError) || cause.status !== 409) throw cause;
            const remote = await workspaceApi.getDatabase<DatabaseState>(databaseId);
            if (!reconcile(remote)) return;
          }
        }
        throw new Error("표가 계속 변경되고 있어요. 초안을 보관했으니 잠시 후 다시 저장해 주세요.");
      }).catch((cause) => { failed = true; report(cause); }).finally(() => {
        writing = false;
        // Changes typed while a request was in flight must also be sent.
        if (!failed) flush();
      });
    };
    const initialize = () => {
      if (initializing) return;
      initializing = true;
      void enqueueDatabaseSync(databaseId, async () => {
        if (!active) return;
        const draft: Draft | null = readDatabaseDraft(databaseId);
        // A durable local draft is real data even while its server is offline.
        // Show/cache it before fetching; never cache the initial placeholder.
        if (draft && !latest.current.readOnly) show(draft.state);
        let value: ServerInlineDatabase<DatabaseState>;
        try {
          value = await workspaceApi.getDatabase<DatabaseState>(databaseId);
        } catch (cause) {
          if (!(cause instanceof NodiApiError) || cause.status !== 404 || latest.current.readOnly || !active) throw cause;
          value = await workspaceApi.putDatabase(databaseId, { pageId, state: draft?.state ?? desired });
        }
        if (!active) return;
        ready = true;
        setError(false);
        if (draft?.state && !same(draft.state, value.state) && !latest.current.readOnly) {
          baseline = draft.base ?? (draft.revision === value.revision ? value.state : undefined);
          revision = draft.revision;
          show(draft.state);
          reconcile(value);
        } else {
          baseline = value.state;
          revision = value.revision;
          show(value.state);
          // A read-only viewer must not erase a previously saved editable draft.
          if (!latest.current.readOnly) remember();
        }
        setLoading(false);
      }).catch((cause) => { if (active) { setError(true); latest.current.onNotice(cause instanceof Error ? cause.message : "표를 불러오지 못했어요"); } })
        .finally(() => { initializing = false; if (active) flush(); });
    };
    const session: Session = {
      flush,
      retry: () => ready ? flush() : initialize(),
      schedule: (state) => {
        if (!ready) return;
        cache(state);
        if (latest.current.readOnly || collision || same(state, desired)) return;
        desired = state;
        remember();
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(flush, 500);
      },
      resolve: (choices) => {
        if (!collision || latest.current.readOnly || collision.items.some((item) => !choices[item.key])) return;
        const state = collision.base
          ? mergeDatabase(collision.base, collision.local, collision.remote.state, choices).state
          : choices["[]"] === "remote" ? collision.remote.state : collision.local;
        baseline = collision.remote.state;
        revision = collision.remote.revision;
        collision = null;
        setConflict(null);
        setError(false);
        show(state);
        remember();
        flush();
      },
    };
    sessionRef.current = session;
    setLoading(true); setError(false); setConflict(null);
    initialize();
    const receive = (event: Event) => {
      const value = (event as CustomEvent<ServerInlineDatabase<DatabaseState>>).detail;
      if (value?.id !== databaseId || value.revision <= (revision ?? 0)) return;
      // An event can overtake an HTTP acknowledgement or the initial GET.
      // Retain it so the end of that request can apply the newer revision.
      if (!ready || writing || collision || !same(desired, baseline)) {
        if (!pendingRemote || pendingRemote.revision < value.revision) pendingRemote = value;
        return;
      }
      baseline = value.state;
      revision = value.revision;
      show(value.state);
    };
    window.addEventListener(realtimeEvent, receive);
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", session.retry);
    return () => {
      active = false;
      flush();
      if (sessionRef.current === session) sessionRef.current = null;
      window.removeEventListener(realtimeEvent, receive);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", session.retry);
    };
  }, [databaseId, enabled, pageId, readOnly, realtimeEvent]);

  useEffect(() => {
    if (enabled) sessionRef.current?.schedule(database);
    else {
      try { cacheDatabaseSnapshot(databaseId, database); }
      catch { latest.current.onNotice("표의 임시 저장 공간이 부족하거나 사용할 수 없어요"); }
    }
  }, [database, databaseId, enabled]);

  return { loading, error, conflict, flush: () => sessionRef.current?.flush(),
    retry: () => sessionRef.current?.retry(), resolve: (choices: ConflictChoices) => sessionRef.current?.resolve(choices) };
}
