/**
 * Formats an instant as ISO-8601 with the actual numeric UTC offset for the
 * given IANA zone at that instant (e.g. "2026-08-26T18:57:23+05:30"),
 * instead of `Date#toISOString()`'s always-UTC "Z" suffix. Handing the
 * planner an already-localized, already-offset string avoids relying on an
 * LLM to correctly convert a UTC instant into a target time zone itself —
 * a step it can silently get wrong (e.g. treating the UTC clock digits as
 * if they were already local time).
 */
export function formatIsoWithOffset(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  // Some locales/ICU builds render midnight as hour "24" instead of "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const localAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutesTotal = Math.round((localAsUtcMs - date.getTime()) / 60_000);
  const sign = offsetMinutesTotal >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutesTotal);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const offsetMinutes = String(absMinutes % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetMinutes}`;
}
