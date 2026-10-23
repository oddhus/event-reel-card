// Neutral, generated example data relative to "now", so the dev harness always has a
// populated last 24 hours. No real homes, names or footage.

import type { LogbookEntry } from "../../src/providers/entity";
import type { FrigateReview, FrigateReviewMetadata } from "../../src/providers/frigate";
import type { EventReelRecord } from "../../src/providers/eventreel";
import type { LlmVisionEvent } from "../../src/providers/llmvision";

export interface ExampleData {
  reviews: FrigateReview[];
  llmvision: LlmVisionEvent[];
  /** The same AI descriptions as the Event Reel integration stores them. */
  eventReel: EventReelRecord[];
  logbook: LogbookEntry[];
  history: Record<string, { s: string; a: Record<string, unknown>; lu: number }[]>;
  nestToken: string;
}

const iso = (epoch: number) => new Date(epoch * 1000).toISOString();
const rid = (t: number, suffix: string) => `${t.toFixed(6)}-${suffix}`;

export function exampleData(now: number): ExampleData {
  const h = (hoursAgo: number) => Math.floor(now - hoursAgo * 3600);
  const reviews: FrigateReview[] = [];
  const llmvision: LlmVisionEvent[] = [];
  const eventReel: EventReelRecord[] = [];
  const logbook: LogbookEntry[] = [];
  const history: ExampleData["history"] = { "lock.front_door": [] };

  const review = (
    camera: string,
    start: number,
    dur: number,
    objects = ["person"],
    suffix = "abc",
    metadata: FrigateReviewMetadata | null = null,
  ) => {
    const id = rid(start, suffix);
    reviews.push({
      id,
      camera,
      start_time: start,
      end_time: start + dur,
      severity: "alert",
      has_been_reviewed: false,
      thumb_path: `/media/frigate/clips/review/thumb-${camera}-${id}.webp`,
      data: { objects, sub_labels: [], zones: [], metadata },
    });
    return start;
  };
  const reelCamera = (camera: string) =>
    camera.startsWith("image.") ? camera.replace(/^image.(.*)_person$/, "camera.$1") : camera;
  const ai = (
    camera: string,
    start: number,
    title: string,
    description: string,
    uid: string,
    category = "person",
  ) => {
    eventReel.push({
      id: `reel-${uid}`,
      start: iso(start),
      camera: reelCamera(camera),
      title,
      description,
      category,
      labels: [category],
      key_frame: `media-source://media_source/local/event_reel/${uid}.jpg`,
      source: "trigger",
      analysis: "ok",
    });
    return llmvision.push({
      uid,
      title,
      description,
      start: iso(start),
      end: iso(start + 65),
      key_frame: `/media/llmvision/snapshots/${uid}.jpg`,
      camera_name: camera,
      category: "person",
      label: "person",
    });
  };

  const entry = (start: number) => {
    const lockSeq: [number, string][] = [
      [0, "unlocked"],
      [6, "on"],
      [40, "off"],
      [95, "locked"],
    ];
    for (const [dt, state] of lockSeq) {
      const entity =
        state === "on" || state === "off" ? "binary_sensor.front_door" : "lock.front_door";
      logbook.push({ when: start + dt, entity_id: entity, state });
      if (entity === "lock.front_door") {
        history["lock.front_door"].push({
          s: state,
          a: { changed_by: state === "locked" ? "One-touch" : "Keypad" },
          lu: start + dt,
        });
      }
    }
  };

  // Morning: someone leaves.
  let t = review("entrance", h(14.2), 48, ["person"], "abc", {
    title: "Person leaves with a backpack",
    shortSummary: "One person walks down the steps carrying a backpack.",
  });
  ai(
    "image.entrance_person",
    t + 2,
    "Person leaves with a backpack",
    "One person in a dark jacket walks down the steps carrying a backpack.",
    "ex-1",
  );
  entry(t - 30);
  logbook.push({ when: t + 300, entity_id: "person.alex", state: "not_home" });

  // A long visit with two AI descriptions.
  t = review("entrance", h(9.5), 225, ["person"], "def");
  ai(
    "image.entrance_person",
    t,
    "Courier at the door",
    "A courier in a yellow vest holds a parcel at the front door.",
    "ex-2",
  );
  ai(
    "image.entrance_person",
    t + 150,
    "Courier leaves a parcel",
    "The courier places the parcel by the door and walks away.",
    "ex-3",
  );

  // Garage activity with Frigate GenAI summaries only (threat levels 2 and 1).
  review("garage", h(8.1), 95, ["person"], "g1", {
    title: "Person tries the car door handles",
    shortSummary: "A person walks between the cars trying the door handles.",
    potential_threat_level: 2,
    other_concerns: ["Checked several car doors"],
  });
  review("garage", h(7.95), 40, ["car"], "g2", {
    title: "Unfamiliar car waits in the driveway",
    shortSummary: "A car stops in the driveway with its engine running, then drives off.",
    potential_threat_level: 1,
  });

  // Lock bounce, then the door.
  const b = h(6);
  for (const [dt, state] of [
    [0, "unlocked"],
    [1.1, "locked"],
    [4.9, "unlocked"],
    [4.95, "locked"],
    [7.2, "unlocked"],
  ] as const) {
    logbook.push({ when: b + dt, entity_id: "lock.front_door", state });
  }
  logbook.push({ when: b + 11, entity_id: "binary_sensor.front_door", state: "on" });
  logbook.push({ when: b + 30, entity_id: "binary_sensor.front_door", state: "off" });
  logbook.push({ when: b + 45, entity_id: "lock.front_door", state: "locked" });

  // Doorbell event analysed by LLM Vision (camera_name is the Nest token).
  const nestToken = btoa(JSON.stringify([String(h(3)), "4242"]));
  llmvision.push({
    uid: "ex-4",
    title: "Child rings the doorbell",
    description: "A child in a red hat presses the doorbell and waits.",
    start: iso(h(3)),
    key_frame: "/media/llmvision/snapshots/ex-4.jpg",
    camera_name: nestToken,
    category: "",
    label: "",
  });
  eventReel.push({
    id: "reel-ex-4",
    start: iso(h(3) - 1),
    camera: "camera.doorbell",
    title: "Child in a red hat at the door",
    description: "A child in a red hat presses the doorbell and waits on the step.",
    category: "doorbell",
    labels: ["person", "chime"],
    key_frame: "media-source://media_source/local/event_reel/ex-4.jpg",
    source: "nest",
    nest: { device_id: "nest-device-1", event_token: nestToken },
    analysis: "ok",
  });

  // Evening: back home.
  t = review("entrance", h(1.2), 35);
  ai(
    "image.entrance_person",
    t + 4,
    "Person arrives home",
    "One person with grocery bags climbs the steps.",
    "ex-5",
  );
  entry(t + 10);
  logbook.push({ when: t + 120, entity_id: "person.alex", state: "home" });

  // An AI event on a camera without Frigate.
  ai(
    "camera.side_yard",
    h(0.5),
    "Cat crosses the yard",
    "A grey cat walks along the fence.",
    "ex-6",
    "animal",
  );

  // Context bands (§5.6): away for a work day with a short blip when someone came back for
  // something, and dark from the evening to the morning. The first row is the state at the
  // start of the range, as `include_start_time_state` gives it.
  const row = (s: string, t: number) => ({ s, a: {}, lu: t });
  history["input_boolean.away"] = [
    row("off", h(24)),
    row("on", h(10.5)),
    row("off", h(10.45)),
    row("on", h(10.4)),
    row("unavailable", h(7)),
    row("on", h(6.99)),
    row("off", h(2.2)),
  ];
  history["sun.sun"] = [
    row("below_horizon", h(24)),
    row("above_horizon", h(14)),
    row("below_horizon", h(3.5)),
  ];

  return { reviews, llmvision, eventReel, logbook, history, nestToken };
}
