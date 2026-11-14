// Browser smoke tests: the card in Chromium on the dev harness's example data
// (dev/mount.ts). Each expectation comes from PLAN.md, not from the code.
import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../dev/harness.css";
import { mountCard } from "../../dev/mount";
import type { Mounted, MountOptions } from "../../dev/mount";
import { en } from "../../src/i18n/en";

const NOW = "2026-10-08T21:00:00+02:00";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.remove();
  mounted = undefined;
});

async function mount(opts: MountOptions = {}) {
  mounted = await mountCard({ now: NOW, ...opts });
  return mounted;
}

const root = (m: Mounted) => m.card.shadowRoot!;
const rows = (m: Mounted) => [...root(m).querySelectorAll<HTMLElement>("button.row")];
const ids = (m: Mounted) => rows(m).map((r) => r.dataset.id!);
const items = (m: Mounted) => root(m).querySelectorAll(".list > [role=listitem]");
const status = (m: Mounted) =>
  root(m).querySelector("[role=status].empty")?.textContent?.trim() ?? "";

/** Waits until `check` holds, polling each frame, or fails after `ms`. */
async function until(check: () => boolean, ms = 5000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((r) => requestAnimationFrame(r));
  }
}

const loaded = (m: Mounted) => until(() => rows(m).length > 0);

describe("first paint (PLAN §3.7)", () => {
  test("shows Loading… until 1.5 s, the fast sources after it, Frigate when it answers", async () => {
    const m = await mount({ slow: { frigate: 4 } });
    const start = performance.now();

    // Before the 1.5 s first-paint wait: only "Loading…", no rows.
    while (performance.now() - start < 1300) {
      expect(rows(m)).toHaveLength(0);
      expect(status(m)).toBe(en.loading);
      await sleep(100);
    }

    // After it: the entity provider's rows, and no Frigate review yet.
    await sleep(800);
    expect(ids(m).some((id) => id.startsWith("entity:") || id.startsWith("burst:entity:"))).toBe(
      true,
    );
    expect(ids(m).some((id) => id.startsWith("frigate:"))).toBe(false);

    // Once Frigate answers (4 s), its reviews join the list.
    await until(() => ids(m).some((id) => id.startsWith("frigate:")), 4000);
  });
});

describe("rows", () => {
  test("one detail is open at a time, aria-expanded follows, Esc closes it", async () => {
    const m = await mount();
    await loaded(m);
    const [a, b] = rows(m).filter((r) => r.classList.contains("camera"));

    await userEvent.click(a);
    await m.card.updateComplete;
    expect(a.getAttribute("aria-expanded")).toBe("true");
    expect(root(m).getElementById(a.getAttribute("aria-controls")!)).not.toBeNull();

    await userEvent.click(b);
    await m.card.updateComplete;
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(rows(m).filter((r) => r.getAttribute("aria-expanded") === "true")).toEqual([b]);
    expect(root(m).querySelectorAll(".detail")).toHaveLength(1);

    await userEvent.keyboard("{Escape}");
    await m.card.updateComplete;
    expect(rows(m).filter((r) => r.getAttribute("aria-expanded") === "true")).toEqual([]);
    expect(root(m).querySelectorAll(".detail")).toHaveLength(0);
    expect(root(m).activeElement).toBe(b);
  });

  test("↑ and ↓ move focus between rows", async () => {
    const m = await mount();
    await loaded(m);
    const list = rows(m);
    list[0].focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(root(m).activeElement).toBe(list[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(root(m).activeElement).toBe(list[2]);
    await userEvent.keyboard("{ArrowUp}");
    expect(root(m).activeElement).toBe(list[1]);
  });
});

describe("filters (PLAN §5.1)", () => {
  test("a category chip narrows the list to that category and is pressed", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    const all = items(m).length;
    const chip = [...root(m).querySelectorAll<HTMLElement>(".fchip:not(.bandchip)")].find((c) =>
      c.textContent!.includes(en["category.door"]),
    )!;
    const count = Number(chip.querySelector(".n")!.textContent);
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(chip);
    await m.card.updateComplete;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // The front door changes are door events; nothing else is.
    expect(items(m).length).toBe(count);
    expect(count).toBeLessThan(all);
    for (const r of rows(m)) expect(r.dataset.id).toMatch(/^(burst:)?entity:/);

    await userEvent.click(chip);
    await m.card.updateComplete;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(items(m).length).toBe(all);
  });
});

describe("day navigation (PLAN §5.1, §3.7)", () => {
  test("‹ shows Yesterday and never the live range's rows under it", async () => {
    const m = await mount({ slow: { frigate: 2, llmvision: 2 } });
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    // Every row of the live view starts today: the example data spans the last 15 hours.
    const live = new Set(ids(m));
    expect(live.size).toBeGreaterThan(0);

    const seen = new Set<string>();
    const record = () => ids(m).forEach((id) => seen.add(id));
    const observer = new MutationObserver(record);
    observer.observe(root(m), { subtree: true, childList: true, attributes: true });

    await userEvent.click(root(m).querySelector<HTMLElement>(".navbtn.prev")!);
    await m.card.updateComplete;
    record();
    expect(root(m).querySelector(".daylabel")!.textContent!.trim()).toBe(en["nav.yesterday"]);

    // Wait for every source (2 s), then a little longer.
    await sleep(2600);
    record();
    observer.disconnect();
    expect([...seen].filter((id) => live.has(id))).toEqual([]);
    expect(status(m)).toBe(en["empty.yesterday"]);
  });
});

describe("phone width", () => {
  test("at 375 px nothing reaches past the card's edge", async () => {
    await page.viewport(375, 800);
    try {
      const m = await mount({ parent: document.body });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
      const edge = m.card.getBoundingClientRect().right + 0.5;
      const scrolls = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowX);
      const past: string[] = [];
      const walk = (el: Element) => {
        if (el.getBoundingClientRect().right > edge) past.push(el.className || el.tagName);
        if (scrolls(el)) return; // a sideways scroller's content may be out of view
        for (const child of el.children) walk(child);
        if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child);
      };
      for (const child of root(m).children) walk(child);
      expect(past).toEqual([]);
    } finally {
      await page.viewport(1024, 900);
    }
  });
});
