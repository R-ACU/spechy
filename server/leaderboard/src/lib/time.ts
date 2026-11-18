// Weeks are ISO 8601 weeks in UTC: a week starts Monday 00:00 UTC, key "YYYY-Www".

export const DAY = 86_400_000;

export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the week containing `now`. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
  return midnight - weekday * DAY;
}

export function isoWeek(now: number): string {
  const thursday = new Date(weekStart(now) + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const ordinal = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY) + 1;
  const week = Math.floor((ordinal - 1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;

/** Monday 00:00 UTC of an ISO week key, or null if the key is malformed or does not exist. */
export function weekKeyStart(key: string): number | null {
  const m = WEEK_PATTERN.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const start = weekStart(Date.UTC(year, 0, 4)) + (week - 1) * 7 * DAY;
  return isoWeek(start) === key ? start : null;
}

export function previousWeek(now: number): string {
  return isoWeek(weekStart(now) - DAY);
}
