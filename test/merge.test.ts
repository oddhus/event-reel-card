import { describe, expect, it } from "vitest";
import { mergeEvents } from "../src/core/merge";
import type { MergeOptions } from "../src/core/merge";
import type { ReelEvent } from "../src/types";
import { ev, iso } from "./helpers";

const opts = (now: number, extra: Partial<MergeOptions> = {}): MergeOptions => ({
  before: 15,
  after: 30,
  now,
  showUnmatched: true,
  hideUnconfirmed: false,
  ...extra,
});

const review = (camera: string, start: number, end: number | undefined, id = `r${start}`) =>
  ev({
    id: `frigate:frigate:${id}`,
    provider: "frigate",
    camera,
    start,
    end,
    title: "Person at Entrance",
    category: "person",
    labels: ["person"],
    thumbnail: [{ kind: "image", path: `/api/frigate/frigate/clips/review/thumb-${id}.webp` }],
    preview: [
      {
        kind: "mp4",
        path: `/api/frigate/frigate/notifications/${id}/review_preview.gif?format=mp4`,
      },
    ],
    frigate: { instance: "frigate", camera: "entrance", reviewId: id },
  });

const ai = (
  camera: string,
  start: number,
  title: string,
  category: ReelEvent["category"] = "person",
) =>
  ev({
    id: `llmvision:${title}`,
    provider: "llmvision",
    camera,
    start,
    end: start + 65,
    title,
    description: `${title}, described`,
    category,
    thumbnail: [{ kind: "image", path: "media-source://media_source/local/x.jpg", resolve: true }],
  });

describe("mergeEvents", () => {
  it("merges the real sample: AI 14:16:26 with review 14:15:43–14:16:32", () => {
    const r = review(
      "camera.entrance",
      iso("2026-10-08T14:15:43.32+02:00"),
      iso("2026-10-08T14:16:32.55+02:00"),
    );
    const t = ai("camera.entrance", iso("2026-10-08T14:16:26.866834+02:00"), "Person searching");
    const out = mergeEvents([r, t], opts(iso("2026-10-08T15:00:00+02:00")));

    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.id).toBe(r.id);
    expect(m.title).toBe("Person searching");
    expect(m.description).toBe("Person searching, described");
    expect(m.sources).toEqual(["llmvision", "frigate"]);
    expect(m.aliases).toContain(t.id);
    expect(m.start).toBe(r.start);
    expect(m.end).toBe(r.end);
    expect(m.preview).toEqual(r.preview);
    // Frigate still first, the AI key frame as a fallback.
    expect(m.thumbnail?.map((x) => x.kind)).toEqual(["image", "image"]);
    expect(m.thumbnail?.[1].resolve).toBe(true);
  });

  it("attaches several AI events to one long review (many-to-one)", () => {
    const r = review("camera.entrance", 1000, 1225);
    const first = ai("camera.entrance", 1000, "First");
    const second = ai("camera.entrance", 1198, "Second");
    const out = mergeEvents([second, r, first], opts(5000));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("First");
    expect(out[0].extra).toEqual([
      { start: 1198, title: "Second", description: "Second, described" },
    ]);
  });

  it("picks the review whose start is nearest", () => {
    const a = review("camera.entrance", 1000, 1050, "a");
    const b = review("camera.entrance", 1060, 1100, "b");
    const t = ai("camera.entrance", 1055, "Between");
    const out = mergeEvents([a, b, t], opts(5000));
    const merged = out.find((e) => e.title === "Between");
    expect(merged?.id).toBe(b.id);
    expect(out.find((e) => e.id === a.id)?.title).toBe("Person at Entrance");
  });

  it("respects the windows", () => {
    const r = review("camera.entrance", 1000, 1050);
    const early = ai("camera.entrance", 984, "Too early");
    const late = ai("camera.entrance", 1081, "Too late");
    const out = mergeEvents([r, early, late], opts(5000));
    expect(out).toHaveLength(3);
  });

  it("uses now as the end of an ongoing review", () => {
    const r = review("camera.entrance", 1000, undefined);
    const t = ai("camera.entrance", 1100, "Still going");
    const out = mergeEvents([r, t], opts(1090));
    expect(out).toHaveLength(1);
    expect(out[0].end).toBeUndefined();
  });

  it("never matches across cameras", () => {
    const r = review("camera.garage", 1000, 1050);
    const t = ai("camera.entrance", 1000, "Elsewhere");
    expect(mergeEvents([r, t], opts(5000))).toHaveLength(2);
  });

  it("keeps the media category when the AI one is vague", () => {
    const r = review("camera.entrance", 1000, 1050);
    const t = ai("camera.entrance", 1000, "Something", "motion");
    expect(mergeEvents([r, t], opts(5000))[0].category).toBe("person");
  });

  it("shows unmatched reviews by default and hides them when asked", () => {
    const r = review("camera.garage", 1000, 1050);
    expect(mergeEvents([r], opts(5000))).toHaveLength(1);
    expect(mergeEvents([r], opts(5000, { showUnmatched: false }))).toHaveLength(0);
  });

  it("hides unconfirmed reviews only on AI cameras and only after the grace period", () => {
    const confirmed = review("camera.entrance", 1000, 1050, "c");
    const t = ai("camera.entrance", 1000, "Seen");
    const old = review("camera.entrance", 2000, 2050, "old");
    const fresh = review("camera.entrance", 4900, 4950, "fresh");
    const garage = review("camera.garage", 2000, 2050, "garage");
    const out = mergeEvents(
      [confirmed, t, old, fresh, garage],
      opts(5000, { hideUnconfirmed: true }),
    );
    const ids = out.map((e) => e.id);
    expect(ids).toContain(confirmed.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(garage.id);
    expect(ids).not.toContain(old.id);
  });

  it("passes other events through untouched", () => {
    const door = ev({ start: 1000, category: "door", entityId: "binary_sensor.front_door" });
    const unmapped = ev({ provider: "llmvision", start: 1000, title: "No camera" });
    const out = mergeEvents([door, unmapped], opts(5000));
    expect(out).toEqual([door, unmapped]);
  });

  it("keeps the review's threat and concerns when AI text merges into it", () => {
    const r = {
      ...review("camera.entrance", 1000, 1050),
      threat: 2 as const,
      concerns: ["Checked the door"],
    };
    const t = ai("camera.entrance", 1000, "Seen");
    const out = mergeEvents([r, t], opts(5000));
    expect(out).toHaveLength(1);
    expect(out[0].threat).toBe(2);
    expect(out[0].concerns).toEqual(["Checked the door"]);
  });

  it("keeps Frigate's summary as extra text when a flagged review gets an AI description", () => {
    const flagged = {
      ...review("camera.entrance", 1000, 1050),
      title: "Person tries the door handle",
      description: "A person pulls the handle twice and leaves.",
      threat: 1 as const,
    };
    const out = mergeEvents(
      [flagged, ai("camera.entrance", 1010, "Person at the door")],
      opts(5000),
    );
    expect(out[0].title).toBe("Person at the door");
    expect(out[0].extra).toEqual([
      {
        start: 1000,
        title: "Person tries the door handle",
        description: "A person pulls the handle twice and leaves.",
      },
    ]);
  });

  it("shows a flagged review's summary once when the AI text has no description", () => {
    const flagged = {
      ...review("camera.entrance", 1000, 1050),
      description: "A person pulls the handle twice and leaves.",
      threat: 2 as const,
    };
    const bare = { ...ai("camera.entrance", 1010, "Person at the door"), description: undefined };
    const out = mergeEvents([flagged, bare], opts(5000));
    expect(out[0].description).toBe("A person pulls the handle twice and leaves.");
    expect(out[0].extra).toBeUndefined();
  });

  it("adds no extra text for a review without a threat level", () => {
    const normal = { ...review("camera.entrance", 1000, 1050), description: "A person walks by." };
    const out = mergeEvents(
      [normal, ai("camera.entrance", 1010, "Person at the door")],
      opts(5000),
    );
    expect(out[0].extra).toBeUndefined();
  });

  it("never hides a flagged review as unconfirmed", () => {
    const t = ai("camera.entrance", 1000, "Seen");
    const confirmed = review("camera.entrance", 1000, 1050, "c");
    const flagged = { ...review("camera.entrance", 2000, 2050, "flagged"), threat: 2 as const };
    const plain = review("camera.entrance", 3000, 3050, "plain");
    const ids = mergeEvents(
      [confirmed, t, flagged, plain],
      opts(5000, { hideUnconfirmed: true }),
    ).map((e) => e.id);
    expect(ids).toContain(flagged.id);
    expect(ids).not.toContain(plain.id);
  });
});

describe("mergeEvents review fixes", () => {
  it("extends the merged end to cover an AI moment after the review", () => {
    const r = review("camera.entrance", 1000, 1050);
    const t = ai("camera.entrance", 1078, "Late");
    expect(mergeEvents([r, t], opts(5000))[0].end).toBe(1078);
  });

  it("keeps unmapped reviews subject to show_unmatched", () => {
    const r = { ...review("camera.x", 1000, 1050), camera: undefined, cameraLabel: "yard" };
    expect(mergeEvents([r], opts(5000))).toHaveLength(1);
    expect(mergeEvents([r], opts(5000, { showUnmatched: false }))).toHaveLength(0);
  });
});
