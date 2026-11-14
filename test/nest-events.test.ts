import { describe, expect, it } from "vitest";
import type { NestHistoryRow } from "../src/providers/nest";
import { groupNestHits, nestSession, parseNestHistory } from "../src/providers/nest";
import { iso } from "./helpers";

/** A token as Nest writes it: base64 of `["<session>", "<event>"]`. */
const token = (session: string, event: string) => btoa(JSON.stringify([session, event]));

const row = (at: string, type: string, tok: string, lu = iso(at)): NestHistoryRow => ({
  s: new Date(iso(at) * 1000).toISOString(),
  a: { event_type: type, nest_event_id: tok, device_class: "doorbell" },
  lu,
});

const range = { start: iso("2026-01-15T00:00:00Z"), end: iso("2026-01-16T00:00:00Z") };

describe("parseNestHistory", () => {
  it("reads one trigger per row, at the event's own time", () => {
    const hits = parseNestHistory(
      [row("2026-01-15T10:20:00Z", "ring", token("501", "n:1"))],
      "dev1",
      range,
    );
    expect(hits).toEqual([
      {
        deviceId: "dev1",
        token: token("501", "n:1"),
        type: "ring",
        at: iso("2026-01-15T10:20:00Z"),
      },
    ]);
  });

  it("skips unavailable rows, rows without a token, and triggers outside the range", () => {
    const hits = parseNestHistory(
      [
        // Written while the integration reloads: event_types, no event_type.
        { s: "unavailable", a: { event_types: ["ring"] }, lu: iso("2026-01-15T06:00:00Z") },
        { s: "unknown", lu: iso("2026-01-15T06:01:00Z") },
        {
          s: "2026-01-15T08:00:00.000Z",
          a: { event_type: "ring" },
          lu: iso("2026-01-15T08:00:00Z"),
        },
        // The row at the start of the range repeats a trigger from the day before.
        row("2026-01-14T17:00:00Z", "ring", token("400", "n:1"), range.start),
        row("2026-01-15T12:30:00Z", "camera_person", token("499", "302")),
      ],
      "dev1",
      range,
    );
    expect(hits.map((h) => h.type)).toEqual(["camera_person"]);
  });
});

describe("nestSession", () => {
  it("is the first element of the token", () => {
    expect(nestSession(token("504", "n:5"))).toBe("504");
  });

  it("is undefined for a token in another format", () => {
    expect(nestSession("not-base64!")).toBeUndefined();
    expect(nestSession(btoa("{}"))).toBeUndefined();
  });
});

describe("groupNestHits", () => {
  const hit = (at: string, type: string, tok: string, deviceId = "dev1") => ({
    deviceId,
    token: tok,
    type,
    at: iso(at),
  });

  it("counts a trigger written again after a restart once", () => {
    const ring = hit("2026-01-15T11:00:00Z", "ring", token("503", "n:1"));
    const visits = groupNestHits([ring, { ...ring }]);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ tokens: [token("503", "n:1")], end: undefined });
  });

  it("joins two rings of one session, and keeps the first token as the row's", () => {
    const visits = groupNestHits([
      hit("2026-01-15T09:00:34Z", "ring", token("504", "n:5")),
      hit("2026-01-15T09:00:00Z", "ring", token("504", "n:1")),
    ]);
    expect(visits).toEqual([
      {
        deviceId: "dev1",
        token: token("504", "n:1"),
        tokens: [token("504", "n:1"), token("504", "n:5")],
        type: "ring",
        start: iso("2026-01-15T09:00:00Z"),
        end: iso("2026-01-15T09:00:34Z"),
      },
    ]);
  });

  it("keeps a ring and the person seen before it apart: they have different sessions", () => {
    const visits = groupNestHits([
      hit("2026-01-15T10:16:00Z", "camera_person", token("500", "301")),
      hit("2026-01-15T10:20:00Z", "ring", token("501", "n:1")),
    ]);
    expect(visits.map((v) => v.type)).toEqual(["camera_person", "ring"]);
  });

  it("names a session by its ring over a person over motion, with that trigger's clip", () => {
    const visits = groupNestHits([
      hit("2026-01-15T07:00:00Z", "camera_motion", token("600", "1")),
      hit("2026-01-15T07:00:05Z", "camera_person", token("600", "2")),
      hit("2026-01-15T07:00:20Z", "ring", token("600", "n:1")),
    ]);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ type: "ring", token: token("600", "n:1") });
    expect(visits[0].tokens[0]).toBe(token("600", "1"));
  });

  it("keeps the same session on two devices apart", () => {
    const visits = groupNestHits([
      hit("2026-01-15T07:00:00Z", "camera_person", token("600", "1"), "dev1"),
      hit("2026-01-15T07:00:00Z", "camera_person", token("600", "2"), "dev2"),
    ]);
    expect(visits.map((v) => v.deviceId).sort()).toEqual(["dev1", "dev2"]);
  });
});
