// Animated thumbnail: a still first, then a muted looping preview while the row is visible.
// At most MAX_PLAYING previews play at once, closest to the viewport centre first (§5.5).

import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues } from "lit";
import type { MediaResolver } from "../core/media";
import type { MediaRef } from "../types";

const MAX_PLAYING = 6;

export type PreviewMode = "visible" | "hover" | "still" | "off";

const motionAllowed = (): boolean => {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    ?.saveData;
  return !reduced && !saveData;
};

/** Decides which visible previews may play. */
class PreviewCoordinator {
  private visible = new Set<EventReelPreview>();
  private observer?: IntersectionObserver;
  private frame = 0;

  private ensureObserver() {
    this.observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as EventReelPreview;
          if (entry.isIntersecting) this.visible.add(el);
          else {
            this.visible.delete(el);
            el.setPlaying(false);
          }
          el.setVisible(entry.isIntersecting);
        }
        this.schedule();
      },
      { rootMargin: "200px 0px" },
    );
    return this.observer;
  }

  observe(el: EventReelPreview) {
    this.ensureObserver().observe(el);
  }

  unobserve(el: EventReelPreview) {
    this.observer?.unobserve(el);
    this.visible.delete(el);
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.pick();
    });
  }

  private pick() {
    const centre = window.innerHeight / 2;
    const candidates = [...this.visible]
      .filter((el) => el.wantsAutoplay())
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, d: Math.abs(r.top + r.height / 2 - centre) };
      })
      .sort((a, b) => a.d - b.d);
    candidates.forEach(({ el }, i) => el.setPlaying(i < MAX_PLAYING));
  }
}

const coordinator = new PreviewCoordinator();
if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => coordinator.schedule(), { passive: true, capture: true });
}

export class EventReelPreview extends LitElement {
  static override properties = {
    thumbnail: { attribute: false },
    preview: { attribute: false },
    mode: {},
    icon: {},
    _still: { state: true },
    _video: { state: true },
    _playing: { state: true },
  };

  declare resolver?: MediaResolver;
  declare thumbnail?: MediaRef[];
  declare preview?: MediaRef[];
  declare mode: PreviewMode;
  declare icon?: string;
  declare _still?: string;
  declare _video?: string;
  declare _playing: boolean;

  private visible = false;
  private hovered = false;
  private stillIndex = 0;
  private retried = new Set<string>();
  private videoFailed = false;

  constructor() {
    super();
    this.mode = "visible";
    this._playing = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    coordinator.observe(this);
    this.addEventListener("pointerenter", this.onEnter);
    this.addEventListener("pointerleave", this.onLeave);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    coordinator.unobserve(this);
    this.removeEventListener("pointerenter", this.onEnter);
    this.removeEventListener("pointerleave", this.onLeave);
  }

  private mediaKey = "";

  protected override willUpdate(changed: PropertyValues) {
    if (!changed.has("thumbnail") && !changed.has("preview")) return;
    // New arrays with the same media (a refresh) must not reset what is already showing.
    const key = [...(this.thumbnail ?? []), ...(this.preview ?? [])].map((r) => r.path).join("|");
    if (key === this.mediaKey) return;
    this.mediaKey = key;
    this.stillIndex = 0;
    this.videoFailed = false;
    this.retried.clear();
    this._still = undefined;
    this._video = undefined;
    this._playing = false;
    if (this.visible) void this.load();
    coordinator.schedule();
  }

  private onEnter = () => {
    this.hovered = true;
    if (this.mode === "hover" && motionAllowed()) this.setPlaying(true);
  };

  private onLeave = () => {
    this.hovered = false;
    if (this.mode === "hover") this.setPlaying(false);
  };

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && !this._still) void this.load();
  }

  wantsAutoplay(): boolean {
    return (
      this.mode === "visible" && !!this.preview?.length && !this.videoFailed && motionAllowed()
    );
  }

  setPlaying(playing: boolean) {
    if (playing && (this.mode === "still" || this.mode === "off" || this.videoFailed)) return;
    if (playing && this.mode === "hover" && !this.hovered) return;
    if (playing === this._playing) return;
    this._playing = playing;
    if (playing && !this._video) void this.loadVideo();
    const video = this.renderRoot.querySelector("video");
    if (video) {
      if (playing) video.play().catch(() => undefined);
      else video.pause();
    }
  }

  private async load() {
    const list = this.thumbnail ?? [];
    const ref = list[this.stillIndex];
    if (!ref || !this.resolver || this.mode === "off") return;
    try {
      this._still = await this.resolver.url(ref);
    } catch {
      this.nextStill();
    }
  }

  private nextStill() {
    this.stillIndex += 1;
    this._still = undefined;
    void this.load();
  }

  private async onStillError() {
    const ref = this.thumbnail?.[this.stillIndex];
    const failed = this._still;
    if (ref && !this.retried.has(ref.path) && this.resolver) {
      // A signature may have expired: re-sign once before moving to the next still.
      this.retried.add(ref.path);
      this.resolver.invalidate(ref);
      try {
        const url = await this.resolver.url(ref);
        if (url !== failed) {
          this._still = url;
          return;
        }
      } catch {
        /* fall through to the next still */
      }
    }
    this.nextStill();
  }

  private async loadVideo() {
    const ref = this.preview?.[0];
    if (!ref || !this.resolver) return;
    try {
      this._video = await this.resolver.url(ref);
    } catch {
      this.videoFailed = true;
      this._playing = false;
    }
  }

  private onVideoError() {
    this.videoFailed = true;
    this._playing = false;
    this._video = undefined;
    coordinator.schedule();
  }

  protected override updated() {
    const video = this.renderRoot.querySelector("video");
    if (video && this._playing && video.paused) video.play().catch(() => undefined);
  }

  protected override render() {
    const showVideo = this._video && this._playing && this.mode !== "still" && this.mode !== "off";
    if (!this._still && !showVideo) {
      return html`<div class="placeholder">
        ${this.icon ? html`<ha-icon .icon=${this.icon}></ha-icon>` : nothing}
      </div>`;
    }
    return html`
      ${
        this._still
          ? html`<img src=${this._still} alt="" loading="lazy" @error=${this.onStillError} />`
          : nothing
      }
      ${
        showVideo
          ? html`<video
              src=${this._video!}
              muted
              loop
              playsinline
              autoplay
              disablepictureinpicture
              preload="auto"
              @error=${this.onVideoError}
            ></video>`
          : nothing
      }
    `;
  }

  static override styles = css`
    :host {
      position: relative;
      display: block;
      overflow: hidden;
      border-radius: 6px;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
    }
    img,
    video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--secondary-text-color);
      --mdc-icon-size: 18px;
    }
  `;
}

if (!customElements.get("event-reel-preview")) {
  customElements.define("event-reel-preview", EventReelPreview);
}
