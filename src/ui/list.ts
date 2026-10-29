// The timeline list: hour separators, event rows, bursts and camera groups (§5.2, §5.3),
// and the empty states (§5.9).

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { hasSource } from "../core/capabilities";
import { CATEGORY_COLORS, iconFor } from "../core/categories";
import { bandAt } from "../core/context";
import { capList } from "../core/filters";
import { homeDuring, whileNobodyHome } from "../core/presence";
import type { BurstSegment, TimelineItem } from "../core/grouping";
import { highestThreat, withFlagged } from "../core/threat";
import { dayKey, formatDay, formatDuration, formatTime, hourStart, shiftDay } from "../core/time";
import type { ReelEvent } from "../types";
import { detailId, renderDetail } from "./detail";
import { time } from "./view";
import type { CardView } from "./view";

/** The README's configuration section, linked from the empty state when no source is set up. */
const SETUP_URL = "https://github.com/oddhus/event-reel-card#configuration";

const hasMedia = (e: ReelEvent) =>
  !!(e.camera || e.cameraLabel || e.preview?.length || e.thumbnail?.length || e.clip);

function metaParts(view: CardView, e: ReelEvent): string[] {
  const t = view.t;
  const parts: string[] = [];
  const cam = view.cameraName(e);
  if (cam) parts.push(cam);
  if (e.end !== undefined && e.end > e.start && (e.camera || e.frigate)) {
    parts.push(formatDuration(e.end - e.start, t));
  } else if (e.frigate && e.end === undefined) {
    parts.push(t("meta.ongoing"));
  }
  if (e.people?.length) parts.push(e.people.join(", "));
  if (e.actor) parts.push(t("meta.by", { actor: e.actor }));
  return parts;
}

function media(view: CardView, e: ReelEvent, icon: string) {
  if (!hasMedia(e) || view.config.preview === "off") {
    return html`<span class="slot"
      ><span class="disc" style="--c:${CATEGORY_COLORS[e.category]}"
        ><ha-icon .icon=${icon}></ha-icon></span
    ></span>`;
  }
  return html`<span class="slot"
    ><event-reel-preview
      class="thumb"
      .resolver=${view.resolver}
      .thumbnail=${e.thumbnail}
      .preview=${e.preview}
      .mode=${view.config.preview}
      .icon=${icon}
    ></event-reel-preview
  ></span>`;
}

/** A row's band edge and its text for screen readers, by the time the row shows. */
function bandMark(view: CardView, times: number[]) {
  const band = bandAt(view.bands, times);
  return band
    ? {
        cls: "inband",
        style: `--band:${band.color}`,
        text: html`<span class="sr-only"> · ${band.label}</span>`,
      }
    : { cls: "", style: "", text: nothing };
}

/** Initials shown on a row before the rest become a count. */
const MAX_INITIALS = 3;

/**
 * Who was home at a row's events (§5.10), in a column before the dot: their initials, or a
 * house with a cross when one of the events happened while nobody was. A group can show
 * both: someone came home during it.
 */
function presenceCell(view: CardView, events: ReelEvent[]) {
  const p = view.presence;
  if (!p) return nothing;
  const t = view.t;
  const people = homeDuring(p, events);
  const empty = events.some((e) => whileNobodyHome(p, e));
  const label = t("presence.home", { names: people.map((x) => x.name).join(", ") });
  const nobody = t("presence.nobody_home");
  // At most three chips, so a phone-width row keeps its title: with more people, two
  // initials and a count. The label names everyone.
  const shown = people.length > MAX_INITIALS ? people.slice(0, MAX_INITIALS - 1) : people;
  const more = people.length - shown.length;
  return html`<span class="home"
    >${
      empty
        ? html`<ha-icon
            class="nobody"
            role="img"
            title=${nobody}
            aria-label=${nobody}
            .icon=${"mdi:home-off-outline"}
          ></ha-icon>`
        : nothing
    }${
      people.length
        ? html`<span class="who" role="img" title=${label} aria-label=${label}
            >${shown.map((x) => html`<span class="initial">${x.initials}</span>`)}${
              more ? html`<span class="initial more">+${more}</span>` : nothing
            }</span
          >`
        : nothing
    }</span
  >`;
}

function eventRow(
  view: CardView,
  e: ReelEvent,
  opts: {
    time?: number;
    badge?: string;
    meta?: string[];
    groupId?: string;
    threat?: 1 | 2;
    /** Start times of a group's events, for its band edge. */
    times?: number[];
    /** A group's events, for who was home. */
    events?: ReelEvent[];
  } = {},
) {
  const t = view.t;
  const open = !opts.groupId && view.openId === e.id;
  const icon = iconFor(e);
  const threat = opts.threat ?? e.threat;
  // Before the title on wide rows, at the start of the camera/duration line on narrow ones
  // (CSS), so the title stays readable.
  const threatBadge = threat
    ? html`<span class="badge threat-${threat}">${t(`threat.${threat}`)}</span>`
    : nothing;
  const meta = (opts.meta ?? metaParts(view, e)).join(" · ");
  const comfortable = view.config.density === "comfortable";
  const onClick = opts.groupId ? () => view.toggleGroup(opts.groupId!) : () => view.toggle(e.id);
  const expanded = opts.groupId ? view.openGroups.has(opts.groupId) : open;
  const band = bandMark(view, opts.times ?? [e.start]);
  return html`
    <button
      class="row ${hasMedia(e) ? "camera" : "plain"} ${view.highlight === e.id && !opts.groupId ? "hl" : ""} ${band.cls} ${view.presence ? "presence" : ""}"
      style=${band.style}
      data-id=${opts.groupId ?? e.id}
      aria-expanded=${expanded ? "true" : "false"}
      aria-controls=${open ? detailId(e.id) : nothing}
      @click=${onClick}
    >
      <span class="time">${time(view, opts.time ?? e.start)}</span>
      ${media(view, e, icon)}
      <span class="main">
        <span class="title"
          >${opts.badge ? html`<span class="badge">${opts.badge}</span>` : nothing}${threatBadge}${e.title}${
            e.stateLabel
              ? html`<span class="state">${e.title ? " · " : ""}${e.stateLabel}</span>`
              : nothing
          }</span
        >
        ${comfortable && e.description ? html`<span class="desc">${e.description}</span>` : nothing}
        ${meta || threat ? html`<span class="sub">${threatBadge}${meta}</span>` : nothing}
        ${band.text}
      </span>
      <span class="meta">${meta}</span>
      ${presenceCell(view, opts.events ?? [e])}
      ${
        e.frigate && e.reviewed === false
          ? html`<span
              class="dot"
              role="img"
              title=${t("meta.unreviewed")}
              aria-label=${t("meta.unreviewed")}
            ></span>`
          : html`<span class="dot-space"></span>`
      }
    </button>
    ${open ? renderDetail(view, e) : nothing}
  `;
}

function segmentsText(segments: BurstSegment[]): string {
  return segments
    .map(
      (s) =>
        (s.name ? `${s.name}: ` : "") +
        s.steps.map((st) => (st.count > 1 ? `${st.label} ×${st.count}` : st.label)).join(" · "),
    )
    .join("; ");
}

function renderItem(view: CardView, item: TimelineItem): TemplateResult {
  const t = view.t;
  if (item.kind === "event") {
    return html`<div class="item ${view.highlight === item.id ? "highlight" : ""}" role="listitem">
      ${eventRow(view, item.event)}
    </div>`;
  }

  if (item.kind === "burst") {
    const first = item.events[0];
    const last = item.events[item.events.length - 1];
    const open = view.openGroups.has(item.id);
    const icon = iconFor(last);
    const burstBand = bandMark(
      view,
      item.events.map((x) => x.start),
    );
    return html`<div class="item ${view.highlight === item.id ? "highlight" : ""}" role="listitem">
      <button
        class="row plain ${burstBand.cls} ${view.presence ? "presence" : ""}"
        style=${burstBand.style}
        data-id=${item.id}
        aria-expanded=${open ? "true" : "false"}
        @click=${() => view.toggleGroup(item.id)}
      >
        <span class="time">${time(view, item.sortTime)}</span>
        <span class="slot"
          ><span class="disc" style="--c:${CATEGORY_COLORS[first.category]}"
            ><ha-icon .icon=${icon}></ha-icon></span
        ></span>
        <span class="main">
          <span class="title">${segmentsText(item.segments)}</span>
          <span class="sub">${time(view, item.start)}–${time(view, item.end)}</span>
          ${burstBand.text}
        </span>
        <span class="meta">${time(view, item.start)}–${time(view, item.end)}</span>
        ${presenceCell(view, item.events)}
        <span class="dot-space"></span>
      </button>
      ${
        open
          ? html`<div class="steps">
              ${item.events.map(
                (e) =>
                  html`<div class="step ${e.id === view.linkedEvent ? "highlight" : ""}">
                    <span class="time">${time(view, e.start)}</span>
                    <ha-icon .icon=${iconFor(e)}></ha-icon>
                    <span>${e.title}${e.stateLabel ? ` · ${e.stateLabel}` : ""}</span>
                    ${e.actor ? html`<span class="muted">${t("meta.by", { actor: e.actor })}</span>` : nothing}
                  </div>`,
              )}
            </div>`
          : nothing
      }
    </div>`;
  }

  // Camera group: the newest event stands for the group.
  const newest = item.events[item.events.length - 1];
  const open = view.openGroups.has(item.id);
  const cam = view.cameraName(newest);
  const meta = [cam, `${time(view, item.start)}–${time(view, item.end)}`].filter(
    Boolean,
  ) as string[];
  return html`<div
    class="item group ${view.highlight === item.id ? "highlight" : ""}"
    role="listitem"
  >
    ${eventRow(view, newest, {
      time: item.sortTime,
      badge: t("group.count", { count: item.events.length }),
      threat: highestThreat(item.events),
      times: item.events.map((x) => x.start),
      events: item.events,
      meta,
      groupId: item.id,
    })}
    ${open ? groupChildren(view, item.events) : nothing}
  </div>`;
}

/**
 * An open camera group's events, newest first, capped like the list. The cap never hides
 * an event with a threat level, since the group row shows the highest one.
 */
function groupChildren(view: CardView, events: ReelEvent[]) {
  const newestFirst = [...events].reverse();
  const children = withFlagged(
    newestFirst,
    capList(
      newestFirst,
      view.config.maxEvents,
      () => 1,
      (e) => view.isReached(e),
    ),
  );
  return html`<div class="children">
    ${repeat(
      // Keyed, so an open clip keeps playing when a newer event joins the group.
      children.list,
      (e) => e.id,
      (e) => html`<div class="child">${eventRow(view, e)}</div>`,
    )}
    ${children.hidden ? cappedNote(view, children.hidden) : nothing}
  </div>`;
}

export function cappedNote(view: CardView, hidden: number) {
  return html`<p class="capped" role="note">
    ${view.t("list.capped", { count: hidden, max: view.config.maxEvents })}
  </p>`;
}

export function renderList(view: CardView, items: TimelineItem[]) {
  const tz = view.tz;
  const opts = view.timeOpts;
  // Label days other than the one in view (today, or the day shown).
  const today = view.day ?? dayKey(view.now(), tz);
  const entries: { key: string; tpl: TemplateResult }[] = [];
  let lastHour: number | undefined;
  let lastDay: string | undefined;
  for (const item of items) {
    const hour = hourStart(item.sortTime, tz);
    if (hour !== lastHour) {
      const day = dayKey(item.sortTime, tz);
      const showDay = day !== lastDay && (lastDay !== undefined || day !== today);
      entries.push({
        key: `sep:${hour}`,
        tpl: html`<div class="sep" role="presentation">
          ${showDay ? html`<span class="day">${formatDay(item.sortTime, opts)}</span>` : nothing}
          <span>${formatTime(hour, opts)}</span>
        </div>`,
      });
      lastHour = hour;
      lastDay = day;
    }
    entries.push({ key: item.id, tpl: renderItem(view, item) });
  }
  return repeat(
    entries,
    (e) => e.key,
    (e) => e.tpl,
  );
}

/** The empty range, or how to set up a card that has nothing to read from. */
export function renderEmpty(view: CardView) {
  const t = view.t;
  if (view.caps && !hasSource(view.config, view.caps)) {
    return html`<div class="empty" role="status">
      <div>${t("empty.setup")}</div>
      <div class="muted">
        ${t("empty.setup_hint")}
        <a href=${SETUP_URL} target="_blank" rel="noopener">${t("empty.setup_link")}</a>
      </div>
    </div>`;
  }
  const range = view.config.range;
  const text = view.day
    ? view.day === shiftDay(dayKey(view.now(), view.tz), -1)
      ? t("empty.yesterday")
      : t("empty.day")
    : range.kind === "today"
      ? t("empty.today")
      : t("empty.rolling", { hours: range.hours });
  const last = view.lastEarlier;
  const opts = view.timeOpts;
  return html`<div class="empty" role="status">
    <div>${text}</div>
    ${
      last
        ? html`<div class="muted">
            ${t("empty.last", { when: `${formatDay(last, opts)} ${formatTime(last, opts)}` })}
          </div>`
        : nothing
    }
  </div>`;
}
