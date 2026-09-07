const MOJIBAKE_MARKERS = /[\u00c2\u00c3\u00e2]/;

/** Repair text decoded as a single-byte Windows encoding before it reached the renderer. */
export function repairMojibake(value: string): string {
  let current = value;

  for (let attempt = 0; attempt < 2 && MOJIBAKE_MARKERS.test(current); attempt += 1) {
    try {
      const bytes = Uint8Array.from(
        [...current].map((character) => character.charCodeAt(0) & 0xff),
      );
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (repaired === current) break;
      current = repaired;
    } catch {
      break;
    }
  }

  return current;
}

export function repairMojibakeDeep<T>(value: T): T {
  if (typeof value === "string") return repairMojibake(value) as T;
  if (Array.isArray(value)) return value.map((item) => repairMojibakeDeep(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairMojibakeDeep(item)]),
    ) as T;
  }
  return value;
}

