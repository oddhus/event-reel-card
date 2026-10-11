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
  cameraAliases: Record<string, string>;
  cameras: Record<string, CameraOverride>;
  groupingWindow: number;
  merge: { before: number; after: number };
  filters: boolean;
  dayStrip: boolean;
  dayNavigation: boolean;
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

  const llm = obj<LlmVisionConfig>(config.llmvision);
  const frig = obj<FrigateConfig>(config.frigate);
  const padding = Array.isArray(frig.clip_padding) ? frig.clip_padding : [];

  return {
    title: typeof config.title === "string" ? config.title : "",
    density: oneOf(config.density, ["compact", "comfortable"] as const, "compact"),
    range: parseRange(config.range ?? "24h"),
    preview: oneOf(config.preview, ["visible", "hover", "still", "off"] as const, "visible"),
    maxEvents: num(config.max_events, 200, 1),
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
    cameraAliases: obj<Record<string, string>>(config.camera_aliases) as Record<string, string>,
    cameras: obj<Record<string, CameraOverride>>(config.cameras) as Record<string, CameraOverride>,
    groupingWindow: num(config.grouping?.window, 120),
    merge: { before: num(config.merge?.before, 15), after: num(config.merge?.after, 30) },
    filters: config.filters !== false,
    dayStrip: config.day_strip !== false,
    dayNavigation: config.day_navigation !== false,
  };
}
