import { css } from "lit";

export const styles = css`
  :host {
    display: block;
    container-type: inline-size;
    --reel-time-width: 44px;
    --reel-slot-width: 64px;
    --reel-thumb-height: 36px;
    --reel-row-camera: 44px;
    --reel-row-plain: 32px;
  }
  .list.comfortable {
    --reel-slot-width: 112px;
    --reel-thumb-height: 63px;
    --reel-row-camera: 72px;
    --reel-row-plain: 40px;
  }
  ha-card {
    overflow: visible;
  }
  .list {
    padding: 4px 0 8px;
  }
  .empty {
    padding: 24px 16px;
    color: var(--secondary-text-color);
    text-align: center;
  }
  .capped {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 0.85em;
    color: var(--secondary-text-color);
    text-align: center;
  }

  .warnings {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px 0;
  }
  .warning {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.8em;
    padding: 2px 8px;
    border-radius: 12px;
    color: var(--warning-color, #ffa600);
    border: 1px solid currentColor;
    --mdc-icon-size: 14px;
  }

  .daynav {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px 0 16px;
  }
  .daylabel {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .daynav .today {
    margin-right: 8px;
    font-size: 0.85em;
  }
  .navbtn {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    cursor: pointer;
    color: var(--primary-text-color);
    --mdc-icon-size: 22px;
  }
  .navbtn:hover {
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.08));
  }
  .navbtn:disabled {
    opacity: 0.38;
    cursor: default;
    background: none;
  }
  .navbtn:focus-visible {
    outline: 2px solid var(--primary-color);
  }

  .sticky {
    position: sticky;
    top: var(--header-height, 0px);
    z-index: 2;
    padding-bottom: 2px;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 12px) var(--ha-card-border-radius, 12px) 0 0;
  }
  .row.hl {
    background: color-mix(in srgb, var(--primary-color) 14%, transparent);
  }
  .sep {
    position: sticky;
    top: calc(var(--header-height, 0px) + var(--reel-sticky-height, 0px));
    z-index: 1;
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 16px 2px;
    font-size: 0.75em;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--secondary-text-color);
    background: var(--ha-card-background, var(--card-background-color, #fff));
  }
  .sep .day {
    color: var(--primary-text-color);
  }

  .row {
    all: unset;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: var(--reel-time-width) var(--reel-slot-width) minmax(0, 1fr) auto 10px;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 4px 12px 4px 16px;
    cursor: pointer;
    color: var(--primary-text-color);
    -webkit-tap-highlight-color: transparent;
  }
  .row.camera {
    min-height: var(--reel-row-camera);
  }
  .row.plain {
    min-height: var(--reel-row-plain);
  }
  .row:hover {
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.08));
  }
  .row:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: -2px;
  }
  .row[aria-expanded="true"] {
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.08));
  }

  .time {
    font-variant-numeric: tabular-nums;
    font-size: 0.85em;
    color: var(--secondary-text-color);
  }
  .slot {
    display: flex;
    align-items: center;
  }
  .thumb {
    width: var(--reel-slot-width);
    height: var(--reel-thumb-height);
  }
  .disc {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 18%, transparent);
    --mdc-icon-size: 18px;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.95em;
  }
  .state {
    color: var(--secondary-text-color);
  }
  .badge {
    display: inline-block;
    margin-right: 6px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.8em;
    font-weight: 500;
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
  }
  /* The theme's text colour is mixed in so the label stays readable in light and dark themes. */
  .badge.threat-1 {
    color: color-mix(
      in srgb,
      var(--warning-color, #ffa600) 35%,
      var(--primary-text-color, #212121)
    );
    background: color-mix(in srgb, var(--warning-color, #ffa600) 18%, transparent);
  }
  .badge.threat-2 {
    color: color-mix(in srgb, var(--error-color, #db4437) 50%, var(--primary-text-color, #212121));
    background: color-mix(in srgb, var(--error-color, #db4437) 18%, transparent);
  }
  .desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.85em;
    color: var(--secondary-text-color);
  }
  .sub {
    display: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.8em;
    color: var(--secondary-text-color);
  }
  .meta {
    max-width: 14em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.8em;
    color: var(--secondary-text-color);
    text-align: right;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--primary-color);
  }

  .sub .badge {
    font-size: 1em;
  }

  @container (max-width: 480px) {
    .row {
      gap: 8px;
      padding: 4px 10px 4px 12px;
      grid-template-columns: 40px var(--reel-slot-width) minmax(0, 1fr) 0 8px;
    }
    .meta {
      display: none;
    }
    .sub {
      display: block;
    }
    /* The threat badge moves to the camera/duration line, so the title stays readable. */
    .title .badge.threat-1,
    .title .badge.threat-2 {
      display: none;
    }
  }

  .children {
    margin-left: 24px;
    border-left: 2px solid var(--divider-color);
  }

  .steps {
    padding: 2px 16px 8px calc(16px + var(--reel-time-width) + 10px);
  }
  .step {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    font-size: 0.85em;
    --mdc-icon-size: 16px;
  }
  .step.highlight {
    border-radius: 4px;
    background: color-mix(in srgb, var(--primary-color) 14%, transparent);
  }
  .step .time {
    width: 5em;
  }
  .muted {
    color: var(--secondary-text-color);
  }

  .detail {
    padding: 8px 16px 12px;
  }
  .detail .still {
    aspect-ratio: 16 / 9;
    width: 100%;
    border-radius: 8px;
  }
  .detail .desc {
    display: block;
    -webkit-line-clamp: unset;
    margin: 8px 0 0;
    font-size: 0.9em;
    color: var(--primary-text-color);
  }
  .extra {
    margin-top: 8px;
    font-size: 0.85em;
  }
  .extra .label,
  .concerns .label {
    color: var(--secondary-text-color);
    font-size: 0.85em;
  }
  .concerns {
    align-items: center;
  }
  .extra p {
    margin: 4px 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .chip {
    font-size: 0.75em;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
    color: var(--secondary-text-color);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .actions .spacer {
    flex: 1;
  }
  .actions button {
    font: inherit;
    font-size: 0.85em;
    padding: 4px 12px;
    border-radius: 16px;
    border: 1px solid var(--divider-color);
    background: none;
    color: var(--primary-text-color);
    cursor: pointer;
  }
  .actions button:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 0;
  }
  .chipbar {
    display: flex;
    gap: 6px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .chipbar::-webkit-scrollbar {
    display: none;
  }
  .fchip,
  .camsel,
  .searchbtn,
  .markall {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 10px;
    border-radius: 14px;
    border: 1px solid var(--divider-color);
    background: none;
    color: var(--primary-text-color);
    font: inherit;
    font-size: 0.8em;
    cursor: pointer;
    --mdc-icon-size: 16px;
  }
  .fchip ha-icon {
    color: var(--c);
  }
  .fchip .n,
  .markall .n {
    color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums;
  }
  .fchip[aria-pressed="true"] {
    border-color: var(--c);
    background: color-mix(in srgb, var(--c) 16%, transparent);
  }
  .camsel {
    padding-right: 6px;
  }
  .markall {
    color: var(--primary-color);
  }
  .searchbtn {
    padding: 0 6px;
  }
  .searchbtn[aria-expanded="true"] {
    border-color: var(--primary-color);
    color: var(--primary-color);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 16px 0;
    padding: 0 4px 0 10px;
    height: 32px;
    border: 1px solid var(--divider-color);
    border-radius: 16px;
    color: var(--secondary-text-color);
    --mdc-icon-size: 18px;
  }
  .search:focus-within {
    border-color: var(--primary-color);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: none;
    color: var(--primary-text-color);
    font: inherit;
    font-size: 0.9em;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search .hits {
    flex: none;
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
  }
  .search .clear {
    all: unset;
    display: inline-flex;
    padding: 4px;
    border-radius: 50%;
    cursor: pointer;
  }
  .search .clear:focus-visible,
  .searchbtn:focus-visible,
  .fchip:focus-visible,
  .camsel:focus-visible,
  .markall:focus-visible,
  .linkish:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
    margin: 8px 16px 0;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 0.85em;
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
  }
  .empty .muted {
    margin-top: 4px;
    font-size: 0.85em;
  }
  .empty a {
    color: var(--primary-color);
  }
  .empty a:focus-visible {
    outline: 2px solid var(--primary-color);
    outline-offset: 2px;
  }
  .linkish {
    all: unset;
    cursor: pointer;
    color: var(--primary-color);
  }
  .item.highlight > .row,
  .item.highlight > .row + .detail {
    background: color-mix(in srgb, var(--primary-color) 14%, transparent);
    transition: background 0.3s;
  }

  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
    }
  }
`;
