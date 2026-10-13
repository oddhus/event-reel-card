import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config";
import { buildCameraRegistry } from "../src/core/cameras";
import { mergeEvents } from "../src/core/merge";
import { configToForm, formToConfig } from "../src/editor-model";
import { getLocalize } from "../src/i18n";
import {
  createEventReelProvider,
  eventReelToEvents,
  latestEventReelBefore,
} from "../src/providers/eventreel";
import type { EventReelMapContext, EventReelRecord } from "../src/providers/eventreel";
import type { HassEntity, HomeAssistant } from "../src/ha-types";
import { ev, iso } from "./helpers";

const state = (entity_id: string, attributes: Record<string, unknown> = {}): HassEntity => ({
  entity_id,
  state: "idle",
  attributes,
  last_changed: "",
  last_updated: "",
});

const cameras = buildCameraRegistry({
  states: {
    "camera.entrance": state("camera.entrance", {
      friendly_name: "Entrance",
      client_id: "frigate",
      camera_name: "entrance",
    }),
    "camera.doorbell": state("camera.doorbell", { friendly_name: "Doorbell" }),
  },
  entities: {
    "camera.doorbell": { entity_id: "camera.doorbell", device_id: "nest-1", platform: "nest" },
  },
  aliases: { "camera.porch_reolink": "camera.entrance" },
});

const ctx = (extra: Partial<EventReelMapContext> = {}): EventReelMapContext => ({
  cameras,
  nest: true,
  localize: getLocalize("en"),
  friendlyName: (id) => (id === "camera.garden" ? "Garden" : undefined),
  ...extra,
});

const doorbell: EventReelRecord = {
  id: "abc",
  start: "2026-10-08T13:44:55+02:00",
  end: null,
  camera: "camera.doorbell",
  title: "Child looks out of the door",
  description: "A child in a grey sweater opens the door.",
  category: "doorbell",
  labels: ["person", "chime"],
  key_frame: "media-source://media_source/local/event_reel/2026-10-08/abc.jpg",
  source: "nest",
  nest: { device_id: "nest-1", event_token: "TOKEN1" },
  analysis: "ok",
};

describe("eventReelToEvents", () => {
  it("maps a Nest doorbell event with its clip, thumbnail and key frame", () => {
    const [e] = eventReelToEvents([doorbell], ctx());
    expect(e).toMatchObject({
      id: "event_reel:abc",
      provider: "event_reel",
      sources: ["event_reel"],
      aliases: ["abc"],
      start: iso("2026-10-08T11:44:55Z"),
      end: undefined,
      title: "Child looks out of the door",
      description: "A child in a grey sweater opens the door.",
      category: "doorbell",
      camera: "camera.doorbell",
      clip: { kind: "mp4", path: "media-source://nest/nest-1/TOKEN1", resolve: true },
      labels: ["person", "chime"],
    });
    expect(e.thumbnail).toEqual([
      { kind: "image", path: "/api/nest/event_media/nest-1/TOKEN1/thumbnail" },
      {
        kind: "image",
        path: "media-source://media_source/local/event_reel/2026-10-08/abc.jpg",
        resolve: true,
      },
    ]);
  });

  it("leaves the Nest clip out when Nest is switched off", () => {
    const [e] = eventReelToEvents([doorbell], ctx({ nest: false }));
    expect(e.clip).toBeUndefined();
    expect(e.thumbnail).toHaveLength(1);
  });

  it("offers no clip for a Nest camera that only sends pictures", () => {
    const pictureOnly = {
      ...doorbell,
      nest: { device_id: "nest-1", event_token: "T", video: false },
    };
    const [e] = eventReelToEvents([pictureOnly], ctx());
    expect(e.clip).toBeUndefined();
    expect(e.thumbnail?.[0]).toEqual({
      kind: "image",
      path: "/api/nest/event_media/nest-1/T/thumbnail",
    });
  });

  it("resolves camera aliases and names unknown cameras", () => {
    const [aliased, unknown] = eventReelToEvents(
      [
        { id: "1", start: "2026-10-08T10:00:00Z", camera: "camera.porch_reolink", title: "A" },
        { id: "2", start: "2026-10-08T10:01:00Z", camera: "camera.garden", title: "B" },
      ],
      ctx(),
    );
    expect(aliased.camera).toBe("camera.entrance");
    expect(unknown.camera).toBeUndefined();
    expect(unknown.cameraLabel).toBe("Garden");
  });

  it("writes a title when the AI didn't answer", () => {
    const [ring, person] = eventReelToEvents(
      [
        { ...doorbell, id: "r", title: "", description: null, analysis: "failed" },
        {
          id: "p",
          start: "2026-10-08T10:00:00Z",
          camera: "camera.entrance",
          title: "",
          category: "person",
          labels: ["person"],
          analysis: "failed",
        },
      ],
      ctx(),
    );
    expect(ring.title).toBe("The doorbell rang at Doorbell");
    expect(ring.description).toBeUndefined();
    expect(person.title).toBe("Person at Entrance");
  });

  it("writes the fallback titles in Norwegian too", () => {
    const [ring] = eventReelToEvents(
      [{ ...doorbell, title: "" }],
      ctx({ localize: getLocalize("nb") }),
    );
    expect(ring.title).toBe("Det ringte på ved Doorbell");
  });

  it("skips events without an id or a readable start, and maps unknown categories", () => {
    const events = eventReelToEvents(
      [
        { id: "", start: "2026-10-08T10:00:00Z", title: "No id" },
        { id: "x", start: "yesterday", title: "Bad time" },
        { id: "y", start: "2026-10-08T10:00:00Z", title: "Note", category: "something" },
      ],
      ctx(),
    );
    expect(events.map((e) => e.id)).toEqual(["event_reel:y"]);
    expect(events[0].category).toBe("custom");
  });
});

describe("Event Reel provider", () => {
  it("asks for the range as ISO times", async () => {
    const callWS = vi.fn().mockResolvedValue({ events: [doorbell] });
    const hass = { callWS, states: {} } as unknown as HomeAssistant;
    const provider = createEventReelProvider();
    const config = normalizeConfig({ type: "custom:event-reel-card", max_events: 50 });
    const events = await provider.fetch(
      { start: iso("2026-10-08T00:00:00Z"), end: iso("2026-10-08T23:59:59Z") },
      { hass, config, cameras, localize: getLocalize("en"), now: iso("2026-10-09T00:00:00Z") },
    );
    expect(callWS).toHaveBeenCalledWith({
      type: "event_reel/events/list",
      start_time: "2026-10-08T00:00:00.000Z",
      end_time: "2026-10-08T23:59:59.000Z",
      limit: 500,
    });
    expect(events.map((e) => e.id)).toEqual(["event_reel:abc"]);
  });

  it("keeps the limit inside what the integration accepts", async () => {
    const limits = [];
    for (const max_events of [6000, 400.3, 10]) {
      const callWS = vi.fn().mockResolvedValue({ events: [] });
      const hass = { callWS, states: {} } as unknown as HomeAssistant;
      const config = normalizeConfig({ type: "custom:event-reel-card", max_events });
      await createEventReelProvider().fetch(
        { start: iso("2026-10-08T00:00:00Z"), end: iso("2026-10-08T23:59:59Z") },
        { hass, config, cameras, localize: getLocalize("en"), now: iso("2026-10-09T00:00:00Z") },
      );
      limits.push(callWS.mock.calls[0][0].limit);
    }
    expect(limits).toEqual([5000, 800, 500]);
  });

  it("skips an integration that isn't loaded quietly, unless it was asked for", async () => {
    const notLoaded = { code: "not_loaded", message: "Event Reel is not loaded" };
    const hass = {
      callWS: vi.fn().mockRejectedValue(notLoaded),
      states: {},
    } as unknown as HomeAssistant;
    const range = { start: iso("2026-10-08T00:00:00Z"), end: iso("2026-10-08T23:59:59Z") };
    const run = (raw: Record<string, unknown>) =>
      createEventReelProvider().fetch(range, {
        hass,
        config: normalizeConfig({ type: "custom:event-reel-card", ...raw }),
        cameras,
        localize: getLocalize("en"),
        now: iso("2026-10-09T00:00:00Z"),
      });
    await expect(run({})).resolves.toEqual([]);
    await expect(run({ event_reel: true })).rejects.toBe(notLoaded);
  });

  it("finds the newest event before a time", async () => {
    const callWS = vi.fn().mockResolvedValue({ events: [doorbell] });
    const hass = { callWS } as unknown as HomeAssistant;
    const before = iso("2026-10-09T00:00:00Z");
    expect(await latestEventReelBefore(hass, before)).toBe(iso("2026-10-08T11:44:55Z"));
    expect(callWS).toHaveBeenCalledWith({
      type: "event_reel/events/list",
      end_time: "2026-10-09T00:00:00.000Z",
      limit: 1,
    });
  });
});

describe("merging Event Reel text", () => {
  const opts = {
    before: 15,
    after: 30,
    now: iso("2026-10-08T12:00:00Z"),
    showUnmatched: true,
    hideUnconfirmed: false,
  };

  it("joins Event Reel text to a Frigate review on the same camera", () => {
    const review = ev({
      id: "frigate:frigate:r1",
      provider: "frigate",
      camera: "camera.entrance",
      start: iso("2026-10-08T10:00:00Z"),
      end: iso("2026-10-08T10:00:40Z"),
      title: "Person at Entrance",
      category: "person",
    });
    const text = ev({
      id: "event_reel:t1",
      provider: "event_reel",
      camera: "camera.entrance",
      start: iso("2026-10-08T10:00:05Z"),
      title: "Courier leaves a parcel",
      category: "package",
    });
    const [merged] = mergeEvents([review, text], opts);
    expect(merged.id).toBe("frigate:frigate:r1");
    expect(merged.title).toBe("Courier leaves a parcel");
    expect(merged.category).toBe("package");
    expect(merged.sources).toEqual(["event_reel", "frigate"]);
  });

  it("makes one row of the same Nest event described by LLM Vision and Event Reel", () => {
    const clip = { kind: "mp4" as const, path: "media-source://nest/nest-1/TOKEN1", resolve: true };
    const llm = ev({
      id: "llmvision:u1",
      provider: "llmvision",
      camera: "camera.doorbell",
      start: iso("2026-10-08T11:44:56Z"),
      title: "Child looks out",
      category: "person",
      clip,
    });
    const reel = ev({
      id: "event_reel:abc",
      provider: "event_reel",
      camera: "camera.doorbell",
      start: iso("2026-10-08T11:44:55Z"),
      title: "Child opens the door",
      description: "A child in a grey sweater.",
      category: "doorbell",
      clip,
    });
    const other = ev({
      id: "event_reel:later",
      provider: "event_reel",
      camera: "camera.doorbell",
      start: iso("2026-10-08T11:50:00Z"),
      title: "Courier rings",
      clip: { ...clip, path: "media-source://nest/nest-1/TOKEN2" },
    });

    const rows = mergeEvents([llm, reel, other], opts);

    expect(rows.map((r) => r.id)).toEqual(["event_reel:abc", "event_reel:later"]);
    const [ring] = rows;
    expect(ring.title).toBe("Child opens the door");
    expect(ring.category).toBe("doorbell");
    expect(ring.sources).toEqual(["event_reel", "llmvision"]);
    expect(ring.aliases).toContain("llmvision:u1");
    expect(ring.extra).toEqual([
      { start: iso("2026-10-08T11:44:56Z"), title: "Child looks out", description: undefined },
    ]);
  });

  it("keeps both descriptions of a ring when the row also joins a Frigate review", () => {
    // A Nest doorbell whose stream Frigate records too: one camera, three sources.
    const clip = { kind: "mp4" as const, path: "media-source://nest/nest-1/TOKEN1", resolve: true };
    const review = ev({
      id: "frigate:frigate:r9",
      provider: "frigate",
      camera: "camera.entrance",
      start: iso("2026-10-08T11:44:50Z"),
      end: iso("2026-10-08T11:45:30Z"),
      title: "Person at Entrance",
      category: "person",
    });
    const llm = ev({
      id: "llmvision:u1",
      provider: "llmvision",
      camera: "camera.entrance",
      start: iso("2026-10-08T11:44:56Z"),
      title: "Child looks out",
      clip,
    });
    const reel = ev({
      id: "event_reel:abc",
      provider: "event_reel",
      camera: "camera.entrance",
      start: iso("2026-10-08T11:44:55Z"),
      title: "Child opens the door",
      category: "doorbell",
      clip,
    });

    const [row, ...others] = mergeEvents([review, llm, reel], opts);

    expect(others).toEqual([]);
    expect(row.id).toBe("frigate:frigate:r9");
    expect(row.title).toBe("Child opens the door");
    expect(row.extra?.map((x) => x.title)).toEqual(["Child looks out"]);
    expect(row.sources).toEqual(["event_reel", "llmvision", "frigate"]);
  });
});

describe("event_reel config", () => {
  it("is on by default and can be switched off", () => {
    expect(normalizeConfig({ type: "x" }).event_reel).toEqual({ enabled: true, explicit: false });
    expect(normalizeConfig({ type: "x", event_reel: false }).event_reel).toEqual({
      enabled: false,
      explicit: true,
    });
  });

  it("round-trips through the editor toggle", () => {
    const base = { type: "custom:event-reel-card" };
    const off = formToConfig({ ...configToForm(base), event_reel_enabled: false }, base);
    expect(off.event_reel).toBe(false);
    const on = formToConfig({ ...configToForm(off), event_reel_enabled: true }, off, base);
    expect("event_reel" in on).toBe(false);
  });
});
