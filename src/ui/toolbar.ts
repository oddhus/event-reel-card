// What sits above the list: day navigation, warning chips, the filter bar (band, category
// and camera filters, mark all reviewed), the day strip and the band legend (§5.1, §5.6,
// §5.9).

import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { CATEGORY_COLORS, iconFor } from "../core/categories";
import { bandCounts } from "../core/context";
import { cameraOptions, itemEvents, summarize } from "../core/filters";
import type { TimelineItem } from "../core/grouping";
import { stripModel } from "../core/strip";
import { dayKey, dayRange, formatDay, formatTime, shiftDay } from "../core/time";
import { time } from "./view";
import type { CardView } from "./view";

export function renderDayNav(view: CardView) {
  if (!view.config.dayNavigation) return nothing;
  const t = view.t;
  const tz = view.tz;
  const today = dayKey(view.now(), tz);
  const day = view.day;
  const range = view.config.range;
  const label = !day
    ? range.kind === "today"
      ? t("nav.today")
      : t("nav.last_hours", { hours: range.hours })
    : day === shiftDay(today, -1)
      ? t("nav.yesterday")
      : formatDay(dayRange(day, tz).start, view.timeOpts);
  return html`<div class="daynav" role="group" aria-label=${t("nav.label")}>
    <span class="daylabel" aria-live="polite">${label}</span>
    ${
      day
        ? html`<button class="linkish today" @click=${() => view.navTo(undefined)}>
            ${t("nav.today")}
          </button>`
        : nothing
    }
    <button
      class="navbtn prev"
      title=${t("nav.previous_day")}
      aria-label=${t("nav.previous_day")}
      @click=${() => view.previousDay()}
    >
      <ha-icon icon="mdi:chevron-left"></ha-icon>
    </button>
    <button
      class="navbtn"
      title=${t("nav.next_day")}
      aria-label=${t("nav.next_day")}
      ?disabled=${!day}
      @click=${() => view.nextDay()}
    >
      <ha-icon icon="mdi:chevron-right"></ha-icon>
    </button>
  </div>`;
}

export function renderWarnings(view: CardView) {
  const t = view.t;
  if (!view.errors.size) return nothing;
  return html`<div class="warnings" role="status">
    ${[...view.errors].map(
      ([type, kind]) =>
        html`<span class="warning"
          ><ha-icon icon="mdi:alert-circle-outline"></ha-icon>${t(
            kind === "missing" ? "warning.missing" : "warning.unavailable",
            { provider: t(`provider.${type}`) },
          )}</span
        >`,
    )}
  </div>`;
}

export function renderToolbar(view: CardView, items: TimelineItem[], filtered: TimelineItem[]) {
  const t = view.t;
  const cfg = view.config;
  const unreviewed = filtered
    .flatMap(itemEvents)
    .filter((e) => e.frigate?.reviewId && e.reviewed === false);
  const active = view.filter.categories;
  const counts = cfg.filters ? summarize(items) : [];
  // An active chip stays visible (at 0) so it can be switched off.
  for (const c of active) {
    if (!counts.some((x) => x.category === c)) counts.push({ category: c, count: 0 });
  }
  const cams = cfg.filters ? cameraOptions(items, (key, e) => view.cameraName(e) ?? key) : [];
  const camera = view.filter.camera;
  if (camera && !cams.some((o) => o.key === camera)) {
    cams.push({ key: camera, name: view.cameraNames.get(camera) ?? camera, count: 0 });
  }
  for (const o of cams) view.cameraNames.set(o.key, o.name);
  const showCams = cams.length > 1 || !!camera;
  const picked = view.filter.bands ?? new Set<string>();
  const bandCount = bandCounts(items, view.bands);
  // A band shows when it falls in the view, also with no rows (its color still needs a
  // name), or when it is picked, so it can be switched off.
  const bandChips = cfg.filters
    ? view.bands.filter((b) => b.intervals.length || picked.has(b.key))
    : [];
  if (!counts.length && !showCams && !unreviewed.length && !bandChips.length) return nothing;
  const markLabel = t("action.mark_all_reviewed_n", { count: unreviewed.length });
  return html`<div class="toolbar">
    <div class="chipbar" role="group" aria-label=${t("filter.label")}>
      ${bandChips.map(
        (b) =>
          html`<button
            class="fchip bandchip"
            aria-pressed=${picked.has(b.key) ? "true" : "false"}
            title=${t("filter.band", { label: b.label })}
            style="--c:${b.color}"
            @click=${() => view.toggleBand(b.key)}
          >
            <span class="swatch"></span>
            <span>${b.label}</span>
            <span class="n">${bandCount.get(b.key) ?? 0}</span>
          </button>`,
      )}
      ${counts.map(
        (c) =>
          html`<button
            class="fchip"
            aria-pressed=${active.has(c.category) ? "true" : "false"}
            style="--c:${CATEGORY_COLORS[c.category]}"
            @click=${() => view.toggleCategory(c.category)}
          >
            <ha-icon .icon=${iconFor({ category: c.category })}></ha-icon>
            <span>${t(`category.${c.category}`)}</span>
            <span class="n">${c.count}</span>
          </button>`,
      )}
    </div>
    ${
      showCams
        ? html`<select
            class="camsel"
            aria-label=${t("filter.camera")}
            .value=${live(camera ?? "")}
            @change=${(ev: Event) => view.setCamera((ev.target as HTMLSelectElement).value)}
          >
            <option value="">${t("filter.all_cameras")}</option>
            ${cams.map((o) => html`<option value=${o.key}>${o.name} (${o.count})</option>`)}
          </select>`
        : nothing
    }
    ${
      unreviewed.length
        ? html`<button
            class="markall"
            title=${markLabel}
            aria-label=${markLabel}
            @click=${() => view.markReviewed(unreviewed)}
          >
            <ha-icon icon="mdi:check-all"></ha-icon><span class="n">${unreviewed.length}</span>
          </button>`
        : nothing
    }
  </div>`;
}

export function renderStrip(view: CardView, filtered: TimelineItem[]) {
  if (!view.config.dayStrip || !view.loaded) return nothing;
  const range = view.viewRange();
  if (!range) return nothing;
  const model = stripModel(filtered, range, view.tz, 6, view.bands);
  const opts = view.timeOpts;
  return html`<event-reel-strip
    .model=${model}
    .labels=${model.marks.map((m) => formatTime(m.epoch, opts))}
    .selected=${view.highlight}
    .cursor=${view.stripCursor}
    .label=${view.t("strip.label")}
    .valueText=${stripValueText(view, filtered)}
    .live=${!view.day}
    @strip-select=${(ev: CustomEvent<{ position: number; id?: string }>) =>
      view.stripSelect(ev, filtered)}
  ></event-reel-strip>`;
}

/** Without the filter chips, which name the bands, a legend says what the colors mean. */
export function renderLegend(view: CardView) {
  if (view.config.filters) return nothing;
  const bands = view.bands.filter((b) => b.intervals.length);
  if (!bands.length) return nothing;
  return html`<div class="legend">
    ${bands.map(
      (b) => html`<span style="--c:${b.color}"><span class="swatch"></span>${b.label}</span>`,
    )}
  </div>`;
}

function stripValueText(view: CardView, items: TimelineItem[]): string {
  const id = view.stripCursor ?? view.highlight;
  const item = items.find((i) => i.id === id);
  if (!item) return "";
  const e = itemEvents(item)[itemEvents(item).length - 1];
  return `${time(view, item.sortTime)} ${e.title}${e.stateLabel ? ` ${e.stateLabel}` : ""}`;
}
