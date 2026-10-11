import type { TimeRange } from "../types";

export type RangeSpec = { kind: "rolling"; hours: number } | { kind: "today" };

/** Parses `24h`, `12`, `today`; undefined when the value isn't a range. */
export function parseRangeStrict(value: unknown): RangeSpec | undefined {
  if (value === "today") return { kind: "today" };
  if (typeof value === "number" && value > 0) return { kind: "rolling", hours: value };
  if (typeof value === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*h?$/i.exec(value.trim());
    if (m && Number(m[1]) > 0) return { kind: "rolling", hours: Number(m[1]) };
  }
  return undefined;
}

/** Parses `24h`, `12`, `today`. Unknown values fall back to a rolling 24 h. */
export function parseRange(value: unknown): RangeSpec {
  return parseRangeStrict(value) ?? { kind: "rolling", hours: 24 };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an epoch (seconds) in a time zone. */
export function zonedParts(epoch: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(epoch * 1000))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function offsetSeconds(epoch: number, timeZone: string): number {
  const p = zonedParts(epoch, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - Math.floor(epoch);
}

/** Epoch seconds for a wall-clock time in a time zone (handles DST). */
export function zonedToEpoch(p: ZonedParts, timeZone: string): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  let epoch = guess - offsetSeconds(guess, timeZone);
  const corrected = guess - offsetSeconds(epoch, timeZone);
  if (corrected !== epoch) epoch = corrected;
  return epoch;
}

export function computeRange(spec: RangeSpec, now: number, timeZone: string): TimeRange {
  if (spec.kind === "today") {
    // The same boundary as day navigation, which handles DST skipping midnight.
    return { start: dayRange(dayKey(now, timeZone), timeZone).start, end: now };
  }
  return { start: now - spec.hours * 3600, end: now };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM:SS` in the given time zone (the format LLM Vision's get_events takes). */
export function formatLocalDateTime(epoch: number, timeZone: string): string {
  const p = zonedParts(epoch, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Start of the hour (in the time zone) containing the epoch, as an epoch. */
export function hourStart(epoch: number, timeZone: string): number {
  // Use the epoch's own offset, so the repeated hour on a DST fall-back day stays distinct.
  const offset = offsetSeconds(epoch, timeZone);
  const local = Math.floor(epoch) + offset;
  return local - (((local % 3600) + 3600) % 3600) - offset;
}

/** Parses an ISO timestamp to epoch seconds; NaN when invalid. */
export function isoToEpoch(iso: string): number {
  return Date.parse(iso) / 1000;
}

/** `49s`, `2m 10s`, `1h 5m`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export interface TimeFormatOptions {
  language: string;
  timeZone: string;
  /** HA locale time_format: "12", "24", "language" or "system". */
  timeFormat?: string;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function hourCycle(timeFormat: string | undefined): Intl.DateTimeFormatOptions["hourCycle"] {
  if (timeFormat === "24") return "h23";
  if (timeFormat === "12") return "h12";
  return undefined;
}

export function formatTime(epoch: number, opts: TimeFormatOptions): string {
  const key = `${opts.language}|${opts.timeZone}|${opts.timeFormat ?? ""}`;
  let f = timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(opts.language, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: hourCycle(opts.timeFormat),
      timeZone: opts.timeZone,
    });
    timeFormatters.set(key, f);
  }
  return f.format(new Date(epoch * 1000));
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDay(epoch: number, opts: TimeFormatOptions): string {
  const key = `${opts.language}|${opts.timeZone}`;
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(opts.language, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: opts.timeZone,
    });
    dayFormatters.set(key, f);
  }
  const s = f.format(new Date(epoch * 1000));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Calendar-day key (YYYY-MM-DD) in the time zone. */
export function dayKey(epoch: number, timeZone: string): string {
  const p = zonedParts(epoch, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function parseDayKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

/** The day key `days` calendar days after `key` (negative goes back). */
export function shiftDay(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Midnight to midnight of a calendar day in the time zone (23 or 25 h on DST days). */
export function dayRange(key: string, timeZone: string): TimeRange {
  const firstInstant = (k: string) => {
    const { year, month, day } = parseDayKey(k);
    let t = zonedToEpoch({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
    // Where DST skips midnight, that lands on the evening before; the day then starts at
    // the jump (transitions fall on whole quarter hours).
    for (let i = 0; i < 16 && dayKey(t, timeZone) !== k; i++) t += 900;
    return t;
  };
  return { start: firstInstant(key), end: firstInstant(shiftDay(key, 1)) };
}
