import { describe, expect, it } from "vitest";
import type { ContextBand } from "../src/core/context";
import { inAnyBand } from "../src/core/context";
import { allOf, applyFilters, countRows, isUnreviewed, visibleRows } from "../src/core/filters";
import { groupTimeline } from "../src/core/grouping";
import type { TimelineItem } from "../src/core/grouping";
import type { Presence } from "../src/core/presence";
import { whileNobodyHome } from "../src/core/presence";
import type { ReelEvent } from "../src/types";
import { ev, iso } from "./helpers";

// The "Unreviewed" and "Nobody home" chips (§5.1, §5.10) test each event, like a band chip,
// and all picked chips must hold for the same event.

const T0 = iso("2026-03-02T00:00:00Z");
const M = 60;

const review = (id: string, start: number, reviewed: boolean): ReelEvent =>
  ev({
    id,
    provider: "frigate",
    start,
    end: start + 20,
    camera: "camera.drive",
    category: "person",
    frigate: { instance: "frigate", camera: "drive", reviewId: id },
    reviewed,
  });

const door = (id: string, start: number, state: string): ReelEvent =>
  ev({
    id,
    start,
    entityId: "binary_sensor.front_door",
    title: "Front door",
    stateLabel: state,
    category: "door",
  });

// Nobody home from 10:00 to 12:00 (the grace already taken off).
const presence: Presence = {
  people: [{ entity: "person.alex", name: "Alex", initials: "A" }],
  home: new Map([["person.alex", [{ start: T0, end: T0 + 10 * 60 * M }]]]),
  knownFrom: new Map([["person.alex", T0]]),
  empty: [{ start: T0 + 10 * 60 * M, end: T0 + 12 * 60 * M }],
};
const nobodyHome = (e: ReelEvent) => whileNobodyHome(presence, e);

const at = (h: number, m = 0) => T0 + h * 60 * M + m * M;

// A camera group from 09:58 to 10:01: reviewed before 10:00, unreviewed inside the empty
// house; a door burst from 11:00 to 11:01; and an unreviewed review at 14:00 with people home.
const items: TimelineItem[] = groupTimeline(
  [
    review("r1", at(9, 58), true),
    review("r2", at(9, 59), false),
    review("r3", at(10) + 30, true),
    review("r4", at(10, 1), false),
    door("d1", at(11), "Open"),
    door("d2", at(11, 1), "Closed"),
    review("r5", at(14), false),
  ],
  { window: 120 },
);

const ids = (out: TimelineItem[]) =>
  out.map((i) => (i.kind === "event" ? [i.event.id] : i.events.map((e) => e.id)));

describe("per-event chips", () => {
  it("builds one camera group, one burst and one single row from the example", () => {
    // The setup the tests below rely on.
    expect(items.map((i) => i.kind)).toEqual(["event", "burst", "camera"]);
  });

  it("narrows a camera group to its unreviewed events", () => {
    const out = applyFilters(items, { categories: new Set() }, allOf(isUnreviewed));
    expect(ids(out)).toEqual([["r5"], ["r2", "r4"]]);
  });

  it("keeps rows with an event while nobody was home, and a burst whole", () => {
    const out = applyFilters(items, { categories: new Set() }, allOf(nobodyHome));
    // The burst is inside the empty house; of the group, 10:00:30 and 10:01 are.
    expect(ids(out)).toEqual([
      ["d1", "d2"],
      ["r3", "r4"],
    ]);
  });

  it("needs unreviewed and nobody home to hold for the same event", () => {
    const out = applyFilters(items, { categories: new Set() }, allOf(isUnreviewed, nobodyHome));
    // r2 is unreviewed but before 10:00; r3 is inside but reviewed; only r4 is both.
    expect(ids(out)).toEqual([["r4"]]);
    expect(out[0].kind).toBe("event");
  });

  it("needs a picked band to hold for the same event as the other chips", () => {
    const morning: ContextBand = {
      key: "0",
      entity: "input_boolean.morning",
      label: "Morning",
      color: "#888",
      intervals: [{ start: at(9, 50), end: at(10) }],
    };
    const out = applyFilters(
      items,
      { categories: new Set() },
      allOf(inAnyBand([morning]), isUnreviewed),
    );
    expect(ids(out)).toEqual([["r2"]]);
  });

  it("applies no per-event test when no chip is picked", () => {
    expect(allOf(undefined, undefined)).toBeUndefined();
    expect(applyFilters(items, { categories: new Set() }, allOf())).toBe(items);
  });

  it("counts rows with at least one matching event", () => {
    expect(countRows(items, isUnreviewed)).toBe(2);
    expect(countRows(items, nobodyHome)).toBe(2);
  });

  it("counts only Frigate reviews as unreviewed", () => {
    // An AI event with reviewed: false but no review behind it can't be marked reviewed.
    expect(isUnreviewed(ev({ start: T0, reviewed: false }))).toBe(false);
    expect(isUnreviewed(review("x", T0, false))).toBe(true);
    expect(isUnreviewed(review("y", T0, true))).toBe(false);
  });
});

describe("changes attached to a camera row (PLAN §5.3)", () => {
  // A camera group of two reviews (10:00 and 10:02) with the front door, configured next to
  // the drive camera, opened and closed at 10:01–10:02; a lone review at 15:00.
  const nearDrive = (e: ReelEvent) => ({ ...e, nearCamera: "camera.drive" });
  const attachedItems = groupTimeline(
    [
      review("a1", at(10), false),
      review("a2", at(10, 2), true),
      nearDrive(door("ad1", at(10, 1), "Open")),
      nearDrive(door("ad2", at(10, 2), "Closed")),
      review("a3", at(15), false),
    ],
    { window: 120 },
  );

  it("folds the door into the camera group, leaving two rows", () => {
    expect(attachedItems).toHaveLength(2);
    const group = attachedItems.find((i) => i.kind === "camera");
    expect(group?.attached?.events.map((e) => e.id)).toEqual(["ad1", "ad2"]);
  });

  it("finds the camera row with the Doors chip", () => {
    const out = applyFilters(attachedItems, { categories: new Set(["door"]) });
    expect(ids(out)).toEqual([["a1", "a2"]]);
  });

  it("counts attached changes against max_events", () => {
    // Newest first: the lone review (1 event), then the group (2 reviews + 2 door changes =
    // 4). A limit of 1 hides the whole group; a limit of 2 keeps it, since a group across the
    // limit is kept whole.
    expect(visibleRows(attachedItems, { categories: new Set() }, 1).hidden).toBe(4);
    expect(visibleRows(attachedItems, { categories: new Set() }, 2).hidden).toBe(0);
  });

  it("keeps the attachment when a per-event chip narrows the group", () => {
    // Unreviewed narrows the group to a1, a row of its own, which still shows the door.
    const out = applyFilters(attachedItems, { categories: new Set() }, isUnreviewed);
    const row = out.find((i) => i.kind === "event" && i.event.id === "a1");
    expect(row?.attached?.events.map((e) => e.id)).toEqual(["ad1", "ad2"]);
  });

  it("keeps a camera row the Doors chip found when a per-event chip is picked too", () => {
    // Doors + Unreviewed: the door changes aren't reviews, but the row is kept for them and
    // narrows by Unreviewed alone, to a1.
    const out = applyFilters(attachedItems, { categories: new Set(["door"]) }, isUnreviewed);
    expect(ids(out)).toEqual([["a1"]]);
  });
});
