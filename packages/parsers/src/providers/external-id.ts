// Scanner externalIds are built from log fields (session, turn/model,
// timestamp) that can legitimately repeat — e.g. two Copilot shutdown
// segments that both fall back to the session start time. The server dedups
// on externalId, so the second occurrence would silently vanish.
//
// Suffix repeats with `:2`, `:3`, … in file order. The FIRST occurrence keeps
// the unsuffixed id so events already ingested by older CLIs keep matching;
// re-scans assign the same suffixes because parse order is file order.
export function suffixDuplicateExternalIds<T extends { externalId: string }>(
  events: T[],
): T[] {
  const seen = new Map<string, number>();
  for (const event of events) {
    const n = (seen.get(event.externalId) ?? 0) + 1;
    seen.set(event.externalId, n);
    if (n > 1) event.externalId = `${event.externalId}:${n}`;
  }
  return events;
}
