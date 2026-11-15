// Mounts the card on example data with a mock `hass`. The dev harness page (main.ts) and the
// browser tests (test/ui) both use it, so they exercise the same setup.
import "./ha-stubs";
import { mdiWalk } from "@mdi/js";
import { clock } from "../src/event-reel-card";
import type { EventReelCard } from "../src/event-reel-card";
import type { CardConfig } from "../src/config";
import type { HassEntity, HassEntityRegistryEntry } from "../src/ha-types";
import { exampleData } from "./fixtures/example";
import type { ExampleData } from "./fixtures/example";
import { createMockHass } from "./mock-hass";
import type { WsHandler } from "./mock-hass";

export type MountOptions = {
  /** Pins the clock: an ISO time or epoch seconds. Leave out for the real clock. */
  now?: string | number;
  /** Where the card goes; `document.body` when left out. */
  parent?: HTMLElement;
  /** Width of the card's container in px; the parent's width when left out. */
  width?: number;
  /** Merged over the default config. */
  config?: Partial<CardConfig>;
  /** Delays a source by seconds, or `"hang"` never answers: `{ frigate: 4 }`. */
  slow?: Record<string, number | "hang">;
  /** Sources that answer only once `release(source)` is called (for tests). */
  hold?: string[];
  /** Where AI text comes from. */
  ai?: "llmvision" | "event_reel" | "both";
  language?: string;
  dark?: boolean;
  /** Real Frigate reviews and media through the dev proxy (harness only). */
  live?: boolean;
  /** Private snapshots by name (`llmvision`, `logbook`), used with `live`. */
  local?: (name: string) => unknown;
};

export type Mounted = {
  card: EventReelCard;
  /** The config the card was set up with. */
  config: CardConfig;
  /** The container the card is in. */
  stage: HTMLElement;
  data: ExampleData;
  /** Sets a new `hass` with another language or theme, as the harness's controls do. */
  setHass(opts: { language?: string; dark?: boolean }): void;
  /** Lets a source in `hold` answer its requests, now and from then on. */
  release(source: string): void;
  /** Changes an entity's state (a live change), keeping its attributes. */
  setState(entityId: string, state: string): void;
  remove(): void;
};

/** The sources `slow` can hold back, by the request that fetches them. */
const slowKeys: Record<string, string> = {
  entity: "logbook/get_events",
  llmvision: "call_service:llmvision.get_events",
  event_reel: "event_reel/events/list",
  frigate: "frigate/reviews/get",
  nest: "media_source/browse_media",
  history: "history/history_during_period",
};

/** Parses the harness's `?slow=frigate:5,llmvision:hang` (a source alone means 5 s). */
export function parseSlow(value: string | null): Record<string, number | "hang"> {
  const out: Record<string, number | "hang"> = {};
  for (const part of (value ?? "").split(",").filter(Boolean)) {
    const [source, seconds] = part.split(":");
    out[source] = seconds === "hang" ? "hang" : Number(seconds || 5);
  }
  return out;
}

export async function mountCard(opts: MountOptions = {}): Promise<Mounted> {
  if (opts.now !== undefined) {
    const t = typeof opts.now === "number" ? opts.now : Date.parse(opts.now) / 1000;
    clock.now = () => t;
  }
  const live = !!opts.live;
  const aiSource = opts.ai ?? "llmvision";
  const withLlmVision = aiSource !== "event_reel";
  const withEventReel = aiSource === "event_reel" || aiSource === "both";
  const now = clock.now();
  const local = opts.local ?? (() => undefined);
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

  let states: Record<string, HassEntity> = {};
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
  states["person.sam"] = st("person.sam", "home", { friendly_name: "Sam" });
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

  /** A websocket message field as text: the mock only gets strings and numbers. */
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

  const inRange = (t: number, msg: Record<string, unknown>) =>
    t >= Number(msg.after ?? -Infinity) && t <= Number(msg.before ?? Infinity);

  const handlers: Record<string, WsHandler> = {
    "call_service:llmvision.get_events": () => ({
      response: {
        events:
          (live ? (local("llmvision") as typeof data.llmvision | undefined) : undefined) ??
          data.llmvision,
      },
    }),
    "event_reel/events/list": (msg) => {
      const start = msg.start_time ? Date.parse(text(msg.start_time)) / 1000 : -Infinity;
      const end = msg.end_time ? Date.parse(text(msg.end_time)) / 1000 : Infinity;
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
          after: text(msg.after),
          before: text(msg.before),
          limit: text(msg.limit ?? 200),
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
      const start = Date.parse(text(msg.start_time)) / 1000;
      const end = Date.parse(text(msg.end_time)) / 1000;
      const entries =
        (live ? (local("logbook") as typeof data.logbook | undefined) : undefined) ?? data.logbook;
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
  for (const [source, seconds] of Object.entries(opts.slow ?? {})) {
    const key = slowKeys[source];
    const inner = key ? handlers[key] : undefined;
    if (!key || !inner) continue;
    handlers[key] = (msg) =>
      seconds === "hang"
        ? new Promise(() => undefined)
        : new Promise((resolve) => setTimeout(() => resolve(inner(msg)), seconds * 1000));
  }
  const gates = new Map<string, () => void>();
  for (const source of opts.hold ?? []) {
    const key = slowKeys[source];
    const inner = key ? handlers[key] : undefined;
    if (!key || !inner) continue;
    const gate = new Promise<void>((resolve) => gates.set(source, resolve));
    handlers[key] = async (msg) => {
      await gate;
      return inner(msg);
    };
  }

  if (live) {
    // Real Frigate camera names come from live data at runtime; nothing private is committed.
    const reviews = (await (
      await fetch(`/frigate-api/review?after=${now - 86400}&before=${now}&limit=500`)
    ).json()) as { camera: string }[];
    for (const name of new Set(reviews.map((r) => r.camera))) frigateCamera(name);
  }

  const stage = document.createElement("div");
  if (opts.width !== undefined) stage.style.width = `${opts.width}px`;
  (opts.parent ?? document.body).appendChild(stage);

  const card = document.createElement("event-reel-card") as EventReelCard;
  const config: CardConfig = {
    type: "custom:event-reel-card",
    title: "Today's events",
    density: "compact",
    entities: [
      {
        entity: "lock.front_door",
        name: "Front door",
        actor_attribute: "changed_by",
        camera: "camera.entrance",
      },
      { entity: "binary_sensor.front_door", name: "Front door", camera: "camera.entrance" },
      "person.alex",
    ],
    ...(withLlmVision ? { llmvision: { non_camera: false } } : {}),
    context: [
      { entity: "input_boolean.away", label: "Away" },
      { entity: "sun.sun", state: "below_horizon", label: "Dark" },
    ],
    presence: true,
    ...opts.config,
  };
  card.setConfig(config);
  stage.appendChild(card);

  let language = opts.language ?? "en";
  let dark = !!opts.dark;
  const setHass = (next: { language?: string; dark?: boolean }) => {
    language = next.language ?? language;
    dark = next.dark ?? dark;
    const hass = createMockHass({ language, darkMode: dark, states, handlers });
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
  };
  setHass({});

  return {
    card,
    config,
    stage,
    data,
    setHass,
    release: (source) => gates.get(source)?.(),
    setState: (entityId, state) => {
      // A new object, so the card sees the change against the previous hass.
      const old = states[entityId] as HassEntity | undefined;
      const at = new Date(clock.now() * 1000).toISOString();
      states = {
        ...states,
        [entityId]: { ...st(entityId, state, old?.attributes), last_changed: at, last_updated: at },
      };
      setHass({});
    },
    remove: () => stage.remove(),
  };
}
