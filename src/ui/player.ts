// Inline player for the exact clip: Frigate VOD over HLS (hls.js or native), Nest clips as
// MP4. Falls back to the low-res preview, then a still, when the device can't decode the
// recording or it is missing (§5.4).

import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues } from "lit";
import type HlsType from "hls.js/light";
import { frigateMedia } from "../core/media";
import type { MediaResolver } from "../core/media";
import { stallVerdict } from "../core/playback";
import type { Localize, MediaRef, ReelEvent } from "../types";
import { motionAllowed } from "./preview";

type Status = "loading" | "playing" | "codec" | "deleted" | "unavailable";
type FallbackStatus = Exclude<Status, "loading" | "playing">;

/** Cameras whose recordings failed to decode in this session: open them straight in fallback. */
const codecBlocked = new Set<string>();

const WATCHDOG_MS = 4000;
const WIDEN_STEP = 30;
const TICK = 2000;

let hlsModule: Promise<typeof HlsType> | undefined;
const loadHls = () => (hlsModule ??= import("hls.js/light").then((m) => m.default));

/** What identifies "the same clip": a new object for the same event must not restart playback. */
const clipKey = (e: ReelEvent | undefined) =>
  e ? `${e.id}|${e.clip?.path ?? ""}|${e.frigate?.instance ?? ""}/${e.frigate?.camera ?? ""}` : "";

export class EventReelPlayer extends LitElement {
  static override properties = {
    event: { attribute: false },
    padding: { attribute: false },
    clipMode: {},
    _status: { state: true },
    _fallbackUrl: { state: true },
    _fallbackFailed: { state: true },
    _downloadUrl: { state: true },
    _pendingUrl: { state: true },
    _extra: { state: true },
  };

  declare resolver?: MediaResolver;
  declare localize?: Localize;
  declare now?: () => number;
  declare event?: ReelEvent;
  declare padding: [number, number];
  declare clipMode: "auto" | "preview";
  declare _status: Status;
  declare _fallbackUrl?: string;
  declare _fallbackFailed: boolean;
  declare _downloadUrl?: string;
  /** The animated preview, looped over the player until the clip actually plays. */
  declare _pendingUrl?: string;
  declare _extra: [number, number];

  private hls?: HlsType;
  /** Removes the video listeners of the current load (the element is reused for ±30 s). */
  private listeners?: AbortController;
  private watchdog?: number;
  private startTimer?: number;
  private loadToken = 0;
  private currentKey = "";
  private needsStart = false;
  private authRetried = false;

  constructor() {
    super();
    this.padding = [10, 20];
    this.clipMode = "auto";
    this._status = "loading";
    this._fallbackFailed = false;
    this._extra = [0, 0];
  }

  override connectedCallback() {
    super.connectedCallback();
    // Re-attached (e.g. moved in the list): start again, the old session was torn down.
    if (this.hasUpdated && this.event) this.needsStart = true;
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.loadToken++;
    this.teardown();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("event")) {
      const key = clipKey(this.event);
      if (key !== this.currentKey) {
        this.currentKey = key;
        this._extra = [0, 0];
        this.needsStart = true;
      }
    }
    if (changed.has("_extra") && changed.get("_extra") !== undefined) this.needsStart = true;
    if (changed.has("clipMode") && changed.get("clipMode") !== undefined) this.needsStart = true;
  }

  protected override updated() {
    if (this.needsStart && this.isConnected) {
      this.needsStart = false;
      this.authRetried = false;
      void this.start();
    }
  }

  private get t(): Localize {
    return this.localize ?? ((k) => k);
  }

  private alive(token: number) {
    return token === this.loadToken && this.isConnected;
  }

  private range(): [number, number] {
    const e = this.event!;
    const nowEnd = (this.now?.() ?? Date.now() / 1000) - 5;
    return [
      e.start - this.padding[0] - this._extra[0],
      (e.end ?? nowEnd) + this.padding[1] + this._extra[1],
    ];
  }

  private stopWatchdog() {
    this.listeners?.abort();
    this.listeners = undefined;
    window.clearTimeout(this.watchdog);
    window.clearInterval(this.startTimer);
    this.watchdog = undefined;
    this.startTimer = undefined;
  }

  private teardown() {
    this.stopWatchdog();
    this.hls?.destroy();
    this.hls = undefined;
    const video = this.video;
    if (video) {
      video.removeAttribute("src");
      video.load();
    }
  }

  private get video(): HTMLVideoElement | null {
    return this.renderRoot.querySelector("video.main");
  }

  private async start() {
    const e = this.event;
    if (!e || !this.resolver) return;
    const token = ++this.loadToken;
    this.teardown();
    this._status = "loading";
    this._fallbackUrl = undefined;
    this._fallbackFailed = false;
    void this.prepareDownload(e, token);
    void this.preparePending(e, token);

    if (e.clip) {
      await this.playFile(e.clip, token);
      return;
    }
    if (!e.frigate) {
      await this.fallback(token, "unavailable");
      return;
    }
    if (this.clipMode === "preview" || (e.camera && codecBlocked.has(e.camera))) {
      await this.fallback(token, "codec");
      return;
    }

    const [start, end] = this.range();
    const ref = frigateMedia.vod(e.frigate, start, end);
    let url: string;
    try {
      url = await this.resolver.url(ref);
    } catch {
      await this.fallback(token, "unavailable");
      return;
    }
    if (!this.alive(token)) return;
    await this.updateComplete;
    const video = this.video;
    if (!video || !this.alive(token)) return;

    const Hls = await loadHls();
    if (!this.alive(token)) return;
    const native = !Hls.isSupported();
    if (!native) {
      const hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
      this.hls = hls;
      const touch = () => this.touch();
      hls.on(Hls.Events.MANIFEST_LOADED, touch);
      hls.on(Hls.Events.LEVEL_LOADED, touch);
      hls.on(Hls.Events.FRAG_LOADING, touch);
      hls.on(Hls.Events.FRAG_LOADED, touch);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal || !this.alive(token)) return;
        const code = (data.response as { code?: number } | undefined)?.code;
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR && code === 404) {
          void this.fallback(token, "deleted");
        } else if ((code === 401 || code === 403) && !this.authRetried) {
          // The signature expired mid-clip: sign again once.
          this.authRetried = true;
          this.resolver?.invalidate(ref);
          void this.start();
        } else if (
          data.type === Hls.ErrorTypes.MEDIA_ERROR ||
          /codec/i.test(String(data.details))
        ) {
          this.blockCodec();
          void this.fallback(token, "codec");
        } else {
          void this.fallback(token, "unavailable");
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      this.blockCodec();
      await this.fallback(token, "codec");
      return;
    }
    this.armWatchdog(video, token, native);
    video.play().catch(() => undefined);
  }

  private blockCodec() {
    if (this.event?.camera) codecBlocked.add(this.event.camera);
  }

  private lastActivity = 0;
  private startedAt = 0;

  private touch() {
    this.lastActivity = performance.now() / 1000;
  }

  /**
   * Falls back when playback never starts (stalled, or a codec the device silently can't
   * play), on decode errors, and in the "audio but black video" case.
   */
  private armWatchdog(video: HTMLVideoElement, token: number, native: boolean) {
    this.startedAt = performance.now() / 1000;
    this.touch();
    this.listeners?.abort();
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    const activity = () => this.touch();
    for (const type of ["progress", "loadedmetadata", "loadeddata", "canplay"]) {
      video.addEventListener(type, activity, { signal });
    }

    this.startTimer = window.setInterval(() => {
      if (!this.alive(token) || this._status !== "loading") {
        window.clearInterval(this.startTimer);
        return;
      }
      const now = performance.now() / 1000;
      if (document.visibilityState === "hidden") {
        // Browsers hold back playback in hidden pages; don't count that time.
        this.startedAt += TICK / 1000;
        this.lastActivity = now;
        return;
      }
      const verdict = stallVerdict({
        native,
        idle: now - this.lastActivity,
        elapsed: now - this.startedAt,
        readyState: video.readyState,
      });
      if (verdict === "wait") return;
      if (verdict === "codec") this.blockCodec();
      void this.fallback(token, verdict);
    }, TICK);

    video.addEventListener(
      "error",
      () => {
        if (!this.alive(token)) return;
        const code = video.error?.code;
        const codec =
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE;
        if (codec) this.blockCodec();
        void this.fallback(token, codec ? "codec" : "unavailable");
      },
      { once: true, signal },
    );

    video.addEventListener(
      "playing",
      () => {
        if (!this.alive(token)) return;
        this._status = "playing";
        window.clearInterval(this.startTimer);
        window.clearTimeout(this.watchdog);
        this.watchdog = window.setTimeout(() => {
          if (!this.alive(token)) return;
          const frames =
            video.getVideoPlaybackQuality?.().totalVideoFrames ??
            (video as HTMLVideoElement & { webkitDecodedFrameCount?: number })
              .webkitDecodedFrameCount;
          if (frames === 0 && video.currentTime > 1) {
            this.blockCodec();
            void this.fallback(token, "codec");
          }
        }, WATCHDOG_MS);
      },
      { once: true, signal },
    );
  }

  private async playFile(ref: MediaRef, token: number) {
    try {
      const url = await this.resolver!.url(ref);
      if (!this.alive(token)) return;
      await this.updateComplete;
      const video = this.video;
      if (!video || !this.alive(token)) return;
      video.src = url;
      this.armWatchdog(video, token, true);
      video.play().catch(() => undefined);
    } catch {
      await this.fallback(token, "unavailable");
    }
  }

  private async fallback(token: number, status: FallbackStatus) {
    if (!this.alive(token)) return;
    this.stopWatchdog();
    this.hls?.destroy();
    this.hls = undefined;
    this._status = status;
    const ref = this.event?.preview?.[0];
    if (!ref || !this.resolver) {
      this._fallbackFailed = true;
      return;
    }
    try {
      const url = await this.resolver.url(ref);
      if (this.alive(token)) this._fallbackUrl = url;
    } catch {
      if (this.alive(token)) this._fallbackFailed = true;
    }
  }

  private onFallbackError() {
    this._fallbackUrl = undefined;
    this._fallbackFailed = true;
  }

  private async preparePending(e: ReelEvent, token: number) {
    this._pendingUrl = undefined;
    const ref = e.preview?.[0];
    // With reduced motion or data saving, the still stands in while the clip loads.
    if (!ref || !this.resolver || !motionAllowed()) return;
    try {
      const url = await this.resolver.url(ref);
      if (this.alive(token)) this._pendingUrl = url;
    } catch {
      /* the loading label is enough */
    }
  }

  private async prepareDownload(e: ReelEvent, token: number) {
    this._downloadUrl = undefined;
    if (!this.resolver) return;
    const ref =
      e.clip ?? (e.frigate ? frigateMedia.recording(e.frigate, ...this.range()) : undefined);
    if (!ref) return;
    try {
      const url = await this.resolver.url(ref);
      if (this.alive(token)) this._downloadUrl = url;
    } catch {
      /* no download button */
    }
  }

  private retry() {
    this.authRetried = false;
    void this.start();
  }

  private widen(which: 0 | 1) {
    const next: [number, number] = [...this._extra];
    next[which] += WIDEN_STEP;
    this._extra = next;
  }

  private message(): string | undefined {
    switch (this._status) {
      case "codec":
        return this.t("player.codec");
      case "deleted":
        return this.t("player.deleted");
      case "unavailable":
        return this.t("player.unavailable");
      default:
        return undefined;
    }
  }

  private renderFallback() {
    if (this._fallbackUrl && !this._fallbackFailed) {
      return html`<video
        class="fallback"
        src=${this._fallbackUrl}
        muted
        loop
        autoplay
        playsinline
        controls
        @error=${this.onFallbackError}
      ></video>`;
    }
    if (this._fallbackFailed && this.event?.thumbnail?.length) {
      return html`<event-reel-preview
        class="still"
        .resolver=${this.resolver}
        .thumbnail=${this.event.thumbnail}
        mode="still"
      ></event-reel-preview>`;
    }
    return html`<div class="empty"></div>`;
  }

  protected override render() {
    if (!this.event) return nothing;
    const fallback =
      this._status === "codec" || this._status === "deleted" || this._status === "unavailable";
    const canWiden = !!this.event.frigate && !fallback;
    const msg = this.message();
    return html`
      <div class="stage">
        ${
          fallback
            ? this.renderFallback()
            : html`<video class="main" muted playsinline controls preload="auto"></video>`
        }
        ${
          // While loading: the still, with the looping preview on top once it is ready (it
          // stays transparent until its first frame, so the still shows through meanwhile).
          this._status === "loading" && this.event.thumbnail?.length
            ? html`<event-reel-preview
                class="still pending"
                .resolver=${this.resolver}
                .thumbnail=${this.event.thumbnail}
                mode="still"
                aria-hidden="true"
              ></event-reel-preview>`
            : nothing
        }
        ${
          this._status === "loading" && this._pendingUrl
            ? html`<video
                class="pending"
                src=${this._pendingUrl}
                muted
                loop
                autoplay
                playsinline
                aria-hidden="true"
              ></video>`
            : nothing
        }
        ${
          this._status === "loading"
            ? html`<div class="loading" role="status">${this.t("player.loading")}</div>`
            : nothing
        }
      </div>
      ${msg ? html`<p class="msg" role="status">${msg}</p>` : nothing}
      <div class="controls">
        ${
          canWiden
            ? html`<button
                  aria-label=${this.t("detail.earlier_label")}
                  @click=${() => this.widen(0)}
                >
                  ${this.t("detail.earlier")}
                </button>
                <button aria-label=${this.t("detail.later_label")} @click=${() => this.widen(1)}>
                  ${this.t("detail.later")}
                </button>`
            : nothing
        }
        ${
          this._status === "unavailable"
            ? html`<button @click=${this.retry}>${this.t("player.retry")}</button>`
            : nothing
        }
        <span class="spacer"></span>
        ${
          this._downloadUrl
            ? html`<a
                class="button"
                href=${this._downloadUrl}
                download
                target="_blank"
                rel="noopener"
                >${this.t("detail.download")}</a
              >`
            : nothing
        }
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
    }
    .stage {
      position: relative;
      aspect-ratio: 16 / 9;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
    }
    video,
    .empty,
    .still {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .pending {
      pointer-events: none;
    }
    .loading {
      position: absolute;
      inset: auto 0 0 0;
      padding: 6px 10px;
      font-size: 0.85em;
      color: #fff;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
      pointer-events: none;
    }
    .msg {
      margin: 8px 0 0;
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }
    .spacer {
      flex: 1;
    }
    button,
    .button {
      font: inherit;
      font-size: 0.85em;
      padding: 4px 10px;
      border-radius: 16px;
      border: 1px solid var(--divider-color);
      background: none;
      color: var(--primary-text-color);
      cursor: pointer;
      text-decoration: none;
    }
    button:focus-visible,
    .button:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
  `;
}

if (!customElements.get("event-reel-player")) {
  customElements.define("event-reel-player", EventReelPlayer);
}
