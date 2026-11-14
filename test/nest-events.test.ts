import { describe, expect, it } from "vitest";
import type { NestHistoryRow } from "../src/providers/nest";
import {
  createNestEventProvider,
  groupNestHits,
  latestNestBefore,
  nestEventsChanged,
  nestSession,
  parseNestHistory,
} from "../src/providers/nest";
import type { HomeAssistant } from "../src/ha-types";
import type { ProviderContext } from "../src/types";
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

/** A hass with one Nest doorbell (device dev1) and its two event entities. */
function nestHass(states: Record<string, { state: string; attributes?: Record<string, unknown> }>) {
  const calls: Record<string, unknown>[] = [];
  const history: Record<string, NestHistoryRow[]> = {};
  const hass = {
    states: Object.fromEntries(
      Object.entries(states).map(([id, s]) => [
        id,
        {
          entity_id: id,
          state: s.state,
          attributes: s.attributes ?? {},
          last_changed: "",
          last_updated: "2026-01-15T10:20:00Z",
        },
      ]),
    ),
    entities: {
      "event.front_chime": { entity_id: "event.front_chime", device_id: "dev1", platform: "nest" },
      "event.front_motion": {
        entity_id: "event.front_motion",
        device_id: "dev1",
        platform: "nest",
      },
      "event.hall_button": { entity_id: "event.hall_button", device_id: "dev2", platform: "hue" },
    },
    devices: { dev1: { id: "dev1", name: "Front door bell", name_by_user: "" } },
    callWS: (msg: Record<string, unknown>) => {
      calls.push(msg);
      return Promise.resolve(history);
    },
  } as unknown as HomeAssistant;
  return { hass, calls, history };
}

const ctxFor = (hass: HomeAssistant): ProviderContext =>
  ({
    hass,
    cameras: { byDevice: () => undefined, get: () => undefined },
    localize: (key: string, p?: Record<string, string | number>) =>
      key === "title.rang_at_camera" ? `Rang at ${p?.camera}` : key,
    now: iso("2026-01-15T12:00:00Z"),
  }) as unknown as ProviderContext;

describe("Nest event provider", () => {
  it("asks history for the Nest event entities only, and adds a trigger the recorder hasn't stored yet", async () => {
    const ring = token("501", "n:1");
    const { hass, calls } = nestHass({
      "event.front_chime": {
        state: "2026-01-15T10:20:00.000Z",
        attributes: { event_type: "ring", nest_event_id: ring },
      },
    });
    const rows = await createNestEventProvider().fetch(range, ctxFor(hass));
    expect(calls).toHaveLength(1);
    expect((calls[0].entity_ids as string[]).sort()).toEqual([
      "event.front_chime",
      "event.front_motion",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `nest:${ring}`,
      aliases: [ring],
      category: "doorbell",
      // No camera mapped and an empty name_by_user: the device's own name.
      title: "Rang at Front door bell",
      cameraLabel: "Front door bell",
      labels: ["chime"],
      clip: { kind: "mp4", path: `media-source://nest/dev1/${ring}`, resolve: true },
    });
  });

  it("asks nothing when there are no Nest event entities", async () => {
    const { hass, calls } = nestHass({});
    (hass as { entities: unknown }).entities = {};
    expect(await createNestEventProvider().fetch(range, ctxFor(hass))).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("nestEventsChanged", () => {
  const at = (s: string) => nestHass({ "event.front_chime": { state: s } }).hass;

  it("is true for a new trigger", () => {
    expect(nestEventsChanged(at("2026-01-15T10:00:00Z"), at("2026-01-15T10:20:00Z"))).toBe(true);
  });

  it("is false when the entity goes unavailable, or only an attribute changes", () => {
    expect(nestEventsChanged(at("2026-01-15T10:00:00Z"), at("unavailable"))).toBe(false);
    expect(nestEventsChanged(at("2026-01-15T10:00:00Z"), at("2026-01-15T10:00:00Z"))).toBe(false);
  });
});

describe("latestNestBefore", () => {
  it("is the newest trigger before the range", () => {
    const { hass } = nestHass({
      "event.front_chime": { state: "2026-01-14T18:00:00Z" },
      "event.front_motion": { state: "2026-01-14T20:00:00Z" },
    });
    expect(latestNestBefore(hass, range.start)).toBe(iso("2026-01-14T20:00:00Z"));
    expect(latestNestBefore(hass, iso("2026-01-14T19:00:00Z"))).toBe(iso("2026-01-14T18:00:00Z"));
  });
});
