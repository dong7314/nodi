import type { PartialBlock } from "@blocknote/core";
import type { DatabaseState } from "./InlineDatabase";
import { makeId } from "./types";

type ResourceBlock = { id?: string; type?: string; props?: { databaseId?: string }; children?: PartialBlock[] };
const storageKey = (id: string) => `nodi:database:${id}`;

export function copyDatabase(sourceId: string, snapshot?: DatabaseState) {
  const state = snapshot ?? JSON.parse(localStorage.getItem(storageKey(sourceId)) ?? "null") as DatabaseState | null;
  if (!state || !Array.isArray(state.properties) || !Array.isArray(state.records) || !Array.isArray(state.views)) {
    throw new Error("표 내용을 불러온 뒤 다시 복사해 주세요.");
  }
  const id = makeId("database");
  localStorage.setItem(storageKey(id), JSON.stringify(state));
  return id;
}

export function collectDatabaseSnapshots(blocks: PartialBlock[]): Record<string, DatabaseState> {
  const snapshots: Record<string, DatabaseState> = {};
  const visit = (values: PartialBlock[]) => values.forEach((value) => {
    const block = value as ResourceBlock;
    if (block.type === "database") {
      const id = block.props?.databaseId || `database-${block.id}`;
      const raw = localStorage.getItem(storageKey(id));
      if (raw) snapshots[id] = JSON.parse(raw) as DatabaseState;
    }
    if (block.children) visit(block.children);
  });
  visit(blocks);
  return snapshots;
}

export function copyDatabaseReferences(blocks: PartialBlock[], snapshots: Record<string, DatabaseState> = {}): PartialBlock[] {
  return blocks.map((value) => {
    const block = value as ResourceBlock;
    const sourceId = block.props?.databaseId || `database-${block.id}`;
    return {
      ...value,
      ...(block.type === "database" ? { props: { ...block.props, databaseId: copyDatabase(sourceId, snapshots[sourceId]) } } : {}),
      ...(block.children ? { children: copyDatabaseReferences(block.children, snapshots) } : {}),
    } as PartialBlock;
  });
}
