/** JSON objects returned by PostgreSQL need not retain the client's key order. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  // Undefined object properties are omitted from JSON requests.
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length
    && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}
