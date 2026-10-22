import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config";
import {
  bandAt,
  bandColor,
  bandCounts,
  contextBands,
  mergeTransitions,
  contextIntervals,
  historyTransitions,
  inAnyBand,
} from "../src/core/context";
import type { ContextBand, Transition } from "../src/core/context";
import { applyFilters } from "../src/core/filters";
import { groupTimeline } from "../src/core/grouping";
import type { TimelineItem } from "../src/core/grouping";
import { stripModel } from "../src/core/strip";
import { configToForm, formToConfig } from "../src/editor-model";
import { ev } from "./helpers";

const T0 = 1_800_000_000; // range start
const H = 3600;
const range = { start: T0, end: T0 + 24 * H };
const after = T0 + 30 * H; // "now", past the range
const tr = (state: string, at: number): Transition => ({ state, at });

describe("context config", () => {
  const ctx = (context: unknown) =>
    normalizeConfig({ type: "custom:event-reel-card", context } as never).context;

  it("is empty when left out", () => {
    expect(ctx(undefined)).toEqual([]);
  });

  it("reads a bare entity id as the state on", () => {
    expect(ctx(["input_boolean.away"])).toEqual([{ entity: "input_boolean.away", states: ["on"] }]);
  });

  it("reads a state, a list of states, a label and a color", () => {
    expect(
      ctx([
        { entity: "sun.sun", state: "below_horizon", label: "Dark", color: "amber" },
        { entity: "alarm_control_panel.home", state: ["armed_away", "armed_vacation"] },
      ]),
    ).toEqual([
      { entity: "sun.sun", states: ["below_horizon"], label: "Dark", color: "amber" },
      {
        entity: "alarm_control_panel.home",
        states: ["armed_away", "armed_vacation"],
        label: undefined,
        color: undefined,
      },
    ]);
  });

  it("rejects a non-list, an item without an entity, and more than four", () => {
    expect(() => ctx("input_boolean.away")).toThrow(/must be a list/);
    expect(() => ctx([{ state: "on" }])).toThrow(/needs an entity id/);
    expect(() => ctx(["a.a", "b.b", "c.c", "d.d", "e.e"])).toThrow(/at most 4/);
  });
});

describe("historyTransitions", () => {
  it("uses last_changed when given, else last_updated, oldest first", () => {
    expect(
      historyTransitions([
        { s: "off", lu: 300 },
        { s: "on", lu: 250, lc: 200 },
      ]),
    ).toEqual([tr("on", 200), tr("off", 300)]);
  });
});

describe("contextIntervals", () => {
  const on = ["on"];

  it("starts at the range start when the state was already on there", () => {
    const rows = [tr("on", T0), tr("off", T0 + 2 * H)];
    expect(contextIntervals(rows, on, range, after)).toEqual([{ start: T0, end: T0 + 2 * H }]);
  });

  it("clips an interval that began before the range", () => {
    const rows = [tr("on", T0 - 5 * H), tr("off", T0 + H)];
    expect(contextIntervals(rows, on, range, after)).toEqual([{ start: T0, end: T0 + H }]);
  });

  it("finds several intervals and ignores other states", () => {
    const rows = [
      tr("off", T0),
      tr("on", T0 + H),
      tr("off", T0 + 2 * H),
      tr("on", T0 + 5 * H),
      tr("off", T0 + 6 * H),
    ];
    expect(contextIntervals(rows, on, range, after)).toEqual([
      { start: T0 + H, end: T0 + 2 * H },
      { start: T0 + 5 * H, end: T0 + 6 * H },
    ]);
  });

  it("keeps an interval open while the state lasts at now", () => {
    const now = T0 + 10 * H;
    const rows = [tr("off", T0), tr("on", T0 + 8 * H)];
    expect(contextIntervals(rows, on, range, now)).toEqual([
      { start: T0 + 8 * H, end: now, open: true },
    ]);
  });

  it("ends a past day's interval at the end of the range, closed", () => {
    const rows = [tr("on", T0 + 20 * H)];
    expect(contextIntervals(rows, on, range, after)).toEqual([
      { start: T0 + 20 * H, end: T0 + 24 * H },
    ]);
  });

  it("doesn't split an interval when the entity is unavailable for a while", () => {
    const rows = [
      tr("on", T0 + H),
      tr("unavailable", T0 + 2 * H),
      tr("on", T0 + 2 * H + 30),
      tr("off", T0 + 3 * H),
    ];
    expect(contextIntervals(rows, on, range, after)).toEqual([{ start: T0 + H, end: T0 + 3 * H }]);
  });

  it("doesn't start an interval from unknown, or end one there", () => {
    const rows = [
      tr("unknown", T0),
      tr("off", T0 + H),
      tr("on", T0 + 2 * H),
      tr("unknown", T0 + 3 * H),
    ];
    expect(contextIntervals(rows, on, range, after)).toEqual([
      { start: T0 + 2 * H, end: T0 + 24 * H },
    ]);
  });

  it("bridges a gap of 4 minutes but not one of 6", () => {
    const rows = (gap: number) => [
      tr("on", T0 + H),
      tr("off", T0 + 2 * H),
      tr("on", T0 + 2 * H + gap),
      tr("off", T0 + 3 * H),
    ];
    expect(contextIntervals(rows(4 * 60), on, range, after)).toEqual([
      { start: T0 + H, end: T0 + 3 * H },
    ]);
    expect(contextIntervals(rows(6 * 60), on, range, after)).toHaveLength(2);
  });

  it("drops a closed interval under a minute in the middle of the range", () => {
    const rows = [
      tr("on", T0 + H),
      tr("off", T0 + H + 40),
      tr("on", T0 + 5 * H),
      tr("off", T0 + 6 * H),
    ];
    expect(contextIntervals(rows, on, range, after)).toEqual([
      { start: T0 + 5 * H, end: T0 + 6 * H },
    ]);
  });

  it("keeps a short interval that just began (it is still open)", () => {
    const now = T0 + 5 * H + 20;
    const rows = [tr("off", T0), tr("on", T0 + 5 * H)];
    expect(contextIntervals(rows, on, range, now)).toEqual([
      { start: T0 + 5 * H, end: now, open: true },
    ]);
  });

  it("matches any of several states", () => {
    const rows = [
      tr("disarmed", T0),
      tr("armed_away", T0 + H),
      tr("armed_vacation", T0 + 2 * H),
      tr("disarmed", T0 + 3 * H),
    ];
    expect(contextIntervals(rows, ["armed_away", "armed_vacation"], range, after)).toEqual([
      { start: T0 + H, end: T0 + 3 * H },
    ]);
  });

  it("is empty without history", () => {
    expect(contextIntervals([], on, range, after)).toEqual([]);
  });
});

describe("bandColor", () => {
  it("maps HA color names to theme variables with HA's defaults", () => {
    expect(bandColor("red", 0)).toBe("var(--red-color, #f44336)");
    expect(bandColor("Deep Purple", 0)).toBe("var(--deep-purple-color, #6e41ab)");
  });

  it("passes any other CSS color through", () => {
    expect(bandColor("#123456", 0)).toBe("#123456");
    expect(bandColor("rgb(1, 2, 3)", 0)).toBe("rgb(1, 2, 3)");
  });

  it("picks indigo, amber, teal and pink in order by default", () => {
    expect([0, 1, 2, 3].map((i) => bandColor(undefined, i))).toEqual([
      "var(--indigo-color, #3f51b5)",
      "var(--amber-color, #ffc107)",
      "var(--teal-color, #009688)",
      "var(--pink-color, #e91e63)",
    ]);
  });
});

describe("bands on rows", () => {
  const away: ContextBand = {
    key: "0",
    entity: "input_boolean.away",
    label: "Away",
    color: "blue",
    intervals: [{ start: T0 + H, end: T0 + 3 * H }],
  };
  const night: ContextBand = {
    key: "1",
    entity: "sun.sun",
    label: "Dark",
    color: "amber",
    intervals: [{ start: T0 + 2 * H, end: T0 + 2 * H + 60, open: true }],
  };

  it("covers from the start, inclusive, to the end, exclusive", () => {
    expect(bandAt([away], T0 + H)?.label).toBe("Away");
    expect(bandAt([away], T0 + 3 * H)).toBeUndefined();
    expect(bandAt([away], T0 + H - 1)).toBeUndefined();
  });

  it("lets the first band in config order win where they overlap", () => {
    expect(bandAt([away, night], T0 + 2.5 * H)?.label).toBe("Away");
    expect(bandAt([night, away], T0 + 2.5 * H)?.label).toBe("Dark");
  });

  it("takes a band when any of a row's times is inside it", () => {
    // A door burst that started while away and ended after coming home.
    expect(bandAt([away], [T0 + 2.9 * H, T0 + 3.1 * H])?.label).toBe("Away");
    expect(bandAt([away], [T0 + 3.1 * H, T0 + 4 * H])).toBeUndefined();
  });

  it("treats an open band as covering everything after its start", () => {
    expect(bandAt([night], T0 + 9 * H)?.label).toBe("Dark");
  });

  const cam = (id: string, start: number, category: "person" | "vehicle" = "person") =>
    ev({ id, provider: "frigate", start, end: start + 20, camera: "camera.drive", category });
  // One camera group from just before the away band to inside it.
  const items: TimelineItem[] = groupTimeline(
    [
      cam("frigate:1", T0 + H - 60),
      cam("frigate:2", T0 + H + 30, "vehicle"),
      cam("frigate:3", T0 + H + 90),
      ev({
        id: "entity:late",
        start: T0 + 5 * H,
        title: "Hall",
        stateLabel: "On",
        category: "custom",
      }),
    ],
    { window: 120 },
  );

  it("counts rows with an event inside each band", () => {
    expect(bandCounts(items, [away, night])).toEqual(
      new Map([
        ["0", 1],
        ["1", 1],
      ]),
    );
  });

  it("narrows a camera group to the events inside the picked band", () => {
    const out = applyFilters(items, { categories: new Set() }, inAnyBand([away]));
    expect(out).toHaveLength(1);
    const group = out[0];
    expect(group.kind === "camera" && group.events.map((e) => e.id)).toEqual([
      "frigate:2",
      "frigate:3",
    ]);
    expect([group.start, group.sortTime]).toEqual([T0 + H + 30, T0 + H + 90]);
  });

  it("needs the band and a category chip to hold for the same event", () => {
    const out = applyFilters(items, { categories: new Set(["vehicle"]) }, inAnyBand([away]));
    expect(out.map((i) => i.id)).toEqual(["frigate:2"]);
    expect(out[0].kind).toBe("event");
  });

  it("keeps the rows of either picked band", () => {
    const out = applyFilters(items, { categories: new Set() }, inAnyBand([away, night]));
    expect(out.map((i) => i.sortTime)).toEqual([T0 + 5 * H, T0 + H + 90]);
  });
});

describe("strip bands", () => {
  it("places each interval with its lane, and runs an open one to the end", () => {
    const bands: ContextBand[] = [
      {
        key: "0",
        entity: "a",
        label: "A",
        color: "red",
        intervals: [{ start: T0 + 6 * H, end: T0 + 12 * H }],
      },
      {
        key: "1",
        entity: "b",
        label: "B",
        color: "blue",
        intervals: [{ start: T0 + 18 * H, end: T0 + 20 * H, open: true }],
      },
    ];
    expect(stripModel([], range, "UTC", 6, bands).bands).toEqual([
      { lane: 0, pos: 0.25, width: 0.25, color: "red" },
      { lane: 1, pos: 0.75, width: 0.25, color: "blue" },
    ]);
  });
});

describe("visual editor", () => {
  it("keeps the YAML-only context bands when a field changes", () => {
    const config = {
      type: "custom:event-reel-card",
      context: [{ entity: "sun.sun", state: "below_horizon", label: "Dark" }],
    };
    const out = formToConfig({ ...configToForm(config), title: "Yard" }, config);
    expect(out.title).toBe("Yard");
    expect(out.context).toEqual([{ entity: "sun.sun", state: "below_horizon", label: "Dark" }]);
  });
});

describe("review fixes", () => {
  const ctx = (context: unknown) =>
    normalizeConfig({ type: "custom:event-reel-card", context } as never).context;

  it("rejects a malformed entity id, which would fail the history of every band", () => {
    expect(() => ctx(["away_mode"])).toThrow(/needs an entity id/);
    expect(() => ctx([{ entity: "" }])).toThrow(/needs an entity id/);
    expect(() => ctx([{ entity: "Input_Boolean.Away" }])).toThrow(/needs an entity id/);
  });

  it("keys two bands on one entity apart, with their own counts", () => {
    const alarm = (state: string, from: number, to: number) => [
      tr("disarmed", T0),
      tr(state, T0 + from * H),
      tr("disarmed", T0 + to * H),
    ];
    const history = new Map([
      ["alarm_control_panel.home", [...alarm("armed_away", 1, 2), ...alarm("armed_night", 5, 6)]],
    ]);
    const bands = contextBands(
      ctx([
        { entity: "alarm_control_panel.home", state: "armed_away", label: "Away" },
        { entity: "alarm_control_panel.home", state: "armed_night", label: "Night" },
      ]),
      history,
      range,
      after,
      (id) => id,
    );
    expect(bands.map((b) => [b.key, b.label, b.intervals])).toEqual([
      ["0", "Away", [{ start: T0 + H, end: T0 + 2 * H }]],
      ["1", "Night", [{ start: T0 + 5 * H, end: T0 + 6 * H }]],
    ]);
    const items = groupTimeline(
      [
        ev({ id: "a", start: T0 + 1.5 * H, title: "Hall", category: "custom" }),
        ev({ id: "b", start: T0 + 5.2 * H, title: "Hall", category: "custom" }),
        ev({ id: "c", start: T0 + 5.8 * H, title: "Stairs", category: "custom" }),
      ],
      { window: 60 },
    );
    expect(bandCounts(items, bands)).toEqual(
      new Map([
        ["0", 1],
        ["1", 2],
      ]),
    );
  });

  it("falls back to the default color for a value that isn't a color", () => {
    expect(bandColor("red;position:fixed", 1)).toBe("var(--amber-color, #ffc107)");
    expect(bandColor('blue" onclick="x', 0)).toBe("var(--indigo-color, #3f51b5)");
    expect(bandColor("not a color", 2)).toBe("var(--teal-color, #009688)");
  });

  it("knows HA's other theme color names", () => {
    expect(bandColor("primary", 0)).toBe("var(--primary-color, #03a9f4)");
    expect(bandColor("dark_grey", 0)).toBe("var(--dark-grey-color, #606060)");
  });

  it("reads a real start-time row: the state at the range start, at the start", () => {
    // As HA answered on the reference install: one row, lu = the requested start, no lc.
    const rows = [{ s: "off", a: {}, lu: T0 + 0.917 }];
    expect(historyTransitions(rows)).toEqual([tr("off", T0 + 0.917)]);
  });

  it("carries the open flag when a gap bridges into an open interval", () => {
    const now = T0 + 10 * H;
    const rows = [tr("on", T0 + H), tr("off", T0 + 2 * H), tr("on", T0 + 2 * H + 120)];
    expect(contextIntervals(rows, ["on"], range, now)).toEqual([
      { start: T0 + H, end: now, open: true },
    ]);
  });

  it("keeps a short interval at the range start or at a past day's end", () => {
    const rows = [tr("on", T0 - H), tr("off", T0 + 30), tr("on", T0 + 24 * H - 30)];
    expect(contextIntervals(rows, ["on"], range, after)).toEqual([
      { start: T0, end: T0 + 30 },
      { start: T0 + 24 * H - 30, end: T0 + 24 * H },
    ]);
  });

  it("keeps a burst whole when one of its steps is in the picked band", () => {
    const away: ContextBand = {
      key: "0",
      entity: "input_boolean.away",
      label: "Away",
      color: "blue",
      intervals: [{ start: T0 + H, end: T0 + 2 * H }],
    };
    const step = (id: string, start: number, label: string) =>
      ev({
        id,
        start,
        title: "Front door",
        stateLabel: label,
        category: "door",
        entityId: "binary_sensor.front_door",
      });
    const items = groupTimeline(
      [step("s1", T0 + 2 * H - 20, "Open"), step("s2", T0 + 2 * H + 40, "Closed")],
      { window: 120 },
    );
    const out = applyFilters(items, { categories: new Set() }, inAnyBand([away]));
    expect(out.map((i) => i.kind === "burst" && i.events.map((e) => e.id))).toEqual([["s1", "s2"]]);
  });

  describe("mergeTransitions", () => {
    const live = [tr("off", T0 + 5 * H)];

    it("keeps live changes newer than the fetch and drops ones it already has", () => {
      const fetched = [tr("on", T0), tr("off", T0 + 5 * H)];
      expect(mergeTransitions(fetched, live, undefined, range, false)).toEqual(fetched);
      expect(mergeTransitions([tr("on", T0)], live, undefined, range, false)).toEqual([
        tr("on", T0),
        tr("off", T0 + 5 * H),
      ]);
    });

    it("seeds an entity without history from its current state when it held over the view", () => {
      const current = tr("on", T0 - 20 * 24 * H); // unchanged for 20 days
      expect(mergeTransitions([], [], current, range, false)).toEqual([current]);
      expect(mergeTransitions([], [], current, range, true)).toEqual([current]);
    });

    it("doesn't seed a past day from a state that began after the day started", () => {
      const current = tr("on", T0 + 2 * H);
      expect(mergeTransitions([], [], current, range, true)).toEqual([]);
    });
  });

  it("clamps a strip band that runs past the range end", () => {
    const bands: ContextBand[] = [
      {
        key: "0",
        entity: "a",
        label: "A",
        color: "red",
        intervals: [{ start: T0 + 18 * H, end: T0 + 30 * H }],
      },
    ];
    expect(stripModel([], range, "UTC", 6, bands).bands).toEqual([
      { lane: 0, pos: 0.75, width: 0.25, color: "red" },
    ]);
  });
});
