import { describe, expect, it } from "vitest";
import { findEvent, parseReelParam } from "../src/core/deeplink";
import {
  applyFilters,
  cameraOptions,
  capItems,
  capList,
  summarize,
  visibleRows,
} from "../src/core/filters";
import { groupTimeline } from "../src/core/grouping";
import type { TimelineItem } from "../src/core/grouping";
import { nearestItem, stripModel, timeAt } from "../src/core/strip";
import { configToForm, formToConfig } from "../src/editor-model";
import type { CardConfig } from "../src/config";
import { ev, iso } from "./helpers";

const cam = (start: number, camera: string, category: "person" | "vehicle" = "person") =>
  ev({ provider: "frigate", start, end: start + 30, camera, category });
const door = (start: number, label: string) =>
  ev({
    start,
    title: "Front door",
    stateLabel: label,
    category: "door",
    entityId: "binary_sensor.front_door",
  });
const lock = (start: number, label: string) =>
  ev({
    start,
    title: "Front door",
    stateLabel: label,
    category: "lock",
    entityId: "lock.front_door",
  });

describe("filters", () => {
  const items = groupTimeline(
    [
      cam(1000, "camera.entrance"),
      cam(5000, "camera.garage", "vehicle"),
      lock(9000, "Unlocked"),
      door(9005, "Open"),
      ev({
        start: 12000,
        category: "presence",
        title: "Alex",
        stateLabel: "Home",
        entityId: "person.alex",
      }),
    ],
    { window: 120 },
  );

  it("counts rows under every category they contain, in display order", () => {
    expect(summarize(items)).toEqual([
      { category: "person", count: 1 },
      { category: "vehicle", count: 1 },
      { category: "door", count: 1 },
      { category: "lock", count: 1 },
      { category: "presence", count: 1 },
    ]);
  });

  it("matches a burst by any category it contains", () => {
    const filtered = applyFilters(items, { categories: new Set(["lock"]) });
    expect(filtered.map((i) => i.kind)).toEqual(["burst"]);
  });

  it("filters by camera and lists camera options", () => {
    expect(applyFilters(items, { categories: new Set(), camera: "camera.garage" })).toHaveLength(1);
    expect(cameraOptions(items, (k) => k.replace("camera.", ""))).toEqual([
      { key: "camera.entrance", name: "entrance", count: 1 },
      { key: "camera.garage", name: "garage", count: 1 },
    ]);
  });

  it("returns everything without filters", () => {
    expect(applyFilters(items, { categories: new Set() })).toBe(items);
  });
});

describe("max_events cap", () => {
  // Items newest first, as groupTimeline returns them; `n` events each.
  const row = (id: string, n: number): TimelineItem => {
    const events = Array.from({ length: n }, (_, k) =>
      ev({ id: `${id}.${k}`, start: 1000 - k, category: "person" }),
    );
    return n === 1
      ? { kind: "event", id, sortTime: 1000, start: 1000, end: 1000, event: events[0] }
      : { kind: "camera", id, camera: "camera.x", sortTime: 1000, start: 1000, end: 1000, events };
  };
  const ids = (r: { list: TimelineItem[] }) => r.list.map((i) => i.id);

  it("keeps the newest rows up to the limit and counts the hidden events", () => {
    const r = capItems([row("a", 1), row("b", 1), row("c", 1), row("d", 1), row("e", 1)], 3);
    expect(ids(r)).toEqual(["a", "b", "c"]);
    expect(r.hidden).toBe(2);
  });

  it("keeps a group across the limit whole", () => {
    // 2 events, then a group of 3 that crosses 4, then 1 more.
    const r = capItems([row("a", 2), row("b", 3), row("c", 1)], 4);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.hidden).toBe(1);
  });

  it("reaches as far as a kept row", () => {
    const list = [row("a", 1), row("b", 1), row("c", 1), row("d", 1)];
    const r = capItems(list, 2, (i) => i.id === "c");
    expect(ids(r)).toEqual(["a", "b", "c"]);
    expect(r.hidden).toBe(1);
  });

  it("hides nothing under the limit", () => {
    const list = [row("a", 1), row("b", 2)];
    expect(capItems(list, 3)).toEqual({ list, hidden: 0 });
  });

  it("applies after the filters, so a filter shows older matches", () => {
    // Three newer people and four older door changes (far enough apart to stay separate rows),
    // a limit of 3 and the door filter. Capping first would leave no door rows at all.
    const timeline = groupTimeline(
      [
        door(1000, "Open"),
        door(2000, "Closed"),
        door(3000, "Open"),
        door(4000, "Closed"),
        cam(5000, "camera.entrance"),
        cam(6000, "camera.garage"),
        cam(7000, "camera.yard"),
      ],
      { window: 120 },
    );
    const r = visibleRows(timeline, { categories: new Set(["door"]) }, 3);
    expect(r.list.map((i) => i.sortTime)).toEqual([4000, 3000, 2000]);
    expect(r.hidden).toBe(1);
    const all = visibleRows(timeline, { categories: new Set() }, 3);
    expect(all.list.map((i) => i.sortTime)).toEqual([7000, 6000, 5000]);
    expect(all.hidden).toBe(4);
  });

  it("shows one row with a limit of 1", () => {
    const r = capItems([row("a", 1), row("b", 1)], 1);
    expect(ids(r)).toEqual(["a"]);
    expect(r.hidden).toBe(1);
  });

  it("shows a first group larger than the limit whole", () => {
    const r = capItems([row("a", 5), row("b", 1)], 2);
    expect(ids(r)).toEqual(["a"]);
    expect(r.hidden).toBe(1);
  });

  it("changes nothing for a kept row inside the limit", () => {
    const r = capItems([row("a", 1), row("b", 1), row("c", 1)], 2, (i) => i.id === "a");
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.hidden).toBe(1);
  });

  it("reaches a kept group past the limit and counts what's after it", () => {
    const r = capItems(
      [row("a", 1), row("b", 1), row("c", 3), row("d", 2)],
      1,
      (i) => i.id === "c",
    );
    expect(ids(r)).toEqual(["a", "b", "c"]);
    expect(r.hidden).toBe(2);
  });

  it("caps a plain list by entry count, for the events of an open group", () => {
    const r = capList(
      ["e5", "e4", "e3", "e2", "e1"],
      2,
      () => 1,
      (e) => e === "e3",
    );
    expect(r).toEqual({ list: ["e5", "e4", "e3"], hidden: 2 });
  });
});

describe("day strip", () => {
  const range = { start: iso("2026-10-08T00:00:00+02:00"), end: iso("2026-10-09T00:00:00+02:00") };
  const items = groupTimeline(
    [
      cam(iso("2026-10-08T06:30:00+02:00"), "camera.a"),
      cam(iso("2026-10-08T18:00:00+02:00"), "camera.b"),
    ],
    { window: 120 },
  );

  it("places ticks, buckets and 6-hour marks", () => {
    const m = stripModel(items, range, "Europe/Oslo");
    expect(m.ticks.map((t) => +t.pos.toFixed(3)).sort()).toEqual([0.271, 0.75]);
    expect(m.buckets).toHaveLength(24);
    expect(m.buckets[6]).toBe(1);
    expect(m.buckets[18]).toBe(1);
    expect(m.marks.map((x) => +x.pos.toFixed(2))).toEqual([0.25, 0.5, 0.75]);
  });

  it("maps positions to times and finds the nearest row", () => {
    const t = timeAt(0.74, range);
    expect(nearestItem(items, t)?.kind).toBe("event");
    expect(nearestItem(items, t)?.sortTime).toBe(iso("2026-10-08T18:00:00+02:00"));
  });
});

describe("deep links", () => {
  it("reads the id from hash or query", () => {
    expect(parseReelParam({ hash: "#reel=abc", search: "" })).toBe("abc");
    expect(parseReelParam({ hash: "", search: "?foo=1&reel=x.y-z" })).toBe("x.y-z");
    expect(parseReelParam({ hash: "", search: "" })).toBeUndefined();
  });

  it("finds by id, review id and LLM Vision uid", () => {
    const merged = ev({
      id: "frigate:frigate:1791450000.123456-abc123",
      provider: "frigate",
      start: 1,
      aliases: ["1791450000.123456-abc123", "llmvision:uid-1"],
    });
    const events = [ev({ start: 2 }), merged];
    expect(findEvent(events, "frigate:frigate:1791450000.123456-abc123")).toBe(merged);
    expect(findEvent(events, "1791450000.123456-abc123")).toBe(merged);
    expect(findEvent(events, "uid-1")).toBe(merged);
    expect(findEvent(events, "nope")).toBeUndefined();
  });
});

describe("editor model", () => {
  const base: CardConfig = {
    type: "custom:event-reel-card",
    language: "nb",
    entities: [
      { entity: "lock.front_door", name: "Front door", actor_attribute: "changed_by" },
      "person.alex",
    ],
    llmvision: { non_camera: false },
    frigate: true,
    camera_aliases: { "camera.a": "camera.b" },
  };

  it("round-trips without changing anything", () => {
    expect(formToConfig(configToForm(base), base)).toEqual(base);
  });

  it("keeps entity options for remaining entities and adds new ones as ids", () => {
    const form = { ...configToForm(base), entities: ["lock.front_door", "person.sam"] };
    expect(formToConfig(form, base).entities).toEqual([
      { entity: "lock.front_door", name: "Front door", actor_attribute: "changed_by" },
      "person.sam",
    ]);
  });

  it("disables a provider without losing its options and re-enables it", () => {
    const off = formToConfig({ ...configToForm(base), llmvision_enabled: false }, base);
    expect(off.llmvision).toEqual({ non_camera: false, enabled: false });
    const on = formToConfig({ ...configToForm(off), llmvision_enabled: true }, off);
    expect(on.llmvision).toEqual({ non_camera: false });
    const frigOff = formToConfig({ ...configToForm(base), frigate_enabled: false }, base);
    expect(frigOff.frigate).toBe(false);
  });

  it("writes provider options only when they differ from the defaults", () => {
    const c = formToConfig(
      { ...configToForm(base), frigate_show_unmatched: false, frigate_alerts_only: true },
      base,
    );
    expect(c.frigate).toEqual({ show_unmatched: false, severity: ["alert"] });
    const back = formToConfig(
      { ...configToForm(c), frigate_show_unmatched: true, frigate_alerts_only: false },
      c,
    );
    expect(back.frigate).toBe(true);
  });

  it("writes day_navigation only when it is switched off", () => {
    expect(formToConfig(configToForm(base), base)).not.toHaveProperty("day_navigation");
    const off = formToConfig({ ...configToForm(base), day_navigation: false }, base);
    expect(off.day_navigation).toBe(false);
    expect(configToForm(off).day_navigation).toBe(false);
  });

  it("keeps keys the form doesn't show", () => {
    const c = formToConfig({ ...configToForm(base), title: "Today" }, base);
    expect(c.camera_aliases).toEqual(base.camera_aliases);
    expect(c.title).toBe("Today");
  });
});

describe("M2 review fixes", () => {
  it("places hour marks on local hours in a half-hour zone", () => {
    const range = {
      start: iso("2026-10-08T00:00:00+05:30"),
      end: iso("2026-10-09T00:00:00+05:30"),
    };
    const m = stripModel([], range, "Asia/Kolkata");
    expect(m.marks.map((x) => x.epoch)).toEqual([
      iso("2026-10-08T06:00:00+05:30"),
      iso("2026-10-08T12:00:00+05:30"),
      iso("2026-10-08T18:00:00+05:30"),
    ]);
  });

  it("ignores an invalid range typed in the editor", () => {
    const base: CardConfig = { type: "custom:event-reel-card", range: "12h" };
    expect(formToConfig({ ...configToForm(base), range: "banana" }, base).range).toBe("12h");
    expect(formToConfig({ ...configToForm(base), range: "0h" }, base).range).toBe("12h");
    expect(formToConfig({ ...configToForm(base), range: "today" }, base).range).toBe("today");
  });

  it("takes a range in hours picked or typed in the editor", () => {
    const today: CardConfig = { type: "custom:event-reel-card", range: "today" };
    const pick = (range: string) => formToConfig({ ...configToForm(today), range }, today).range;
    expect(pick("12h")).toBe("12h");
    expect(pick("48h")).toBe("48h");
    expect(pick("6")).toBe("6");
    expect(pick("1.5h")).toBe("1.5h");
    // And back from "today" to the default.
    expect(pick("24h")).toBe("24h");
    // Typed with spaces: saved as the card reads it.
    expect(pick(" 6h ")).toBe("6h");
  });

  it("restores a custom severity list when 'alerts only' is switched off again", () => {
    const initial: CardConfig = {
      type: "custom:event-reel-card",
      frigate: { severity: ["detection"] },
    };
    const on = formToConfig(
      { ...configToForm(initial), frigate_alerts_only: true },
      initial,
      initial,
    );
    expect(on.frigate).toEqual({ severity: ["alert"] });
    const off = formToConfig({ ...configToForm(on), frigate_alerts_only: false }, on, initial);
    expect(off.frigate).toEqual({ severity: ["detection"] });
  });
});

describe("Opus M2 review fixes", () => {
  it("doesn't offer per-event media keys as cameras", () => {
    const items = groupTimeline(
      [
        cam(1000, "camera.entrance"),
        ev({
          provider: "llmvision",
          start: 2000,
          category: "custom",
          thumbnail: [{ kind: "image", path: "media-source://x", resolve: true }],
        }),
      ],
      { window: 120 },
    );
    expect(cameraOptions(items, (k) => k).map((o) => o.key)).toEqual(["camera.entrance"]);
  });

  it("returns a provider to auto when it was absent at first", () => {
    const initial: CardConfig = { type: "custom:event-reel-card" };
    const off = formToConfig(
      { ...configToForm(initial), frigate_enabled: false },
      initial,
      initial,
    );
    expect(off.frigate).toBe(false);
    const on = formToConfig({ ...configToForm(off), frigate_enabled: true }, off, initial);
    expect("frigate" in on).toBe(false);
  });
});
