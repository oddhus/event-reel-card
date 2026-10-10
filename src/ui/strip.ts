// The day strip: a thin overview of the visible range with one tick per row and a faint
// hourly histogram. Tap or drag to jump the list to that time (§5.1).

import { LitElement, css, html, nothing } from "lit";
import { CATEGORY_COLORS } from "../core/categories";
import type { StripModel } from "../core/strip";

/** Pixels a touch may move before it counts as a drag rather than a tap. */
const TOUCH_SLOP = 8;

export class EventReelStrip extends LitElement {
  static override properties = {
    model: { attribute: false },
    labels: { attribute: false },
    selected: {},
    label: {},
    valueText: {},
  };

  declare model?: StripModel;
  /** Text for each mark, same order as model.marks. */
  declare labels?: string[];
  /** Id of the highlighted tick. */
  declare selected?: string;
  /** Accessible name of the slider. */
  declare label?: string;
  /** Spoken value: the time of the selected row. */
  declare valueText?: string;

  private dragging = false;
  private frame = 0;
  private lastX = 0;

  private fire(detail: { position: number; id?: string }) {
    this.dispatchEvent(new CustomEvent("strip-select", { detail, bubbles: true, composed: true }));
  }

  /** At most one selection per animation frame while dragging. */
  private emitAt(clientX: number) {
    this.lastX = clientX;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const bar = this.renderRoot.querySelector(".bar") as HTMLElement | null;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      this.fire({ position: (this.lastX - rect.left) / rect.width });
    });
  }

  private start?: { x: number; y: number; touch: boolean };

  private onDown = (ev: PointerEvent) => {
    const touch = ev.pointerType === "touch";
    this.start = { x: ev.clientX, y: ev.clientY, touch };
    if (touch) return; // wait: this may be the start of a vertical scroll
    this.dragging = true;
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    this.emitAt(ev.clientX);
  };

  private onMove = (ev: PointerEvent) => {
    const s = this.start;
    if (!s) return;
    if (!this.dragging && s.touch) {
      const dx = Math.abs(ev.clientX - s.x);
      const dy = Math.abs(ev.clientY - s.y);
      if (dx > TOUCH_SLOP && dx > dy) {
        this.dragging = true;
        (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
      } else return;
    }
    if (this.dragging) this.emitAt(ev.clientX);
  };

  private onUp = (ev: PointerEvent) => {
    const s = this.start;
    // A tap on touch selects; a swipe that scrolled the page doesn't.
    if (s?.touch && !this.dragging && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < TOUCH_SLOP) {
      this.emitAt(ev.clientX);
    }
    this.dragging = false;
    this.start = undefined;
  };

  private onCancel = () => {
    this.dragging = false;
    this.start = undefined;
  };

  /** Arrow keys step through rows in time order; Home/End jump to the ends. */
  private onKey = (ev: KeyboardEvent) => {
    const ticks = [...(this.model?.ticks ?? [])].sort((a, b) => a.pos - b.pos);
    if (!ticks.length) return;
    const current = ticks.findIndex((t) => t.id === this.selected);
    let next: number | undefined;
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
      next = current < 0 ? ticks.length - 1 : Math.min(ticks.length - 1, current + 1);
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
      next = current < 0 ? ticks.length - 1 : Math.max(0, current - 1);
    } else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = ticks.length - 1;
    if (next === undefined) return;
    ev.preventDefault();
    this.fire({ position: ticks[next].pos, id: ticks[next].id });
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  protected override render() {
    const m = this.model;
    if (!m) return nothing;
    const max = Math.max(1, ...m.buckets);
    const width = 100 / m.buckets.length;
    return html`
      <div
        class="bar"
        role="slider"
        tabindex="0"
        aria-label=${this.label ?? ""}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${Math.round((m.ticks.find((t) => t.id === this.selected)?.pos ?? 1) * 100)}
        aria-valuetext=${this.valueText ?? ""}
        @keydown=${this.onKey}
        @pointerdown=${this.onDown}
        @pointermove=${this.onMove}
        @pointerup=${this.onUp}
        @pointercancel=${this.onCancel}
      >
        ${m.buckets.map((b, i) =>
          b
            ? html`<span
                class="hist"
                style="left:${i * width}%;width:${width}%;height:${Math.round((b / max) * 100)}%"
              ></span>`
            : nothing,
        )}
        ${m.marks.map((mark) => html`<span class="mark" style="left:${mark.pos * 100}%"></span>`)}
        ${m.ticks.map(
          (t) =>
            html`<span
              class="tick ${t.id === this.selected ? "selected" : ""}"
              style="left:${t.pos * 100}%;--c:${CATEGORY_COLORS[t.category]}"
            ></span>`,
        )}
        <span class="now"></span>
      </div>
      <div class="labels" aria-hidden="true">
        ${m.marks.map(
          (mark, i) =>
            html`<span class="label" style="left:${mark.pos * 100}%"
              >${this.labels?.[i] ?? ""}</span
            >`,
        )}
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
      padding: 4px 16px 0;
      user-select: none;
      -webkit-user-select: none;
    }
    .bar {
      position: relative;
      height: 28px;
      border-radius: 6px;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.1));
      overflow: hidden;
      cursor: pointer;
      touch-action: pan-y;
    }
    .bar:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
    .hist {
      position: absolute;
      bottom: 0;
      background: var(--primary-text-color);
      opacity: 0.07;
    }
    .mark {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--divider-color);
    }
    .tick {
      position: absolute;
      top: 6px;
      bottom: 6px;
      width: 3px;
      margin-left: -1.5px;
      border-radius: 2px;
      background: var(--c);
      opacity: 0.85;
    }
    .tick.selected {
      top: 2px;
      bottom: 2px;
      width: 5px;
      margin-left: -2.5px;
      opacity: 1;
      box-shadow: 0 0 0 2px var(--card-background-color, #fff);
    }
    .now {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      width: 2px;
      background: var(--primary-color);
    }
    .labels {
      position: relative;
      height: 14px;
    }
    .label {
      position: absolute;
      transform: translateX(-50%);
      font-size: 10px;
      line-height: 14px;
      color: var(--secondary-text-color);
      font-variant-numeric: tabular-nums;
    }
  `;
}

if (!customElements.get("event-reel-strip")) {
  customElements.define("event-reel-strip", EventReelStrip);
}
