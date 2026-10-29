// What the card's templates (list.ts, detail.ts, toolbar.ts) read from the card in one
// render, and the actions their controls call. The templates render into the card's shadow
// root, so the card's styles apply, and they keep no state of their own.

import type { NormalizedConfig } from "../config";
import type { Capabilities } from "../core/capabilities";
import type { ContextBand } from "../core/context";
import type { FilterState } from "../core/filters";
import type { Presence } from "../core/presence";
import type { TimelineItem } from "../core/grouping";
import type { MediaResolver } from "../core/media";
import { formatTime } from "../core/time";
import type { TimeFormatOptions } from "../core/time";
import type { Category, Localize, ReelEvent, TimeRange } from "../types";

export interface CardView {
  t: Localize;
  config: NormalizedConfig;
  resolver: MediaResolver;
  timeOpts: TimeFormatOptions;
  tz: string;
  /** The card's clock (epoch seconds), which the dev harness can pin. */
  now: () => number;
  /** The calendar day shown (YYYY-MM-DD); undefined shows the configured range up to now. */
  day?: string;
  loaded: boolean;
  caps?: Capabilities;
  errors: Map<string, "unavailable" | "missing">;
  /** Time of the newest event before the range, shown when the range is empty. */
  lastEarlier?: number;
  bands: ContextBand[];
  /** Who was home over the view; undefined when presence is off. */
  presence?: Presence;
  filter: FilterState;
  /** Names of cameras seen in the camera menu, for keeping the active one listed. */
  cameraNames: Map<string, string>;
  openId?: string;
  openGroups: Set<string>;
  highlight?: string;
  stripCursor?: string;
  /** A burst member opened by a deep link, highlighted inside the expanded burst. */
  linkedEvent?: string;
  /** The range on screen, undefined before the first refresh. The live range runs to now. */
  viewRange(): TimeRange | undefined;
  cameraName(e: ReelEvent): string | undefined;
  /** Whether `e` is the open row or the last one reached, also after a merge renamed it. */
  isReached(e: ReelEvent): boolean;
  toggle(id: string): void;
  toggleGroup(id: string): void;
  toggleCategory(c: Category): void;
  toggleBand(key: string): void;
  setCamera(key: string): void;
  markReviewed(events: ReelEvent[]): void;
  moreInfo(entityId: string): void;
  stripSelect(ev: CustomEvent<{ position: number; id?: string }>, items: TimelineItem[]): void;
  navTo(day: string | undefined): void;
  previousDay(): void;
  nextDay(): void;
}

/** A time of day in the card's locale and time zone. */
export const time = (view: CardView, epoch: number) => formatTime(epoch, view.timeOpts);
