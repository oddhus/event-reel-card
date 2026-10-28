// The expanded detail of a row: the player or a still, the AI text, the GenAI concerns, the
// labels and the actions (§5.4).

import { html, nothing } from "lit";
import { AI_PROVIDERS } from "../core/merge";
import { objectLabel } from "../i18n";
import type { ReelEvent } from "../types";
import { time } from "./view";
import type { CardView } from "./view";

/** Id of an event's detail region (ids live in the card's shadow root). */
export const detailId = (id: string) => `detail-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function renderDetail(view: CardView, e: ReelEvent) {
  const t = view.t;
  const player = e.frigate || e.clip;
  const override = e.camera ? view.config.cameras[e.camera]?.clip : undefined;
  const labels = (e.labels ?? []).map((l) => objectLabel(t, l));
  // "AI + Frigate" when AI text was joined to another provider's media.
  const media = e.sources.filter((s) => !AI_PROVIDERS.includes(s));
  const fromAi = media.length < e.sources.length;
  const chips = [
    ...labels,
    ...(fromAi && media.length
      ? [`${t("sources.ai")} + ${media.map((s) => t(`provider.${s}`)).join(" + ")}`]
      : []),
  ];
  return html`
    <div class="detail" id=${detailId(e.id)}>
      ${
        player
          ? html`<event-reel-player
              .resolver=${view.resolver}
              .localize=${t}
              .now=${view.now}
              .event=${e}
              .padding=${view.config.frigate.clip_padding}
              .clipMode=${override ?? "auto"}
            ></event-reel-player>`
          : e.thumbnail?.length
            ? html`<event-reel-preview
                class="still"
                .resolver=${view.resolver}
                .thumbnail=${e.thumbnail}
                mode="still"
              ></event-reel-preview>`
            : nothing
      }
      ${e.description && e.description !== e.title ? html`<p class="desc">${e.description}</p>` : nothing}
      ${
        e.extra?.length
          ? html`<div class="extra">
              <div class="label">${t("detail.more_ai")}</div>
              ${e.extra.map(
                (x) =>
                  html`<p>
                    <span class="time">${time(view, x.start)}</span> <strong>${x.title}</strong>${
                      x.description ? html` – ${x.description}` : nothing
                    }
                  </p>`,
              )}
            </div>`
          : nothing
      }
      ${
        e.concerns?.length
          ? html`<div class="chips concerns">
              <span class="label">${t("detail.concerns")}:</span>
              ${e.concerns.map((c) => html`<span class="chip">${c}</span>`)}
            </div>`
          : nothing
      }
      ${chips.length ? html`<div class="chips">${chips.map((c) => html`<span class="chip">${c}</span>`)}</div>` : nothing}
      <div class="actions">
        ${
          e.camera
            ? html`<button @click=${() => view.moreInfo(e.camera!)}>
                ${t("detail.open_camera")}
              </button>`
            : e.entityId
              ? html`<button @click=${() => view.moreInfo(e.entityId!)}>
                  ${t("detail.open_entity")}
                </button>`
              : nothing
        }
        ${
          e.frigate && e.reviewed === false
            ? html`<button @click=${() => view.markReviewed([e])}>
                ${t("action.mark_reviewed")}
              </button>`
            : nothing
        }
        <span class="spacer"></span>
        <button @click=${() => view.toggle(e.id)}>${t("detail.close")}</button>
      </div>
    </div>
  `;
}
