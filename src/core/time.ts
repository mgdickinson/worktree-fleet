export function nowIso(): string {
  return new Date().toISOString();
}

export function eventTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function ageMs(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Date.now() - parsed;
}
