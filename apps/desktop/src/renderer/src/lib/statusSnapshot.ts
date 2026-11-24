function sameJsonValue(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (!current || !next || typeof current !== "object" || typeof next !== "object") return false;
  if (Array.isArray(current)) {
    return Array.isArray(next) && current.length === next.length &&
      current.every((value, index) => sameJsonValue(value, next[index]));
  }
  if (Array.isArray(next)) return false;
  const currentFields = current as Record<string, unknown>;
  const nextFields = next as Record<string, unknown>;
  const keys = Object.keys(currentFields);
  return keys.length === Object.keys(nextFields).length && keys.every((key) =>
    Object.hasOwn(nextFields, key) && sameJsonValue(currentFields[key], nextFields[key]));
}

/** Keep stable references for unchanged sections of a status response. */
export function reuseUnchangedStatus<T extends object>(current: T | null, snapshot: T): T {
  if (!current || current === snapshot) return snapshot;
  const keys = Object.keys(snapshot) as Array<keyof T>;
  const result = { ...snapshot };
  let changed = keys.length !== Object.keys(current).length;
  for (const key of keys) {
    if (Object.hasOwn(current, key) && sameJsonValue(current[key], snapshot[key])) result[key] = current[key];
    else changed = true;
  }
  return changed ? result : current;
}
