import type { HomeAssistant } from "./ha-types";
import type { CameraRegistry } from "./core/cameras";
import type { NormalizedConfig } from "./config";

export type Category =
  | "person"
  | "vehicle"
  | "animal"
  | "package"
  | "doorbell"
  | "motion"
  | "door"
  | "lock"
  | "presence"
  | "alarm"
  | "calendar"
  | "custom";

export type MediaRef = {
  kind: "hls" | "mp4" | "image" | "gif";
  /** HA-relative path (signed when it starts with /api/ or /media/), a full URL, or a media-source id. */
  path: string;
  /** True for media-source ids, which `media_source/resolve_media` turns into a signed URL. */
  resolve?: boolean;
};

export type FrigateRef = {
  instance: string;
  camera: string;
  reviewId?: string;
};

export type ExtraText = {
  start: number;
  title: string;
  description?: string;
};

export type ReelEvent = {
  /** `${provider}:${nativeId}` */
  id: string;
  provider: string;
  /** Providers that contributed after merging, e.g. ["llmvision", "frigate"]. */
  sources: string[];
  /** Other ids that should resolve to this event (deep links), e.g. merged LLM Vision uids. */
  aliases?: string[];
  /** Epoch seconds. */
  start: number;
  /** Epoch seconds; undefined while ongoing or for instants. */
  end?: number;
  title: string;
  /** For state changes: the localized new state, shown after the title. */
  stateLabel?: string;
  description?: string;
  /** More AI descriptions merged into the same media event. */
  extra?: ExtraText[];
  category: Category;
  icon?: string;
  /** Source entity for entity events. */
  entityId?: string;
  /** Raw new state for entity events. */
  state?: string;
  /** Canonical camera key: the HA camera entity id. */
  camera?: string;
  /** Display name for a camera that could not be mapped to an HA camera entity. */
  cameraLabel?: string;
  /** Stills, in fallback order. */
  thumbnail?: MediaRef[];
  /** Animated previews (mp4/gif), in fallback order. */
  preview?: MediaRef[];
  /** A fixed exact clip (Nest). Frigate clips are built from `frigate` when opened. */
  clip?: MediaRef;
  frigate?: FrigateRef;
  labels?: string[];
  people?: string[];
  /** Frigate GenAI threat level: 1 "Needs review", 2 "Security concern" (0 shows nothing). */
  threat?: 1 | 2;
  /** Frigate GenAI "other concerns" the model observed; omitted when empty. */
  concerns?: string[];
  severity?: "alert" | "detection" | "info" | "warning";
  reviewed?: boolean;
  /** Who or what caused it, when cheaply known. */
  actor?: string;
  raw?: unknown;
};

export type TimeRange = {
  start: number;
  end: number;
};

export type Localize = (key: string, params?: Record<string, string | number>) => string;

export type ProviderContext = {
  hass: HomeAssistant;
  config: NormalizedConfig;
  cameras: CameraRegistry;
  localize: Localize;
  now: number;
};

export type Provider = {
  readonly type: string;
  fetch(range: TimeRange, ctx: ProviderContext): Promise<ReelEvent[]>;
  /** Events derived from a hass update (instant updates); reconciled on the next fetch. */
  live?(prev: HomeAssistant, next: HomeAssistant, ctx: ProviderContext): ReelEvent[];
  /** Subscribe to push updates; call onChange to request a refetch. Returns an unsubscribe. */
  subscribe?(ctx: ProviderContext, onChange: () => void): () => void;
};
