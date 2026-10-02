import { test, expect } from "@playwright/test";
import { mergeDatabase } from "../src/database-merge";
import type { DatabaseState } from "../src/InlineDatabase";
const base: DatabaseState = {
  name: "표", properties: [{ id: "p", name: "이름", type: "text", options: [] }],
  records: [{ id: "a", values: { p: "A" } }, { id: "b", values: { p: "B" } }, { id: "c", values: { p: "C" } }], trash: [],
  views: [{ id: "v", type: "table", name: "테이블" }], activeViewId: "v",
};
test("merging independent row additions, removals and edits retains all changes", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.records.push({ id: "local", values: { p: "LOCAL" } }); local.records[0].values.p = "UPDATED";
  remote.records = remote.records.filter((r) => r.id !== "b"); remote.records.push({ id: "remote", values: { p: "REMOTE" } });
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toEqual([]);
  expect(Object.fromEntries(result.state.records.map((r) => [r.id, r.values.p]))).toEqual({ a: "UPDATED", c: "C", local: "LOCAL", remote: "REMOTE" });
});
test("archiving versus editing a row requires a choice without duplicating it", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.trash.push(local.records.shift()!); remote.records[0].values.p = "REMOTE";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toHaveLength(1);
  const resolved = mergeDatabase(base, local, remote, { [result.conflicts[0].key]: "remote" });
  expect(resolved.conflicts).toEqual([]); expect(resolved.state.trash).toEqual([]);
  expect(resolved.state.records[0].values.p).toBe("REMOTE");
  const archived = mergeDatabase(base, local, remote, { [result.conflicts[0].key]: "local" });
  expect(archived.state.records).toHaveLength(2); expect(archived.state.trash).toHaveLength(1);
});
test("permanent deletion versus row editing requires an explicit choice", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.records.shift(); remote.records[0].values.p = "REMOTE";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toHaveLength(1);
  expect(mergeDatabase(base, local, remote, { [result.conflicts[0].key]: "local" }).state.records).toHaveLength(2);
});
test("column deletion never silently hides concurrent cell edits", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.properties = []; local.records.forEach((r) => { r.values = {}; });
  remote.records[0].values.p = "REMOTE";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toHaveLength(1);
  expect(mergeDatabase(base, local, remote, { [result.conflicts[0].key]: "remote" }).state).toEqual(remote);
});
test("competing row reorders retain cell edits after order selection", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.records = [local.records[1], local.records[0], local.records[2]];
  remote.records = [remote.records[0], remote.records[2], remote.records[1]];
  remote.records[0].values.p = "UPDATED";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toHaveLength(1);
  const resolved = mergeDatabase(base, local, remote, { [result.conflicts[0].key]: "local" });
  expect(resolved.state.records.map((r) => r.id)).toEqual(["b", "a", "c"]);
  expect(resolved.state.records[1].values.p).toBe("UPDATED");
});

test("server JSON key ordering alone is not a change or conflict", () => {
  const remote = JSON.parse(JSON.stringify(base, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
  const local = structuredClone(base); local.records[0].values.p = "CHANGED";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts).toEqual([]);
  expect(result.state.records[0].values.p).toBe("CHANGED");
});

test("resolving many archived rows retains each chosen location and unrelated row order", () => {
  const local = structuredClone(base), remote = structuredClone(base);
  local.records = [local.records[2]];
  local.trash = [base.records[0], base.records[1]];
  remote.records[0].values.p = "REMOTE A";
  remote.records[1].values.p = "REMOTE B";
  const result = mergeDatabase(base, local, remote);
  expect(result.conflicts.filter((item) => item.path.length === 2)).toHaveLength(2);
  const resolved = mergeDatabase(base, local, remote, {
    [JSON.stringify(["rows", "a"])]: "remote",
    [JSON.stringify(["rows", "b"])]: "local",
  });
  expect(resolved.conflicts).toEqual([]);
  expect(resolved.state.records.map((row) => row.id)).toEqual(["a", "c"]);
  expect(resolved.state.records[0].values.p).toBe("REMOTE A");
  expect(resolved.state.trash.map((row) => row.id)).toEqual(["b"]);
});

test("large independent edits do not repeatedly scan every other row", () => {
  const count = 6000;
  let idReads = 0;
  const makeRows = () => Array.from({ length: count }, (_, index) => ({
    get id() { idReads++; return `row-${index}`; }, values: { p: `VALUE ${index}` },
  }));
  const snapshot = { ...base, records: makeRows() };
  const local = { ...base, records: makeRows() };
  const remote = { ...base, records: makeRows() };
  local.records[0].values.p = "LOCAL";
  remote.records[count - 1].values.p = "REMOTE";
  const result = mergeDatabase(snapshot, local, remote);
  expect(result.conflicts).toEqual([]);
  expect(result.state.records[0].values.p).toBe("LOCAL");
  expect(result.state.records[count - 1].values.p).toBe("REMOTE");
  // Count input traversals, not wall time: this stays stable on slower CI hosts.
  expect(idReads).toBeLessThan(count * 100);
});

test("bulk archive conflicts resolve without duplicating or dropping rows", () => {
  const rows = Array.from({ length: 4000 }, (_, index) => ({ id: `row-${index}`, values: { p: `VALUE ${index}` } }));
  const snapshot = { ...base, records: rows };
  const local = { ...base, records: [], trash: structuredClone(rows) };
  const remote = { ...base, records: rows.map((row) => ({ ...row, values: { p: `REMOTE ${row.id}` } })) };
  const choices = Object.fromEntries(rows.map((row, index) => [JSON.stringify(["rows", row.id]), index % 2 ? "local" as const : "remote" as const]));
  const result = mergeDatabase(snapshot, local, remote, choices);
  expect(result.conflicts).toEqual([]);
  expect(result.state.records.map((row) => row.id)).toEqual(rows.filter((_, index) => index % 2 === 0).map((row) => row.id));
  expect(result.state.trash.map((row) => row.id)).toEqual(rows.filter((_, index) => index % 2 === 1).map((row) => row.id));
  expect(new Set([...result.state.records, ...result.state.trash].map((row) => row.id)).size).toBe(rows.length);
});
