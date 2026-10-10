// Minimal stand-ins for the HA frontend elements the card uses, for the dev harness only.
import * as mdi from "@mdi/js";
import { LitElement, css, html, nothing, svg } from "lit";

const iconPath = (name: string | undefined): string | undefined => {
  if (!name?.startsWith("mdi:")) return undefined;
  const key =
    "mdi" +
    name
      .slice(4)
      .split("-")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  return (mdi as Record<string, string>)[key];
};

class HaCard extends LitElement {
  static override properties = { header: {} };
  declare header?: string;
  protected override render() {
    return html`${this.header ? html`<h1 class="card-header">${this.header}</h1>` : nothing}<slot
      ></slot>`;
  }
  static override styles = css`
    :host {
      display: block;
      background: var(--card-background-color);
      border-radius: var(--ha-card-border-radius, 12px);
      border: 1px solid var(--ha-card-border-color, #e0e0e0);
      color: var(--primary-text-color);
      overflow: hidden;
    }
    .card-header {
      font-size: 24px;
      font-weight: 400;
      margin: 0;
      padding: 16px 16px 8px;
    }
  `;
}

class HaIcon extends LitElement {
  static override properties = { icon: {} };
  declare icon?: string;
  protected override render() {
    const d = iconPath(this.icon) ?? mdi.mdiHelpCircleOutline;
    return html`<svg viewBox="0 0 24 24">${svg`<path d=${d}></path>`}</svg>`;
  }
  static override styles = css`
    :host {
      display: inline-flex;
      width: var(--mdc-icon-size, 24px);
      height: var(--mdc-icon-size, 24px);
    }
    svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
  `;
}

if (!customElements.get("ha-card")) customElements.define("ha-card", HaCard);
if (!customElements.get("ha-icon")) customElements.define("ha-icon", HaIcon);
