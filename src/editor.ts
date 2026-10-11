// GUI editor: HA's own ha-form over a flat form model (editor-model.ts), so options the form
// doesn't show survive edits. Everything else stays YAML.

import { LitElement, css, html, nothing } from "lit";
import type { CardConfig } from "./config";
import { configToForm, formToConfig } from "./editor-model";
import type { EditorForm } from "./editor-model";
import type { HomeAssistant } from "./ha-types";
import { getLocalize, resolveLanguage } from "./i18n";

/** Makes sure ha-form is defined; HA loads it lazily in some versions. */
async function ensureHaForm(): Promise<void> {
  if (customElements.get("ha-form")) return;
  try {
    const helpers = await (
      window as unknown as {
        loadCardHelpers?: () => Promise<{ createCardElement(c: object): HTMLElement }>;
      }
    ).loadCardHelpers?.();
    const card = helpers?.createCardElement({ type: "entities", entities: [] });
    await (
      card?.constructor as { getConfigElement?: () => Promise<unknown> } | undefined
    )?.getConfigElement?.();
  } catch {
    /* fall through to whenDefined */
  }
  await customElements.whenDefined("ha-form");
}

const select = (options: { value: string; label: string }[], custom = false) => ({
  select: { mode: "dropdown", options, custom_value: custom },
});

export class EventReelCardEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    _config: { state: true },
    _ready: { state: true },
  };

  declare hass?: HomeAssistant;
  declare _config?: CardConfig;
  declare _ready: boolean;

  constructor() {
    super();
    this._ready = !!customElements.get("ha-form");
  }

  override connectedCallback() {
    super.connectedCallback();
    if (!this._ready) void ensureHaForm().then(() => (this._ready = true));
  }

  /** The config the editor was opened with (for restoring custom values). */
  private initial?: CardConfig;

  setConfig(config: CardConfig): void {
    this.initial ??= config;
    this._config = config;
  }

  private get t() {
    return getLocalize(
      resolveLanguage(this._config?.language ?? "auto", this.hass?.locale?.language),
    );
  }

  private schema() {
    const t = this.t;
    return [
      { name: "title", selector: { text: {} } },
      {
        type: "grid",
        name: "",
        schema: [
          {
            name: "density",
            required: true,
            selector: select([
              { value: "compact", label: t("editor.density_compact") },
              { value: "comfortable", label: t("editor.density_comfortable") },
            ]),
          },
          {
            name: "range",
            required: true,
            selector: select(
              [
                { value: "24h", label: t("editor.range_24h") },
                { value: "today", label: t("editor.range_today") },
                { value: "12h", label: "12 h" },
                { value: "48h", label: "48 h" },
              ],
              true,
            ),
          },
          {
            name: "preview",
            required: true,
            selector: select([
              { value: "visible", label: t("editor.preview_visible") },
              { value: "hover", label: t("editor.preview_hover") },
              { value: "still", label: t("editor.preview_still") },
              { value: "off", label: t("editor.preview_off") },
            ]),
          },
          {
            name: "language",
            required: true,
            selector: select([
              { value: "auto", label: t("editor.language_auto") },
              { value: "nb", label: "Norsk bokmål" },
              { value: "en", label: "English" },
            ]),
          },
        ],
      },
      { name: "entities", selector: { entity: { multiple: true } } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "filters", selector: { boolean: {} } },
          { name: "day_strip", selector: { boolean: {} } },
          { name: "day_navigation", selector: { boolean: {} } },
        ],
      },
      {
        type: "expandable",
        name: "",
        flatten: true,
        title: t("editor.sources"),
        schema: [
          { name: "event_reel_enabled", selector: { boolean: {} } },
          { name: "llmvision_enabled", selector: { boolean: {} } },
          { name: "llmvision_non_camera", selector: { boolean: {} } },
          { name: "frigate_enabled", selector: { boolean: {} } },
          { name: "frigate_show_unmatched", selector: { boolean: {} } },
          { name: "frigate_alerts_only", selector: { boolean: {} } },
          { name: "nest_enabled", selector: { boolean: {} } },
        ],
      },
    ];
  }

  private computeLabel = (s: { name: string }) => (s.name ? this.t(`editor.${s.name}`) : undefined);
  private computeHelper = (s: { name: string }) => {
    if (!s.name) return undefined;
    const key = `editor.${s.name}_help`;
    const text = this.t(key);
    return text === key ? undefined : text;
  };

  private onChange(ev: CustomEvent<{ value: EditorForm }>) {
    ev.stopPropagation();
    if (!this._config) return;
    const config = formToConfig(ev.detail.value, this._config, this.initial);
    this._config = config;
    this.dispatchEvent(
      new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }),
    );
  }

  protected override render() {
    if (!this._config || !this.hass) return nothing;
    if (!this._ready) return html`<div class="loading">…</div>`;
    let form: EditorForm;
    try {
      form = configToForm(this._config);
    } catch (err) {
      return html`<div class="error">${String((err as Error).message)}</div>`;
    }
    return html`
      <ha-form
        .hass=${this.hass}
        .data=${form}
        .schema=${this.schema()}
        .computeLabel=${this.computeLabel}
        .computeHelper=${this.computeHelper}
        @value-changed=${this.onChange}
      ></ha-form>
      <p class="hint">${this.t("editor.yaml_hint")}</p>
    `;
  }

  static override styles = css`
    .hint {
      margin: 12px 0 0;
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    .error {
      color: var(--error-color);
    }
  `;
}

if (!customElements.get("event-reel-card-editor")) {
  customElements.define("event-reel-card-editor", EventReelCardEditor);
}
