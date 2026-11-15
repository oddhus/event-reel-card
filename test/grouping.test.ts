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

  it("keeps events with a description out of bursts, so the description stays readable", () => {
    const parcel = ev({
      provider: "llmvision",
      start: 1005,
      title: "Package delivered",
      description: "A package was left by the door.",
    });
    const note = ev({
      provider: "llmvision",
      start: 1015,
      title: "Courier left",
      description: "The van drove off.",
    });
    const unlocked = lock(1000, "Unlocked");
    const items = groupTimeline([unlocked, parcel, note, lock(1020, "Locked")], { window: 120 });
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["burst", `burst:${unlocked.id}`],
      ["event", note.id],
      ["event", parcel.id],
    ]);
    const burst = items.find((i) => i.kind === "burst");
    if (burst?.kind !== "burst") throw new Error("no burst");
    expect(labels(burst)).toEqual(["Front door: Unlocked · Locked"]);
  });

  it("still bursts AI events that have only a title", () => {
    const a = ev({ provider: "llmvision", start: 1000, title: "Lights on" });
    const b = ev({ provider: "llmvision", start: 1010, title: "Lights off" });
    const items = groupTimeline([a, b], { window: 120 });
    expect(items.map((i) => i.kind)).toEqual(["burst"]);
  });
});

describe("changes attached to a camera row (PLAN §5.3)", () => {
  const near = (e: ReelEvent, camera = "camera.entrance") => ({ ...e, nearCamera: camera });
  const entry = (t: number, camera = "camera.entrance") => [
    near(lock(t, "Unlocked"), camera),
    near(door(t + 6, "Open"), camera),
    near(door(t + 40, "Closed"), camera),
    near(lock(t + 100, "Locked"), camera),
  ];

  it("folds an entry burst into the overlapping review of its camera", () => {
    const review = cam(1000, 1035);
    const items = groupTimeline([review, ...entry(1010)], { window: 120 });
    expect(items).toHaveLength(1);
    const [row] = items;
    expect(row.kind).toBe("event");
    if (row.kind !== "event") return;
    expect(row.event).toBe(review);
    expect(row.attached?.events.map((e) => e.stateLabel)).toEqual([
      "Unlocked",
      "Open",
      "Closed",
      "Locked",
    ]);
    expect(labels(row.attached ?? { segments: [] })).toEqual([
      "Front door: Unlocked · Open · Closed · Locked",
    ]);
  });

  it("attaches a single change too, when it lies within the window of the review", () => {
    // The review ends at 1035; the unlock comes 100 s later.
    const items = groupTimeline([cam(1000, 1035), near(lock(1135, "Unlocked"))], {
      window: 120,
    });
    expect(items).toHaveLength(1);
    expect(items[0].attached?.events).toHaveLength(1);
  });

  it("keeps the burst apart when the review is further away than the window", () => {
    // 200 s between the end of the review and the first change.
    const items = groupTimeline([cam(1000, 1035), ...entry(1235)], { window: 120 });
    expect(items.map((i) => i.kind).sort()).toEqual(["burst", "event"]);
    expect(items.every((i) => !i.attached)).toBe(true);
  });

  it("never attaches to another camera's row", () => {
    const items = groupTimeline([cam(1000, 1035, "camera.garage"), ...entry(1010)], {
      window: 120,
    });
    expect(items.map((i) => i.kind).sort()).toEqual(["burst", "event"]);
    expect(items.every((i) => !i.attached)).toBe(true);
  });

  it("picks the nearer of two reviews of the camera when both are in reach", () => {
    // Two reviews 190 s apart, so they stay two rows with a window of 120 s. A change at
    // 1090 is 80 s after the first and 110 s before the second: the first takes it. One at
    // 1120 is 110 s after the first and 80 s before the second: the second takes it.
    const host = (t: number) => {
      const first = cam(1000, 1010);
      const second = cam(1200, 1210);
      const items = groupTimeline([first, second, near(lock(t, "Unlocked"))], { window: 120 });
      expect(items).toHaveLength(2);
      const found = items.find((i) => i.attached);
      return found?.kind === "event" ? found.event : undefined;
    };
    expect(host(1090)?.start).toBe(1000);
    expect(host(1120)?.start).toBe(1200);
  });

  it("doesn't let a door without a camera pull a door off its camera's row", () => {
    // The basement door has no camera configured and changes 10 s after the front door:
    // the front door still joins the review, and the basement door keeps a row of its own.
    const front = near(lock(1010, "Unlocked"));
    const basement = door(1020, "Open", "Basement door");
    const items = groupTimeline([cam(1000, 1035), front, basement], { window: 120 });
    expect(items).toHaveLength(2);
    const host = items.find((i) => i.attached);
    expect(host?.attached?.events).toEqual([front]);
    expect(items.find((i) => !i.attached)).toMatchObject({ kind: "event", event: basement });
  });

  it("joins only the changes of a long run that are near a review", () => {
    // A review 1000–1030, then a change every 100 s from 1120 to 1720: one run with a window
    // of 120 s. Only the first (90 s after the review) is near it; the rest burst on their own.
    const run = [1120, 1220, 1320, 1420, 1520, 1620, 1720].map((t, i) =>
      near(door(t, i % 2 ? "Closed" : "Open")),
    );
    const items = groupTimeline([cam(1000, 1030), ...run], { window: 120 });
    const host = items.find((i) => i.attached);
    expect(host?.attached?.events).toEqual([run[0]]);
    const rest = items.find((i) => i.kind === "burst");
    expect(rest?.kind === "burst" && rest.events).toEqual(run.slice(1));
    // The burst sorts by its own latest change, at the top, not under the 1000 review.
    expect(items[0]).toBe(rest);
  });

  it("counts a review still running as lasting until now", () => {
    // The review started at 1000 and has no end yet; the door opens at 1180, 180 s in.
    const running = ev({
      provider: "frigate",
      start: 1000,
      camera: "camera.entrance",
      category: "person",
      frigate: { instance: "frigate", camera: "entrance", reviewId: "r" },
    });
    const opened = near(door(1180, "Open"));
    const joined = groupTimeline([running, opened], { window: 120, now: 1200 });
    expect(joined).toHaveLength(1);
    expect(joined[0].attached?.events).toEqual([opened]);
    // Without a clock it counts from its start, 180 s away: no join.
    expect(groupTimeline([running, opened], { window: 120 })).toHaveLength(2);
  });

  it("attaches to a camera group as a whole", () => {
    const items = groupTimeline([cam(1000, 1030), cam(1100, 1130), ...entry(1050)], {
      window: 120,
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("camera");
    expect(items[0].attached?.events).toHaveLength(4);
  });

  it("changes nothing for entities without a camera", () => {
    const plain = [lock(1010, "Unlocked"), door(1016, "Open")];
    const items = groupTimeline([cam(1000, 1035), ...plain], { window: 120 });
    expect(items.map((i) => i.kind).sort()).toEqual(["burst", "event"]);
  });
});
