export function normalizeQwenDimension(value: number): number {
  if (!Number.isFinite(value)) return 1024;
  return Math.max(256, Math.min(1920, Math.ceil(value / 32) * 32));
}
