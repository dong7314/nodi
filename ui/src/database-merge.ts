import { jsonEqual as equal } from "./json-equal";
import type { DatabaseState } from "./InlineDatabase";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type DatabaseConflict = { key: string; path: string[]; local: unknown; remote: unknown };
export type ConflictChoices = Record<string, "local" | "remote">;
const object = (value: unknown): value is Record<string, Json> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keyed = (values: Json[]): values is Array<Record<string, Json> & { id: string }> => values.every((v) => object(v) && typeof v.id === "string")
  && new Set(values.map((v) => (v as { id: string }).id)).size === values.length;

/** Three-way merge: only edits made since the common snapshot are applied. */
export function mergeDatabase(base: DatabaseState, local: DatabaseState, remote: DatabaseState, choices: ConflictChoices = {}) {
  const conflicts: DatabaseConflict[] = [];
  const conflict = (_base: Json | undefined, l: Json | undefined, r: Json | undefined, path: string[]) => {
    const key = JSON.stringify(path);
    if (choices[key]) return choices[key] === "local" ? l : r;
    conflicts.push({ key, path, local: l, remote: r });
    return l;
  };
  // A deleted/retyped column and concurrent edits to its cells cannot be
  // safely split. Require an explicit whole-table choice in this rare case.
  const changedCells = (state: DatabaseState, propertyId: string) => {
    const values = (value: DatabaseState) => Object.fromEntries([...value.records, ...value.trash].map((row) => [row.id, row.values[propertyId]]));
    return !equal(values(base), values(state));
  };
  const localProperties = new Map(local.properties.map((property) => [property.id, property]));
  const remoteProperties = new Map(remote.properties.map((property) => [property.id, property]));
  const schemaCollision = base.properties.some((property) => {
    const lp = localProperties.get(property.id);
    const rp = remoteProperties.get(property.id);
    return !equal(lp, rp) && ((!lp || lp.type !== property.type) && changedCells(remote, property.id)
      || (!rp || rp.type !== property.type) && changedCells(local, property.id));
  });
  if (schemaCollision) {
    const state = conflict(base as unknown as Json, local as unknown as Json, remote as unknown as Json, []) as unknown as DatabaseState;
    return { state, conflicts };
  }
  const merge = (b: Json | undefined, l: Json | undefined, r: Json | undefined, path: string[]): Json | undefined => {
    if (equal(l, r)) return l;
    if (equal(b, l)) return r;
    if (equal(b, r)) return l;
    // Deletion versus editing is a conflict, never an implicit resurrection.
    if (l === undefined || r === undefined) return conflict(b, l, r, path);
    if (object(l) && object(r) && (object(b) || b === undefined)) {
      const result: Record<string, Json> = {};
      for (const key of new Set([...Object.keys(b ?? {}), ...Object.keys(l), ...Object.keys(r)])) {
        const value = merge(object(b) ? b[key] : undefined, l[key], r[key], [...path, key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(r) && keyed(b) && keyed(l) && keyed(r)) {
      const bm = new Map(b.map((v) => [v.id, v]));
      const lm = new Map(l.map((v) => [v.id, v]));
      const rm = new Map(r.map((v) => [v.id, v]));
      const baseOrder = b.map((v) => v.id).filter((id) => lm.has(id) && rm.has(id));
      const baseIds = new Set(baseOrder);
      const localOrder = l.map((v) => v.id).filter((id) => baseIds.has(id));
      const remoteOrder = r.map((v) => v.id).filter((id) => baseIds.has(id));
      let order = r.map((v) => v.id);
      if (!equal(localOrder, baseOrder)) {
        if (!equal(remoteOrder, baseOrder) && !equal(localOrder, remoteOrder)) {
          const resolved = conflict(baseOrder, localOrder, remoteOrder, [...path, "order"]);
          if (equal(resolved, localOrder)) order = l.map((v) => v.id);
        } else order = l.map((v) => v.id);
      }
      return [...new Set([...order, ...l.map((v) => v.id), ...r.map((v) => v.id)])]
        .map((id) => merge(bm.get(id), lm.get(id), rm.get(id), [...path, id]))
        .filter((value): value is Json => value !== undefined);
    }
    return conflict(b, l, r, path);
  };
  // Keep each row in one location. An archive/delete and concurrent row edit
  // must be resolved together instead of duplicating it in records and trash.
  const normalize = (state: DatabaseState) => ({
    ...state,
    records: undefined,
    trash: undefined,
    rows: [
      ...state.records.map((row) => ({ ...row, location: "records" })),
      ...state.trash.map((row) => ({ ...row, location: "trash" })),
    ],
  });
  const b = normalize(base), l = normalize(local), r = normalize(remote);
  const baseRows = new Map(b.rows.map((row) => [row.id, row]));
  const remoteRows = new Map(r.rows.map((row, index) => [row.id, { row, index }]));
  const resolvedRows = new Map<string, typeof l.rows[number]>();
  const localPositions = new Map<number, typeof l.rows[number]>();
  const remotePositions = new Map<number, typeof l.rows[number]>();
  for (const [index, row] of l.rows.entries()) {
    const original = baseRows.get(row.id);
    const remoteRow = remoteRows.get(row.id);
    const other = remoteRow?.row;
    if (original && other && row.location !== other.location
      && !equal(row, original) && !equal(other, original)) {
      const resolved = conflict(original as unknown as Json, row as unknown as Json, other as unknown as Json, ["rows", row.id]) as typeof row;
      resolvedRows.set(row.id, resolved);
      // Preserve the chosen row's position without undoing unrelated reorders.
      if (resolved === other) localPositions.set(remoteRow!.index, resolved);
      else remotePositions.set(index, resolved);
    }
  }
  // Apply the resolutions in one pass. Repeated find/splice/map here made large
  // tables quadratic even when only two independent cells had changed.
  const applyResolvedRows = (rows: typeof l.rows, positions: typeof localPositions) => {
    if (resolvedRows.size === 0) return rows;
    const movedIds = new Set([...positions.values()].map((row) => row.id));
    const remaining = rows.filter((row) => !movedIds.has(row.id));
    const result: typeof rows = [];
    let next = 0;
    let length = rows.length;
    for (const index of positions.keys()) length = Math.max(length, index + 1);
    for (let index = 0; index < length; index += 1) {
      const row = positions.get(index) ?? remaining[next++];
      if (row) result.push(resolvedRows.get(row.id) ?? row);
    }
    return result;
  };
  l.rows = applyResolvedRows(l.rows, localPositions);
  r.rows = applyResolvedRows(r.rows, remotePositions);
  const merged = merge(b as unknown as Json, l as unknown as Json, r as unknown as Json, []) as unknown as ReturnType<typeof normalize>;
  const { rows, ...rest } = merged;
  const state: DatabaseState = {
    ...rest,
    records: rows.filter((row) => row.location === "records").map(({ location, ...row }) => row),
    trash: rows.filter((row) => row.location === "trash").map(({ location, ...row }) => row),
  };
  if (!state.views.some((view) => view.id === state.activeViewId)) state.activeViewId = state.views[0]?.id ?? null;
  return { state, conflicts };
}

export function conflictLabel(conflict: DatabaseConflict, state: DatabaseState) {
  const [area, id, field, propertyId] = conflict.path;
  if (area === "name") return "표 이름";
  if (area === "activeViewId") return "선택한 보기";
  if (area === "rows") {
    const row = [...state.records, ...state.trash].find((item) => item.id === id);
    const firstText = state.properties.find((property) => property.type === "text");
    const label = firstText && row?.values[firstText.id] ? String(row.values[firstText.id]) : "행";
    return field === "values" ? `${label} · ${state.properties.find((property) => property.id === propertyId)?.name ?? "셀"}` : `${label}의 변경`;
  }
  if (area === "properties") return `${state.properties.find((property) => property.id === id)?.name ?? "속성"} 설정`;
  if (area === "views") return `${state.views.find((view) => view.id === id)?.name ?? "보기"} 설정`;
  return "속성과 셀 변경이 겹친 표 전체";
}
