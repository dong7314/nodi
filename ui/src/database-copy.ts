import type { PartialBlock } from "@blocknote/core";
import type { DatabaseState } from "./InlineDatabase";
import { makeId } from "./types";
import { cacheDatabaseSnapshot, DATABASE_NOT_READY_MESSAGE, isDatabaseState, readDatabaseSnapshot } from "./database-cache";

type ResourceBlock = { id?: string; type?: string; props?: { databaseId?: string }; children?: PartialBlock[] };
export function copyDatabase(sourceId: string, snapshot?: DatabaseState) {
  const state = snapshot ?? readDatabaseSnapshot(sourceId);
  if (!isDatabaseState(state)) {
    throw new Error(DATABASE_NOT_READY_MESSAGE);
  }
  const id = makeId("database");
  cacheDatabaseSnapshot(id, state);
  return id;
}

export function collectDatabaseSnapshots(blocks: PartialBlock[], requireAll = false): Record<string, DatabaseState> {
  const snapshots: Record<string, DatabaseState> = {};
  const visit = (values: PartialBlock[]) => values.forEach((value) => {
    const block = value as ResourceBlock;
    if (block.type === "database") {
      const id = block.props?.databaseId || `database-${block.id}`;
      const state = readDatabaseSnapshot(id);
      if (state) snapshots[id] = state;
      else if (requireAll) throw new Error(DATABASE_NOT_READY_MESSAGE);
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
