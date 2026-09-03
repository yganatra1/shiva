const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MFAPI_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;

export function isIsoDate(value: string): boolean {
  return parseIsoDateUtc(value) !== undefined;
}

export function parseIsoDateUtc(value: string): Date | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

/** MFapi currently emits NAV dates as DD-MM-YYYY. */
export function mfapiDateToIso(value: string): string | undefined {
  const match = MFAPI_DATE.exec(value.trim());
  if (!match) return undefined;
  const day = match[1];
  const month = match[2];
  const year = match[3];
  if (!day || !month || !year) return undefined;
  const iso = `${year}-${month}-${day}`;
  return parseIsoDateUtc(iso) ? iso : undefined;
}

export function formatIsoDateUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function compareIsoDates(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function calendarDaysBetween(startIso: string, endIso: string): number {
  const start = requireIso(startIso);
  const end = requireIso(endIso);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export function addCalendarDays(iso: string, days: number): string {
  const date = requireIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDateUtc(date);
}

export function addCalendarMonths(iso: string, months: number): string {
  const date = requireIso(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = daysInUtcMonth(date.getUTCFullYear(), date.getUTCMonth());
  date.setUTCDate(Math.min(day, lastDay));
  return formatIsoDateUtc(date);
}

export function addCalendarYears(iso: string, years: number): string {
  return addCalendarMonths(iso, years * 12);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function requireIso(value: string): Date {
  const parsed = parseIsoDateUtc(value);
  if (!parsed) {
    throw new Error(`Invalid ISO calendar date '${value}'.`);
  }
  return parsed;
}
