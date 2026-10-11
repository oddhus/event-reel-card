import { describe, expect, it, vi } from "vitest";
import { normalizeConfig } from "../src/config";
import { buildCameraRegistry } from "../src/core/cameras";
import { getLocalize } from "../src/i18n";
import {
  ActorResolver,
  applyActors,
  createEntityProvider,
  logbookToEvents,
} from "../src/providers/entity";
import type { EntityHelpers } from "../src/providers/entity";
import { parseWsResult, reviewToEvent } from "../src/providers/frigate";
import type { FrigateReview } from "../src/providers/frigate";
import { createLlmVisionProvider, llmvisionToEvents } from "../src/providers/llmvision";
import { NestTokenResolver } from "../src/providers/nest";
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
    "camera.other": state("camera.other", { friendly_name: "Other" }),
  },
  entities: {
    "camera.entrance": { entity_id: "camera.entrance", device_id: "d1", platform: "frigate" },
    "image.entrance_person": {
      entity_id: "image.entrance_person",
      device_id: "d1",
      platform: "frigate",
    },
    "camera.doorbell": { entity_id: "camera.doorbell", device_id: "nest-1", platform: "nest" },
  },
});

describe("logbookToEvents", () => {
  const helpers: EntityHelpers = {
    name: (id) =>
      ({ "lock.front_door": "Lock", "binary_sensor.front_door": "Front door" })[id] ?? id,
    stateLabel: (_id, s) => `<${s}>`,
    deviceClass: (id) => (id.startsWith("binary_sensor.") ? "door" : undefined),
    contextName: (id) => (id === "automation.night" ? "Night routine" : undefined),
  };

  it("maps state changes with categories, labels and overrides", () => {
    const events = logbookToEvents(
      [
        { when: 1000, entity_id: "lock.front_door", state: "unlocked" },
        { when: 1005, entity_id: "binary_sensor.front_door", state: "on" },
        { when: 1006, entity_id: "sensor.not_watched", state: "1" },
      ],
      [
        { entity: "lock.front_door", name: "Front door" },
        { entity: "binary_sensor.front_door", states: { on: "Opened" } },
      ],
      helpers,
    );
    expect(events.map((e) => [e.title, e.stateLabel, e.category, e.state])).toEqual([
      ["Front door", "<unlocked>", "lock", "unlocked"],
      ["Front door", "Opened", "door", "on"],
    ]);
    expect(events[0].id).toBe("entity:lock.front_door:1000.000");
  });

  it("drops unknown/unavailable transitions, repeats and filtered states", () => {
    const events = logbookToEvents(
      [
        { when: 1, entity_id: "lock.front_door", state: "locked" },
        { when: 2, entity_id: "lock.front_door", state: "unavailable" },
        { when: 3, entity_id: "lock.front_door", state: "locked" },
        { when: 4, entity_id: "lock.front_door", state: "locked" },
        { when: 5, entity_id: "lock.front_door", state: "unlocked" },
        { when: 6, entity_id: "binary_sensor.front_door", state: "on" },
        { when: 7, entity_id: "binary_sensor.front_door", state: "off" },
      ],
      [{ entity: "lock.front_door" }, { entity: "binary_sensor.front_door", only_states: ["on"] }],
      helpers,
    );
    expect(events.map((e) => `${e.entityId}=${e.state}@${e.start}`)).toEqual([
      "lock.front_door=locked@1",
      "lock.front_door=unlocked@5",
      "binary_sensor.front_door=on@6",
    ]);
  });

  it("sorts unordered input and keeps logbook.log entries", () => {
    const events = logbookToEvents(
      [
        {
          when: "1970-01-01T00:00:20Z",
          entity_id: "lock.front_door",
          name: "Mail",
          message: "arrived",
        },
        {
          when: 10,
          entity_id: "lock.front_door",
          state: "locked",
          context_entity_id: "automation.night",
        },
      ],
      [{ entity: "lock.front_door" }],
      helpers,
    );
    expect(events.map((e) => [e.start, e.title, e.stateLabel, e.actor])).toEqual([
      [10, "Lock", "<locked>", "Night routine"],
      [20, "Mail", "arrived", undefined],
    ]);
  });
});

describe("applyActors", () => {
  it("takes the attribute from the matching history row, including a late attribute update", () => {
    const events = logbookToEvents(
      [
        { when: 100, entity_id: "lock.front_door", state: "unlocked" },
        { when: 200, entity_id: "lock.front_door", state: "locked" },
      ],
      [{ entity: "lock.front_door", actor_attribute: "changed_by" }],
      {
        name: (id) => id,
        stateLabel: (_i, s) => s,
        deviceClass: () => undefined,
        contextName: () => undefined,
      },
    );
    applyActors(
      events,
      {
        "lock.front_door": [
          { s: "locked", a: { changed_by: "Keypad" }, lu: 50 },
          { s: "unlocked", a: { changed_by: null }, lu: 100 },
          { s: "unlocked", a: { changed_by: "Keypad 2" }, lu: 101.5 },
          { s: "locked", a: { changed_by: "One-touch" }, lu: 200 },
        ],
      },
      () => "changed_by",
    );
    expect(events.map((e) => e.actor)).toEqual(["Keypad 2", "One-touch"]);
  });

  it("doesn't give a change the actor of the next change of a bouncing lock", () => {
    const events = logbookToEvents(
      [
        { when: 100, entity_id: "lock.front_door", state: "unlocked" },
        { when: 101, entity_id: "lock.front_door", state: "locked" },
        { when: 102, entity_id: "lock.front_door", state: "unlocked" },
      ],
      [{ entity: "lock.front_door", actor_attribute: "changed_by" }],
      {
        name: (id) => id,
        stateLabel: (_i, s) => s,
        deviceClass: () => undefined,
        contextName: () => undefined,
      },
    );
    applyActors(
      events,
      {
        "lock.front_door": [
          { s: "unlocked", a: { changed_by: "Alex" }, lu: 100 },
          { s: "locked", a: { changed_by: "Keypad" }, lu: 101 },
          { s: "unlocked", a: { changed_by: null }, lu: 102 },
          { s: "unlocked", a: { changed_by: "Sam" }, lu: 103 },
        ],
      },
      () => "changed_by",
    );
    expect(events.map((e) => e.actor)).toEqual(["Alex", "Keypad", "Sam"]);
  });
});

describe("ActorResolver", () => {
  const change = (start: number, state = "unlocked") =>
    ev({
      id: `entity:lock.front_door:${start}`,
      start,
      state,
      entityId: "lock.front_door",
      category: "lock",
      title: "Front door",
    });
  const changedBy = () => "changed_by";
  type Msg = { start_time: string; end_time: string; entity_ids: string[] };

  it("looks up only changes it hasn't seen, in the history around them", async () => {
    const callWS = vi.fn(async (_msg: Msg) => ({
      "lock.front_door": [
        { s: "unlocked", a: { changed_by: "Alex" }, lu: 100 },
        { s: "locked", a: { changed_by: "Sam" }, lu: 5000 },
      ],
    }));
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => 10_000);

    const first = [change(100)];
    await resolver.fill(hass, first, changedBy);
    expect(first[0].actor).toBe("Alex");
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0][0]).toMatchObject({
      start_time: "1970-01-01T00:01:38.000Z",
      end_time: "1970-01-01T00:01:45.000Z",
      entity_ids: ["lock.front_door"],
    });

    const second = [change(100), change(5000, "locked")];
    await resolver.fill(hass, second, changedBy);
    expect(second.map((e) => e.actor)).toEqual(["Alex", "Sam"]);
    expect(callWS).toHaveBeenCalledTimes(2);
    expect(callWS.mock.calls[1][0]).toMatchObject({
      start_time: "1970-01-01T01:23:18.000Z",
      end_time: "1970-01-01T01:23:25.000Z",
    });

    await resolver.fill(hass, [change(100), change(5000, "locked")], changedBy);
    expect(callWS).toHaveBeenCalledTimes(2);
  });

  it("asks again for a recent change without an actor, but not for an old one", async () => {
    let rows: { s: string; a: { changed_by: string | null }; lu: number }[] = [
      { s: "locked", a: { changed_by: null }, lu: 500 },
      { s: "unlocked", a: { changed_by: null }, lu: 990 },
    ];
    const callWS = vi.fn(async (_msg: Msg) => ({ "lock.front_door": rows }));
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => 1000);

    const first = [change(500, "locked"), change(990)];
    await resolver.fill(hass, first, changedBy);
    expect(first.map((e) => e.actor)).toEqual([undefined, undefined]);

    // The attribute update for the change 10 s ago reached the recorder after the change.
    rows = [
      { s: "locked", a: { changed_by: null }, lu: 500 },
      { s: "unlocked", a: { changed_by: null }, lu: 990 },
      { s: "unlocked", a: { changed_by: "Alex" }, lu: 991 },
    ];
    const second = [change(500, "locked"), change(990)];
    await resolver.fill(hass, second, changedBy);
    expect(second.map((e) => e.actor)).toEqual([undefined, "Alex"]);
    expect(callWS).toHaveBeenCalledTimes(2);
    expect(callWS.mock.calls[1][0]).toMatchObject({
      start_time: "1970-01-01T00:16:28.000Z",
      end_time: "1970-01-01T00:16:35.000Z",
    });
  });

  it("waits for a hanging lookup only until it is stale, then asks again", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const rows = { "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex" }, lu: 100 }] };
      const callWS = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue(rows);
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new ActorResolver(() => now);

      const first = [change(100)];
      const p1 = resolver.fill(hass, first, changedBy, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await p1;
      expect(first[0].actor).toBeUndefined();

      now += 10; // the first lookup may still answer: don't send another yet
      const p2 = resolver.fill(hass, [change(100)], changedBy, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await p2;
      expect(callWS).toHaveBeenCalledTimes(1);

      now += 30;
      const third = [change(100)];
      await resolver.fill(hass, third, changedBy, 3000);
      expect(callWS).toHaveBeenCalledTimes(2);
      expect(third[0].actor).toBe("Alex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't let a stale lookup that answers late erase a newer actor", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      let answerOld!: (v: unknown) => void;
      const callWS = vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (answerOld = r)))
        .mockResolvedValue({
          "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex" }, lu: 100 }],
        });
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new ActorResolver(() => now);

      const p1 = resolver.fill(hass, [change(100)], changedBy, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await p1;
      now += 31;
      const second = [change(100)];
      await resolver.fill(hass, second, changedBy, 3000);
      expect(second[0].actor).toBe("Alex");

      answerOld({ "lock.front_door": [{ s: "unlocked", a: { changed_by: null }, lu: 100 }] });
      await vi.advanceTimersByTimeAsync(0);
      const third = [change(100)];
      await resolver.fill(hass, third, changedBy, 3000);
      expect(third[0].actor).toBe("Alex");
      expect(callWS).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again when the history was read before the change had settled", async () => {
    let now = 101;
    let answer!: (v: unknown) => void;
    const callWS = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (answer = r)))
      .mockResolvedValue({
        "lock.front_door": [
          { s: "unlocked", a: { changed_by: null }, lu: 100 },
          { s: "unlocked", a: { changed_by: "Alex" }, lu: 103 },
        ],
      });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => now);

    const first = resolver.fill(hass, [change(100)], changedBy);
    // Read at 101, before the attribute update at 103; the answer arrives much later.
    now = 140;
    answer({ "lock.front_door": [{ s: "unlocked", a: { changed_by: null }, lu: 100 }] });
    await first;
    const second = [change(100)];
    await resolver.fill(hass, second, changedBy);
    expect(second[0].actor).toBe("Alex");
    expect(callWS).toHaveBeenCalledTimes(2);
  });

  it("corrects an actor read before the attribute caught up", async () => {
    let now = 1000;
    const callWS = vi
      .fn()
      .mockResolvedValueOnce({
        // The new state still carries the previous change's attribute.
        "lock.front_door": [{ s: "unlocked", a: { changed_by: "Keypad" }, lu: 995 }],
      })
      .mockResolvedValue({
        "lock.front_door": [
          { s: "unlocked", a: { changed_by: "Keypad" }, lu: 995 },
          { s: "unlocked", a: { changed_by: "Alex" }, lu: 996 },
        ],
      });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => now);

    const first = [change(995)];
    await resolver.fill(hass, first, changedBy);
    expect(first[0].actor).toBe("Keypad");
    now = 1060;
    const second = [change(995)];
    await resolver.fill(hass, second, changedBy);
    expect(second[0].actor).toBe("Alex");
    now = 1120;
    await resolver.fill(hass, [change(995)], changedBy);
    expect(callWS).toHaveBeenCalledTimes(2); // read after it settled: final
  });

  it("keeps the logbook's actor when the attribute names nobody, without caching it as the attribute", async () => {
    let now = 1000;
    const callWS = vi
      .fn()
      .mockResolvedValueOnce({
        "lock.front_door": [{ s: "unlocked", a: { changed_by: null }, lu: 990 }],
      })
      .mockResolvedValue({
        "lock.front_door": [
          { s: "unlocked", a: { changed_by: null }, lu: 990 },
          { s: "unlocked", a: { changed_by: "Alex" }, lu: 991 },
        ],
      });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => now);
    const byAutomation = () => ({ ...change(990), actor: "Night routine" });

    const first = [byAutomation()];
    await resolver.fill(hass, first, changedBy);
    expect(first[0].actor).toBe("Night routine");
    now = 1060;
    const second = [byAutomation()];
    await resolver.fill(hass, second, changedBy);
    expect(second[0].actor).toBe("Alex");
  });

  it("doesn't wait for a lookup made for a range that is no longer shown", async () => {
    vi.useFakeTimers();
    try {
      const callWS = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue({
          "lock.front_door": [
            { s: "unlocked", a: { changed_by: "Alex" }, lu: 100 },
            { s: "locked", a: { changed_by: "Sam" }, lu: 90_000 },
          ],
        });
      const hass = { callWS } as unknown as HomeAssistant;
      const resolver = new ActorResolver(() => 100_000);

      const today = resolver.fill(hass, [change(100)], changedBy, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await today;
      const otherDay = [change(90_000, "locked")];
      await resolver.fill(hass, otherDay, changedBy, 3000);
      expect(otherDay[0].actor).toBe("Sam");
      // Back to the first range within seconds: ask again instead of waiting for the hang.
      const back = [change(100)];
      await resolver.fill(hass, back, changedBy, 3000);
      expect(back[0].actor).toBe("Alex");
      expect(callWS).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up again when the actor attribute changes", async () => {
    const callWS = vi.fn(async (_msg: Msg) => ({
      "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex", method: "Keypad" }, lu: 100 }],
    }));
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => 10_000);

    const first = [change(100)];
    await resolver.fill(hass, first, changedBy);
    const second = [change(100)];
    await resolver.fill(hass, second, () => "method");
    expect([first[0].actor, second[0].actor]).toEqual(["Alex", "Keypad"]);
    expect(callWS).toHaveBeenCalledTimes(2);
  });

  it("tries a failed lookup again on the next fill", async () => {
    const callWS = vi
      .fn()
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValue({
        "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex" }, lu: 100 }],
      });
    const hass = { callWS } as unknown as HomeAssistant;
    const resolver = new ActorResolver(() => 10_000);

    const first = [change(100)];
    await resolver.fill(hass, first, changedBy);
    expect(first[0].actor).toBeUndefined();
    const second = [change(100)];
    await resolver.fill(hass, second, changedBy);
    expect(second[0].actor).toBe("Alex");
  });
});

describe("Entity fetch", () => {
  const when = iso("2026-10-08T14:16:26+02:00");
  const range = { start: iso("2026-10-08T00:00:00+02:00"), end: iso("2026-10-09T00:00:00+02:00") };
  const ctxFor = (callWS: (msg: Record<string, unknown>) => Promise<unknown>) => ({
    hass: { config: { time_zone: "Europe/Oslo" }, states: {}, callWS } as never,
    config: normalizeConfig({
      type: "x",
      entities: [{ entity: "lock.front_door", name: "Front door", actor_attribute: "changed_by" }],
    }),
    cameras,
    localize: getLocalize("en"),
    now: iso("2026-10-08T15:00:00+02:00"),
  });

  it("returns its rows without waiting for an actor lookup that hangs", async () => {
    vi.useFakeTimers();
    try {
      const ctx = ctxFor(
        async (msg) =>
          msg.type === "logbook/get_events"
            ? [{ when, entity_id: "lock.front_door", state: "unlocked" }]
            : new Promise(() => undefined), // history/history_during_period never answers
      );
      const events = createEntityProvider(new ActorResolver()).fetch(range, ctx);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await events).map((e) => [e.title, e.state, e.actor])).toEqual([
        ["Front door", "unlocked", undefined],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a refetch when a slow actor lookup answers, and then shows the actor", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const history = vi.fn(async () => {
        await gate;
        return { "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex" }, lu: when }] };
      });
      const ctx = ctxFor(async (msg) =>
        msg.type === "logbook/get_events"
          ? [{ when, entity_id: "lock.front_door", state: "unlocked" }]
          : history(),
      );
      const provider = createEntityProvider(new ActorResolver());
      const refetch = vi.fn();
      const unsubscribe = provider.subscribe!(ctx, refetch);

      const first = provider.fetch(range, ctx);
      await vi.advanceTimersByTimeAsync(3000);
      const [shown] = await first;
      expect(shown.actor).toBeUndefined();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(shown.actor).toBeUndefined(); // rows already returned stay as they were

      const [again] = await provider.fetch(range, ctx);
      expect(again.actor).toBe("Alex");
      expect(history).toHaveBeenCalledTimes(1);
      expect(refetch).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't ask for a refetch when the actor lookup answers in time", async () => {
    vi.useFakeTimers();
    try {
      const ctx = ctxFor(async (msg) =>
        msg.type === "logbook/get_events"
          ? [{ when, entity_id: "lock.front_door", state: "unlocked" }]
          : { "lock.front_door": [{ s: "unlocked", a: { changed_by: "Alex" }, lu: when }] },
      );
      const provider = createEntityProvider(new ActorResolver());
      const refetch = vi.fn();
      const unsubscribe = provider.subscribe!(ctx, refetch);
      const [row] = await provider.fetch(range, ctx);
      await vi.advanceTimersByTimeAsync(5000);
      expect(row.actor).toBe("Alex");
      expect(refetch).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("llmvisionToEvents", () => {
  const token = btoa(JSON.stringify(["1700000000", "1234567890"]));
  const ctx = {
    cameras,
    nestDevices: new Map([[token, "nest-1"]]),
    nonCamera: true,
    friendlyName: (id: string) => (id === "camera.unknown" ? "Unknown cam" : undefined),
  };
  const base = { start: "2026-10-08T14:16:26.866834+02:00", title: "T", description: "D" };

  it("maps camera events through the registry and keeps the key frame", () => {
    const [e] = llmvisionToEvents(
      [
        {
          ...base,
          uid: "a",
          camera_name: "image.entrance_person",
          key_frame: "/media/llmvision/snapshots/x.jpg",
          category: "person",
        },
      ],
      ctx,
    );
    expect(e).toMatchObject({
      id: "llmvision:a",
      camera: "camera.entrance",
      category: "person",
      start: Date.parse(base.start) / 1000,
      thumbnail: [
        {
          kind: "image",
          path: "media-source://media_source/local/llmvision/snapshots/x.jpg",
          resolve: true,
        },
      ],
    });
  });

  it("joins doorbell events to the Nest clip by token", () => {
    const [e] = llmvisionToEvents(
      [{ ...base, uid: "b", camera_name: token, key_frame: "/media/llmvision/snapshots/y.jpg" }],
      ctx,
    );
    expect(e.camera).toBe("camera.doorbell");
    expect(e.category).toBe("doorbell");
    expect(e.clip).toEqual({
      kind: "mp4",
      path: `media-source://nest/nest-1/${token}`,
      resolve: true,
    });
    expect(e.thumbnail?.[0].path).toBe(
      `/api/nest/event_media/nest-1/${encodeURIComponent(token)}/thumbnail`,
    );
  });

  it("keeps unmapped cameras as image-only rows with a label", () => {
    const [e] = llmvisionToEvents([{ ...base, uid: "c", camera_name: "camera.unknown" }], ctx);
    expect(e.camera).toBeUndefined();
    expect(e.cameraLabel).toBe("Unknown cam");
    expect(e.category).toBe("motion");
  });

  it("drops non-camera events when non_camera is false", () => {
    const raw = [{ ...base, uid: "d", camera_name: "", label: "lock" }];
    expect(llmvisionToEvents(raw, ctx)[0].category).toBe("lock");
    expect(llmvisionToEvents(raw, { ...ctx, nonCamera: false })).toEqual([]);
  });
});

describe("LLM Vision fetch", () => {
  it("returns its events without waiting for a Nest lookup that hangs", async () => {
    vi.useFakeTimers();
    try {
      const token = btoa(JSON.stringify(["1700000000", "1234567890"]));
      const start = "2026-10-08T14:16:26+02:00";
      const hass = {
        config: { time_zone: "Europe/Oslo" },
        states: {},
        callWS: async (msg: Record<string, unknown>) =>
          msg.type === "call_service"
            ? {
                response: {
                  events: [
                    { uid: "door", start, title: "At the door", camera_name: token },
                    { uid: "cam", start, title: "On the steps", camera_name: "camera.entrance" },
                  ],
                },
              }
            : new Promise(() => undefined), // media_source/browse_media never answers
      };
      const events = createLlmVisionProvider(new NestTokenResolver()).fetch(
        { start: iso("2026-10-08T00:00:00+02:00"), end: iso("2026-10-09T00:00:00+02:00") },
        {
          hass: hass as never,
          config: normalizeConfig({ type: "x" }),
          cameras,
          localize: getLocalize("en"),
          now: iso("2026-10-08T15:00:00+02:00"),
        },
      );
      await vi.advanceTimersByTimeAsync(3000);
      const byId = new Map((await events).map((e) => [e.id, e]));
      expect([...byId.keys()].sort()).toEqual(["llmvision:cam", "llmvision:door"]);
      expect(byId.get("llmvision:cam")?.camera).toBe("camera.entrance");
      // The doorbell row shows, still without its clip.
      expect(byId.get("llmvision:door")).toMatchObject({ category: "doorbell", clip: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a refetch when a slow Nest lookup answers, and then joins the clip", async () => {
    vi.useFakeTimers();
    try {
      const token = btoa(JSON.stringify(["1700000000", "1234567890"]));
      const start = "2026-10-08T14:16:26+02:00";
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hass = {
        config: { time_zone: "Europe/Oslo" },
        states: {},
        callWS: async (msg: Record<string, unknown>) => {
          if (msg.type === "call_service") {
            return { response: { events: [{ uid: "door", start, camera_name: token }] } };
          }
          await gate;
          return msg.media_content_id === "media-source://nest"
            ? { children: [{ media_content_id: "media-source://nest/nest-1" }] }
            : { children: [{ media_content_id: `media-source://nest/nest-1/${token}` }] };
        },
      };
      const ctx = {
        hass: hass as never,
        config: normalizeConfig({ type: "x" }),
        cameras,
        localize: getLocalize("en"),
        now: iso("2026-10-08T15:00:00+02:00"),
      };
      const range = {
        start: iso("2026-10-08T00:00:00+02:00"),
        end: iso("2026-10-09T00:00:00+02:00"),
      };
      const provider = createLlmVisionProvider(new NestTokenResolver());
      const refetch = vi.fn();
      const unsubscribe = provider.subscribe!(ctx, refetch);

      const first = provider.fetch(range, ctx);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await first)[0].clip).toBeUndefined();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(refetch).toHaveBeenCalledTimes(1);

      const [again] = await provider.fetch(range, ctx);
      expect(again.camera).toBe("camera.doorbell");
      expect(again.clip?.path).toBe(`media-source://nest/nest-1/${token}`);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Frigate reviews", () => {
  const review: FrigateReview = {
    id: "1791450000.123456-abc123",
    camera: "entrance",
    start_time: 1791450000.12,
    end_time: 1791450049.35,
    severity: "alert",
    thumb_path: "/media/frigate/clips/review/thumb-entrance-1791450000.123456-abc123.webp",
    has_been_reviewed: false,
    data: { objects: ["person", "person-verified"], sub_labels: [["Alex", 0.9]], metadata: null },
  };

  it("parses JSON-string results", () => {
    expect(parseWsResult(JSON.stringify([review]))).toEqual([review]);
    expect(parseWsResult([review])).toEqual([review]);
  });

  it("maps a review with media refs and a localized title", () => {
    const e = reviewToEvent(review, "frigate", { cameras, localize: getLocalize("nb") });
    expect(e).toMatchObject({
      id: "frigate:frigate:1791450000.123456-abc123",
      camera: "camera.entrance",
      title: "Person ved Entrance",
      category: "person",
      labels: ["person"],
      people: ["Alex"],
      severity: "alert",
      reviewed: false,
      frigate: { instance: "frigate", camera: "entrance", reviewId: review.id },
    });
    expect(e.thumbnail?.[0].path).toBe(
      "/api/frigate/frigate/clips/review/thumb-entrance-1791450000.123456-abc123.webp",
    );
    expect(e.preview?.[0].path).toBe(
      "/api/frigate/frigate/notifications/1791450000.123456-abc123/review_preview.gif?format=mp4",
    );
  });

  it("prefers the GenAI title and treats null end as ongoing", () => {
    const e = reviewToEvent(
      { ...review, end_time: null, data: { objects: ["car"], metadata: { title: "Car arrives" } } },
      "frigate",
      { cameras, localize: getLocalize("en") },
    );
    expect(e.title).toBe("Car arrives");
    expect(e.end).toBeUndefined();
    expect(e.category).toBe("vehicle");
  });
});

describe("Frigate fetch", () => {
  it("merges reviewed and unreviewed items (works on old and new Frigate)", async () => {
    const base = { camera: "entrance", severity: "alert", data: { objects: ["person"] } };
    const calls: Record<string, unknown>[] = [];
    const hass = {
      callWS: async (msg: Record<string, unknown>) => {
        calls.push(msg);
        return JSON.stringify(
          msg.reviewed
            ? [{ ...base, id: "b", start_time: 20, end_time: 30, has_been_reviewed: true }]
            : [{ ...base, id: "a", start_time: 10, end_time: 15, has_been_reviewed: false }],
        );
      },
    };
    const { frigateProvider } = await import("../src/providers/frigate");
    const { normalizeConfig } = await import("../src/config");
    const events = await frigateProvider.fetch(
      { start: 0, end: 100 },
      {
        hass: hass as never,
        config: normalizeConfig({ type: "x" }),
        cameras,
        localize: getLocalize("en"),
        now: 100,
      },
    );
    expect(calls.map((c) => c.reviewed)).toEqual([false, true]);
    expect(events.map((e) => [e.id, e.reviewed])).toEqual([
      ["frigate:frigate:b", true],
      ["frigate:frigate:a", false],
    ]);
  });
});
