import "./ha-stubs";
import { mdiWalk } from "@mdi/js";
import { clock } from "../src/event-reel-card";
import type { EventReelCard } from "../src/event-reel-card";
import type { HassEntity, HassEntityRegistryEntry } from "../src/ha-types";
import { exampleData } from "./fixtures/example";
import { createMockHass } from "./mock-hass";
import type { WsHandler } from "./mock-hass";

// URL options:
//   ?now=2026-10-08T21:00:00+02:00   pin the clock
//   ?live=1                          real Frigate reviews and media through the Vite proxy (FRIGATE_URL)
//   ?density=comfortable             row density
//   ?ai=event_reel                   AI text from the Event Reel integration instead of LLM
//                                    Vision (?ai=both: both, the same moments described twice)
//   ?slow=frigate:5,llmvision:hang   delay a source by seconds, or never answer
//                                    (also: entity, nest, history for actors)
const params = new URLSearchParams(location.search);
const pinned = params.get("now");
if (pinned) {
  const t = Date.parse(pinned) / 1000;
  clock.now = () => t;
}
const live = params.get("live") === "1";
const aiSource = params.get("ai") ?? "llmvision";
const withLlmVision = aiSource !== "event_reel";
const withEventReel = aiSource === "event_reel" || aiSource === "both";
const now = clock.now();

// Optional private snapshots (gitignored): dev/fixtures/llmvision.local.json, logbook.local.json.
const localFiles = import.meta.glob<{ default: unknown }>("./fixtures/*.local.json", {
  eager: true,
});
const local = (name: string) => localFiles[`./fixtures/${name}.local.json`]?.default;

const data = exampleData(now);

const st = (
  entity_id: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HassEntity => ({
  entity_id,
  state,
  attributes,
  last_changed: new Date(now * 1000).toISOString(),
  last_updated: new Date(now * 1000).toISOString(),
});

const states: Record<string, HassEntity> = {};
const entities: Record<string, HassEntityRegistryEntry> = {};

function frigateCamera(name: string, label = name.replace(/_/g, " ")) {
  const id = `camera.${name}`;
  states[id] = st(id, "recording", {
    friendly_name: label.charAt(0).toUpperCase() + label.slice(1),
    client_id: "frigate",
    camera_name: name,
  });
  entities[id] = { entity_id: id, device_id: `dev-${name}`, platform: "frigate" };
  entities[`image.${name}_person`] = {
    entity_id: `image.${name}_person`,
    device_id: `dev-${name}`,
    platform: "frigate",
  };
}

frigateCamera("entrance");
frigateCamera("garage");
states["camera.doorbell"] = st("camera.doorbell", "streaming", { friendly_name: "Doorbell" });
entities["camera.doorbell"] = {
  entity_id: "camera.doorbell",
  device_id: "nest-device-1",
  platform: "nest",
};
states["camera.side_yard"] = st("camera.side_yard", "idle", { friendly_name: "Side yard" });
states["lock.front_door"] = st("lock.front_door", "locked", {
  friendly_name: "Lock",
  changed_by: "One-touch",
});
states["binary_sensor.front_door"] = st("binary_sensor.front_door", "off", {
  friendly_name: "Front door",
  device_class: "door",
});
states["person.alex"] = st("person.alex", "home", { friendly_name: "Alex" });
states["calendar.llm_vision_timeline"] = st("calendar.llm_vision_timeline", "off");

// A neutral stand-in thumbnail: sky, ground and a figure, tinted per event.
const svg = (text: string, hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="hsl(${hue},45%,72%)"/><stop offset="1" stop-color="hsl(${hue},30%,52%)"/>
      </linearGradient></defs>
      <rect width="320" height="180" fill="url(#s)"/>
      <rect y="120" width="320" height="60" fill="hsl(${(hue + 90) % 360},18%,34%)"/>
      <rect x="40" y="58" width="70" height="72" fill="hsl(${hue},12%,86%)"/>
      <rect x="62" y="92" width="24" height="38" fill="hsl(${hue},20%,40%)"/>
      <g transform="translate(176 66) scale(3)" fill="hsl(${hue},25%,18%)"><path d="${mdiWalk}"/></g>
      <title>${text}</title>
    </svg>`,
  )}`;

const inRange = (t: number, msg: Record<string, unknown>) =>
  t >= Number(msg.after ?? -Infinity) && t <= Number(msg.before ?? Infinity);

const handlers: Record<string, WsHandler> = {
  "call_service:llmvision.get_events": () => ({
    response: {
      events: (live && (local("llmvision") as typeof data.llmvision | undefined)) || data.llmvision,
    },
  }),
  "event_reel/events/list": (msg) => {
    const start = msg.start_time ? Date.parse(String(msg.start_time)) / 1000 : -Infinity;
    const end = msg.end_time ? Date.parse(String(msg.end_time)) / 1000 : Infinity;
    return {
      events: data.eventReel
        .filter((e) => {
          const t = Date.parse(e.start) / 1000;
          return t >= start && t <= end;
        })
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
        .slice(0, Number(msg.limit ?? 1000)),
    };
  },
  "frigate/reviews/get": async (msg) => {
    if (live) {
      const q = new URLSearchParams({
        after: String(msg.after),
        before: String(msg.before),
        limit: String(msg.limit ?? 200),
      });
      if (msg.reviewed !== undefined) q.set("reviewed", msg.reviewed ? "1" : "0");
      return (await fetch(`/frigate-api/review?${q}`)).text();
    }
    return JSON.stringify(
      data.reviews.filter(
        (r) =>
          inRange(r.start_time, msg) &&
          (msg.reviewed === undefined || !!r.has_been_reviewed === msg.reviewed),
      ),
    );
  },
  "logbook/get_events": (msg) => {
    const start = Date.parse(String(msg.start_time)) / 1000;
    const end = Date.parse(String(msg.end_time)) / 1000;
    const entries = (live && (local("logbook") as typeof data.logbook | undefined)) || data.logbook;
    return entries.filter((e) => {
      const t = typeof e.when === "number" ? e.when : Date.parse(e.when) / 1000;
      return t >= start && t <= end;
    });
  },
  "history/history_during_period": () => data.history,
  "frigate/reviews/viewed": (msg) => {
    const ids = new Set(msg.ids as string[]);
    for (const r of data.reviews) if (ids.has(r.id)) r.has_been_reviewed = true;
    return { success: true };
  },
  "media_source/browse_media": (msg) =>
    msg.media_content_id === "media-source://nest"
      ? {
          media_content_id: "media-source://nest",
          children: [{ media_content_id: "media-source://nest/nest-device-1" }],
        }
      : {
          media_content_id: msg.media_content_id,
          children: [{ media_content_id: `media-source://nest/nest-device-1/${data.nestToken}` }],
        },
  "media_source/resolve_media": (msg) => {
    const id = String(msg.media_content_id);
    const name = id.split("/").pop() ?? "";
    return {
      url: svg(name.replace(/\.jpg$/, ""), (name.length * 47) % 360),
      mime_type: "image/svg+xml",
    };
  },
};

// Simulate slow or hanging sources, to check that the others still show.
const slowKeys: Record<string, string> = {
  entity: "logbook/get_events",
  llmvision: "call_service:llmvision.get_events",
  event_reel: "event_reel/events/list",
  frigate: "frigate/reviews/get",
  nest: "media_source/browse_media",
  history: "history/history_during_period",
};
for (const part of (params.get("slow") ?? "").split(",").filter(Boolean)) {
  const [source, seconds] = part.split(":");
  const key = slowKeys[source];
  const inner = key ? handlers[key] : undefined;
  if (!key || !inner) continue;
  handlers[key] = (msg) =>
    seconds === "hang"
      ? new Promise(() => undefined)
      : new Promise((resolve) =>
          setTimeout(() => resolve(inner(msg)), Number(seconds || 5) * 1000),
        );
}

if (live) {
  // Real Frigate camera names come from live data at runtime; nothing private is committed.
  const reviews = (await (
    await fetch(`/frigate-api/review?after=${now - 86400}&before=${now}&limit=500`)
  ).json()) as { camera: string }[];
  for (const name of new Set(reviews.map((r) => r.camera))) frigateCamera(name);
}

const stage = document.getElementById("stage")!;
const dark = document.getElementById("dark") as HTMLInputElement;
const narrow = document.getElementById("narrow") as HTMLInputElement;
const lang = document.getElementById("lang") as HTMLSelectElement;

const card = document.createElement("event-reel-card") as EventReelCard;
card.setConfig({
  type: "custom:event-reel-card",
  title: "Today's events",
  density: (params.get("density") as "compact" | "comfortable") ?? "compact",
  entities: [
    { entity: "lock.front_door", name: "Front door", actor_attribute: "changed_by" },
    { entity: "binary_sensor.front_door", name: "Front door" },
    "person.alex",
  ],
  ...(withLlmVision ? { llmvision: { non_camera: false } } : {}),
});
stage.appendChild(card);

function apply() {
  document.body.classList.toggle("dark", dark.checked);
  stage.classList.toggle("narrow", narrow.checked);
  const hass = createMockHass({ language: lang.value, darkMode: dark.checked, states, handlers });
  hass.entities = entities;
  hass.services = {
    ...(withLlmVision ? { llmvision: { get_events: {} } } : {}),
    ...(withEventReel ? { event_reel: { get_events: {} } } : {}),
  };
  hass.config.components = [
    "nest",
    "frigate",
    ...(withLlmVision ? ["llmvision"] : []),
    ...(withEventReel ? ["event_reel"] : []),
  ];
  card.hass = hass;
}

for (const el of [dark, narrow, lang]) el.addEventListener("change", apply);
apply();
