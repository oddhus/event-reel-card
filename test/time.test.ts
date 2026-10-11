import { describe, expect, it } from "vitest";
import {
  computeRange,
  dayRange,
  formatDuration,
  formatLocalDateTime,
  formatTime,
  hourStart,
  parseRange,
  shiftDay,
  zonedToEpoch,
} from "../src/core/time";
import { iso } from "./helpers";

const OSLO = "Europe/Oslo";

describe("day navigation", () => {
  it("steps across month, year and leap-day boundaries", () => {
    expect(shiftDay("2026-10-11", -1)).toBe("2026-10-10");
    expect(shiftDay("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2025-12-31", 1)).toBe("2026-01-01");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("covers a day from local midnight to local midnight", () => {
    expect(dayRange("2026-10-10", OSLO)).toEqual({
      start: iso("2026-10-09T22:00:00Z"),
      end: iso("2026-10-10T22:00:00Z"),
    });
    expect(dayRange("2026-01-15", OSLO)).toEqual({
      start: iso("2026-01-14T23:00:00Z"),
      end: iso("2026-01-15T23:00:00Z"),
    });
  });

  it("gives DST days 23 and 25 hours", () => {
    // Clocks go forward on 2026-03-29 and back on 2026-10-25 in Oslo.
    const spring = dayRange("2026-03-29", OSLO);
    expect(spring).toEqual({
      start: iso("2026-03-28T23:00:00Z"),
      end: iso("2026-03-29T22:00:00Z"),
    });
    const autumn = dayRange("2026-10-25", OSLO);
    expect(autumn).toEqual({
      start: iso("2026-10-24T22:00:00Z"),
      end: iso("2026-10-25T23:00:00Z"),
    });
  });

  it("starts a day at the jump where DST skips midnight", () => {
    // In Santiago, 2026-09-06 00:00 doesn't exist: the clock goes from 23:59 (-04) to 01:00 (-03).
    const santiago = "America/Santiago";
    expect(dayRange("2026-09-06", santiago).start).toBe(iso("2026-09-06T04:00:00Z"));
    expect(dayRange("2026-09-05", santiago).end).toBe(iso("2026-09-06T04:00:00Z"));
    expect(dayRange("2026-09-05", santiago).start).toBe(iso("2026-09-05T04:00:00Z"));
  });

  it("starts 'today' at the jump where DST skips midnight", () => {
    const santiago = "America/Santiago";
    const noon = iso("2026-09-06T12:00:00-03:00");
    expect(computeRange({ kind: "today" }, noon, santiago)).toEqual({
      start: iso("2026-09-06T04:00:00Z"), // 01:00 local, the first instant of the day
      end: noon,
    });
  });
});

describe("parseRange", () => {
  it("parses rolling hours and today", () => {
    expect(parseRange("24h")).toEqual({ kind: "rolling", hours: 24 });
    expect(parseRange(12)).toEqual({ kind: "rolling", hours: 12 });
    expect(parseRange("6")).toEqual({ kind: "rolling", hours: 6 });
    expect(parseRange("today")).toEqual({ kind: "today" });
  });

  it("falls back to 24 h", () => {
    expect(parseRange("soon")).toEqual({ kind: "rolling", hours: 24 });
    expect(parseRange(undefined)).toEqual({ kind: "rolling", hours: 24 });
  });
});

describe("time zones", () => {
  it("converts wall-clock time to epoch in summer and winter", () => {
    expect(
      zonedToEpoch({ year: 2026, month: 10, day: 8, hour: 14, minute: 16, second: 26 }, OSLO),
    ).toBe(iso("2026-10-08T14:16:26+02:00"));
    expect(
      zonedToEpoch({ year: 2026, month: 12, day: 1, hour: 0, minute: 0, second: 0 }, OSLO),
    ).toBe(iso("2026-12-01T00:00:00+01:00"));
  });

  it("starts 'today' at local midnight", () => {
    const now = iso("2026-10-10T09:30:00+02:00");
    expect(computeRange({ kind: "today" }, now, OSLO)).toEqual({
      start: iso("2026-10-10T00:00:00+02:00"),
      end: now,
    });
  });

  it("handles the DST change day", () => {
    const now = iso("2026-10-25T12:00:00+01:00");
    expect(computeRange({ kind: "today" }, now, OSLO).start).toBe(iso("2026-10-25T00:00:00+02:00"));
  });

  it("computes rolling ranges with plain arithmetic", () => {
    expect(computeRange({ kind: "rolling", hours: 24 }, 100000, OSLO)).toEqual({
      start: 100000 - 86400,
      end: 100000,
    });
  });

  it("formats the LLM Vision local timestamp", () => {
    expect(formatLocalDateTime(iso("2026-10-08T12:16:26Z"), OSLO)).toBe("2026-10-08 14:16:26");
  });

  it("finds the start of the hour", () => {
    expect(hourStart(iso("2026-10-08T14:16:26+02:00"), OSLO)).toBe(
      iso("2026-10-08T14:00:00+02:00"),
    );
  });

  it("formats times with the HA time format", () => {
    const t = iso("2026-10-08T14:16:26+02:00");
    expect(formatTime(t, { language: "nb", timeZone: OSLO, timeFormat: "24" })).toBe("14:16");
    expect(formatTime(t, { language: "en", timeZone: OSLO, timeFormat: "12" })).toMatch(
      /02:16\s?PM/i,
    );
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(49)).toBe("49s");
    expect(formatDuration(130)).toBe("2m 10s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3900)).toBe("1h 5m");
  });
});

describe("hourStart on the DST fall-back day", () => {
  it("keeps the two 02:xx hours apart", () => {
    const first = iso("2026-10-25T02:30:00+02:00");
    const second = iso("2026-10-25T02:30:00+01:00");
    expect(hourStart(first, OSLO)).toBe(iso("2026-10-25T02:00:00+02:00"));
    expect(hourStart(second, OSLO)).toBe(iso("2026-10-25T02:00:00+01:00"));
  });
});
