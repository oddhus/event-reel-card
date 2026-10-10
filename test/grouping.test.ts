import { describe, expect, it } from "vitest";
import { groupTimeline } from "../src/core/grouping";
import type { ReelEvent } from "../src/types";
import { ev } from "./helpers";

const lock = (start: number, label: string) =>
  ev({
    start,
    title: "Front door",
    stateLabel: label,
    category: "lock",
    entityId: "lock.front_door",
  });

const door = (start: number, label: string, title = "Front door") =>
  ev({
    start,
    title,
    stateLabel: label,
    category: "door",
    entityId: title === "Front door" ? "binary_sensor.front_door" : "binary_sensor.basement_door",
  });

const presence = (start: number) =>
  ev({ start, title: "Alex", stateLabel: "Home", category: "presence", entityId: "person.alex" });

const cam = (start: number, end: number, camera = "camera.entrance") =>
  ev({ provider: "frigate", start, end, camera, category: "person", title: `seen ${start}` });

const labels = (item: {
  segments: { name: string; steps: { label: string; count: number }[] }[];
}) =>
  item.segments.map(
    (s) =>
      `${s.name}: ${s.steps.map((x) => (x.count > 1 ? `${x.label}×${x.count}` : x.label)).join(" · ")}`,
  );

describe("groupTimeline", () => {
  it("collapses an entry sequence into one burst", () => {
    const events = [
      lock(1000, "Unlocked"),
      door(1006, "Open"),
      door(1040, "Closed"),
      lock(1100, "Locked"),
    ];
    const items = groupTimeline(events, { window: 120 });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe("burst");
    if (item.kind !== "burst") return;
    expect(labels(item)).toEqual(["Front door: Unlocked · Open · Closed · Locked"]);
    expect(item.start).toBe(1000);
    expect(item.end).toBe(1100);
    expect(item.id).toBe(`burst:${events[0].id}`);
  });

  it("collapses a bouncing lock into its last state with a count", () => {
    const events = [
      lock(266.3, "Unlocked"),
      lock(267.4, "Locked"),
      lock(271.28, "Unlocked"),
      lock(271.29, "Locked"),
      lock(273.57, "Unlocked"),
      door(277.9, "Open"),
    ];
    const [item] = groupTimeline(events, { window: 120 });
    expect(item.kind).toBe("burst");
    if (item.kind !== "burst") return;
    expect(labels(item)).toEqual(["Front door: Unlocked×5 · Open"]);
  });

  it("keeps a quick open and close as two steps", () => {
    const [item] = groupTimeline(
      [lock(1000, "Unlocked"), door(1004, "Open"), door(1008, "Closed")],
      {
        window: 120,
      },
    );
    if (item.kind !== "burst") throw new Error("expected a burst");
    expect(labels(item)).toEqual(["Front door: Unlocked · Open · Closed"]);
  });

  it("splits segments by name", () => {
    const events = [door(1000, "Open"), door(1010, "Open", "Basement door"), door(1020, "Closed")];
    const [item] = groupTimeline(events, { window: 120 });
    if (item.kind !== "burst") throw new Error("expected a burst");
    expect(labels(item)).toEqual(["Front door: Open", "Basement door: Open", "Front door: Closed"]);
  });

  it("starts a new burst after the window", () => {
    const items = groupTimeline([door(1000, "Open"), door(1200, "Closed")], { window: 120 });
    expect(items.map((i) => i.kind)).toEqual(["event", "event"]);
  });

  it("never mixes presence into door bursts or across people", () => {
    const sam = ev({
      start: 1015,
      title: "Sam",
      stateLabel: "Away",
      category: "presence",
      entityId: "person.sam",
    });
    const items = groupTimeline([presence(1000), lock(1010, "Unlocked"), sam], { window: 120 });
    expect(items.map((i) => i.kind)).toEqual(["event", "event", "event"]);
  });

  it("groups flapping presence of one person", () => {
    const away = ev({
      start: 1030,
      title: "Alex",
      stateLabel: "Away",
      category: "presence",
      entityId: "person.alex",
    });
    const [item] = groupTimeline([presence(1000), away], { window: 120 });
    if (item.kind !== "burst") throw new Error("expected a burst");
    expect(labels(item)).toEqual(["Alex: Home · Away"]);
  });

  it("groups runs on the same camera, measuring from the previous end", () => {
    const events = [
      cam(1000, 1100),
      cam(1200, 1250),
      cam(1300, 1320),
      cam(1310, 1330, "camera.garage"),
    ];
    const items = groupTimeline(events, { window: 120 });
    const group = items.find((i) => i.kind === "camera");
    expect(group?.kind === "camera" && group.events.length).toBe(3);
    expect(items).toHaveLength(2);
  });

  it("sorts newest first by the latest start in each item", () => {
    const events: ReelEvent[] = [presence(5000), cam(1000, 1100), lock(3000, "Locked")];
    const items = groupTimeline(events, { window: 120 });
    expect(items.map((i) => i.sortTime)).toEqual([5000, 3000, 1000]);
  });
});

describe("groupTimeline review fixes", () => {
  it("never folds an event with media into a door burst", () => {
    const unmapped = ev({
      provider: "llmvision",
      start: 1005,
      title: "Person at the door",
      category: "person",
      cameraLabel: "Porch",
      thumbnail: [{ kind: "image", path: "media-source://x", resolve: true }],
    });
    const items = groupTimeline([lock(1000, "Unlocked"), unmapped, door(1010, "Open")], {
      window: 120,
    });
    expect(items.map((i) => i.kind).sort()).toEqual(["burst", "event"]);
    expect(items.find((i) => i.kind === "event")?.id).toBe(unmapped.id);
  });
});
