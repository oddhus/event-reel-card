import type { Category } from "./types";
import { parseRange } from "./core/time";
import type { RangeSpec } from "./core/time";

export interface EntityConfig {
  entity: string;
  name?: string;
  icon?: string;
  category?: Category;
  states?: Record<string, string>;
  only_states?: string[];
  actor_attribute?: string;
}

/** A provider is "explicit" when the user configured it; only explicit providers warn when missing. */
interface ProviderToggle {
  enabled: boolean;
  explicit: boolean;
}

export interface LlmVisionConfig extends ProviderToggle {
  non_camera: boolean;
  categories: string[];
}

export interface FrigateConfig extends ProviderToggle {
  cameras: "auto" | string[];
  severity: string[];
  show_unmatched: boolean;
  hide_unconfirmed: boolean;
  clip_padding: [number, number];
}

export type NestConfig = ProviderToggle;

export type EventReelConfig = ProviderToggle;

/** A period to highlight, while an entity is in one of the states (§5.6). */
export interface ContextConfig {
  entity: string;
  /** Default "on". */
  state?: string | string[];
  label?: string;
  /** An HA color name (`red`, `indigo`…) or any CSS color. */
  color?: string;
}

export interface NormalizedContext {
  entity: string;
  states: string[];
  label?: string;
  color?: string;
}

/** A person (or device tracker) whose presence the rows show (§5.10). */
export interface PresenceConfig {
  entity: string;
  name?: string;
}

/** `people` empty: every `person` entity. */
export interface NormalizedPresence {
  people: PresenceConfig[];
}

/** The strip can't tell more bands apart. */
export const MAX_CONTEXT = 4;

export interface CameraOverride {
  clip?: "auto" | "preview";
  name?: string;
}

export interface CardConfig {
  type: string;
  title?: string;
  density?: "compact" | "comfortable";
  range?: string | number;
  preview?: "visible" | "hover" | "still" | "off";
  max_events?: number;
  language?: "auto" | string;
  refresh_interval?: number;
  entities?: (string | EntityConfig)[];
  llmvision?: boolean | Partial<Omit<LlmVisionConfig, "explicit">>;
  frigate?: boolean | Partial<Omit<FrigateConfig, "explicit">>;
  nest?: boolean | { enabled?: boolean };
  /** The Event Reel integration (AI descriptions). */
  event_reel?: boolean | { enabled?: boolean };
  camera_aliases?: Record<string, string>;
  cameras?: Record<string, CameraOverride>;
  grouping?: { window?: number };
  merge?: { before?: number; after?: number };
  /** Summary and filter chips (default true). */
  filters?: boolean;
  /** The 24 h overview bar (default true). */
  day_strip?: boolean;
  /** Buttons for the previous and next day (default true). */
  day_navigation?: boolean;
  /** Periods shaded on the strip and marked on rows, such as away mode or night. */
  context?: (string | ContextConfig)[];
  /** Who was home at each row, and a flag when nobody was: `true` for every person. */
  presence?: boolean | (string | PresenceConfig)[];
}

export interface NormalizedConfig {
  title: string;
  density: "compact" | "comfortable";
  range: RangeSpec;
  preview: "visible" | "hover" | "still" | "off";
  maxEvents: number;
  language: string;
  refreshInterval: number;
  entities: EntityConfig[];
  llmvision: LlmVisionConfig;
  frigate: FrigateConfig;
  nest: NestConfig;
  event_reel: EventReelConfig;
  cameraAliases: Record<string, string>;
  cameras: Record<string, CameraOverride>;
  groupingWindow: number;
  merge: { before: number; after: number };
  filters: boolean;
  dayStrip: boolean;
  dayNavigation: boolean;
  context: NormalizedContext[];
  /** Undefined when presence is off (the default). */
  presence?: NormalizedPresence;
}

function toggle(value: unknown): ProviderToggle {
  if (value === undefined || value === null) return { enabled: true, explicit: false };
  if (value === false) return { enabled: false, explicit: true };
  // An object may carry `enabled: false` (the GUI editor writes it to keep the options).
  if (typeof value === "object" && (value as { enabled?: unknown }).enabled === false) {
    return { enabled: false, explicit: true };
  }
  return { enabled: true, explicit: true };
}

function obj<T extends object>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function num(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= min ? n : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeConfig(config: CardConfig): NormalizedConfig {
  if (!config || typeof config !== "object") throw new Error("Invalid configuration");

  const entities: EntityConfig[] = [];
  // A plain string would otherwise be read letter by letter.
  if (config.entities != null && !Array.isArray(config.entities)) {
    throw new Error("`entities` must be a list");
  }
  for (const item of config.entities ?? []) {
    if (typeof item === "string") entities.push({ entity: item });
    else if (item && typeof item === "object" && typeof item.entity === "string")
      entities.push(item);
    else throw new Error("Each item under `entities` needs an entity id");
  }

  const context = normalizeContext(config.context);
  const llm = obj<LlmVisionConfig>(config.llmvision);
  const frig = obj<FrigateConfig>(config.frigate);
  const padding = Array.isArray(frig.clip_padding) ? frig.clip_padding : [];

  return {
    title: typeof config.title === "string" ? config.title : "",
    density: oneOf(config.density, ["compact", "comfortable"] as const, "compact"),
    range: parseRange(config.range ?? "24h"),
    preview: oneOf(config.preview, ["visible", "hover", "still", "off"] as const, "visible"),
    maxEvents: Math.round(num(config.max_events, 200, 1)),
    language: typeof config.language === "string" ? config.language : "auto",
    refreshInterval: num(config.refresh_interval, 60, 10),
    entities,
    llmvision: {
      ...toggle(config.llmvision),
      non_camera: llm.non_camera ?? true,
      categories: Array.isArray(llm.categories) ? llm.categories : [],
    },
    frigate: {
      ...toggle(config.frigate),
      cameras: Array.isArray(frig.cameras) ? frig.cameras : "auto",
      severity: Array.isArray(frig.severity) ? frig.severity : ["alert", "detection"],
      show_unmatched: frig.show_unmatched ?? true,
      hide_unconfirmed: frig.hide_unconfirmed ?? false,
      clip_padding: [num(padding[0], 10), num(padding[1], 20)],
    },
    nest: toggle(config.nest),
    event_reel: toggle(config.event_reel),
    cameraAliases: obj<Record<string, string>>(config.camera_aliases) as Record<string, string>,
    cameras: obj<Record<string, CameraOverride>>(config.cameras) as Record<string, CameraOverride>,
    groupingWindow: num(config.grouping?.window, 120),
    merge: { before: num(config.merge?.before, 15), after: num(config.merge?.after, 30) },
    filters: config.filters !== false,
    dayStrip: config.day_strip !== false,
    dayNavigation: config.day_navigation !== false,
    context,
    presence: normalizePresence(config.presence),
  };
}

/**
 * Home Assistant's entity id format (`valid_entity_id`): `domain.object_id` in lower case,
 * with no leading, trailing or double underscore. Written without lookbehind, which older
 * Safari can't parse.
 */
const ENTITY_ID = /^[\da-z]+(?:_[\da-z]+)*\.[\da-z]+(?:_[\da-z]+)*$/;

function normalizeContext(value: unknown): NormalizedContext[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("`context` must be a list");
  if (value.length > MAX_CONTEXT) {
    throw new Error(`\`context\` takes at most ${MAX_CONTEXT} entities`);
  }
  return value.map((item: unknown) => {
    const c = (typeof item === "string" ? { entity: item } : item) as ContextConfig | null;
    // One malformed id would make Home Assistant refuse the history of every band.
    if (!c || typeof c !== "object" || typeof c.entity !== "string" || !ENTITY_ID.test(c.entity)) {
      throw new Error("Each item under `context` needs an entity id, such as `input_boolean.away`");
    }
    const states = (Array.isArray(c.state) ? c.state : [c.state ?? "on"]).map(String);
    return {
      entity: c.entity,
      states,
      label: typeof c.label === "string" ? c.label : undefined,
      color: typeof c.color === "string" ? c.color : undefined,
    };
  });
}

function normalizePresence(value: unknown): NormalizedPresence | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) return { people: [] };
  if (!Array.isArray(value)) throw new Error("`presence` must be true or a list of people");
  if (!value.length) return undefined;
  return {
    people: value.map((item: unknown) => {
      const p = (typeof item === "string" ? { entity: item } : item) as PresenceConfig | null;
      // The ids go into the context bands' history call, which one malformed id would fail.
      if (
        !p ||
        typeof p !== "object" ||
        typeof p.entity !== "string" ||
        !ENTITY_ID.test(p.entity)
      ) {
        throw new Error("Each item under `presence` needs an entity id, such as `person.alex`");
      }
      return typeof p.name === "string" ? { entity: p.entity, name: p.name } : { entity: p.entity };
    }),
  };
}
