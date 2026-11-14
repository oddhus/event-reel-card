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

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined, what = "element"): T {
  if (value == null) throw new Error(`no ${what}`);
  return value;
}

const root = (m: Mounted) => must(m.card.shadowRoot, "shadow root");
const rows = (m: Mounted) => [...root(m).querySelectorAll<HTMLElement>("button.row")];
const ids = (m: Mounted) => rows(m).map((r) => r.dataset.id ?? "");
const items = (m: Mounted) => root(m).querySelectorAll(".list > [role=listitem]");
const status = (m: Mounted) =>
  root(m).querySelector("[role=status].empty")?.textContent.trim() ?? "";

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
    const m = await mount({ hold: ["frigate"] });
    const start = performance.now();

    // Before the 1.5 s first-paint wait: only "Loading…", no rows. (The card's own timer
    // started before `start`, so this window is inside it.)
    while (performance.now() - start < 1300) {
      expect(rows(m)).toHaveLength(0);
      expect(status(m)).toBe(en.loading);
      await sleep(100);
    }

    // Right after it (with slack for a slow runner): the entity provider's rows, while
    // Frigate still hasn't answered.
    await until(
      () => ids(m).some((id) => id.startsWith("entity:") || id.startsWith("burst:")),
      1500,
    );
    expect(ids(m).some((id) => id.startsWith("frigate:"))).toBe(false);

    // Once Frigate answers, its reviews join the list.
    m.release("frigate");
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
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
    expect(root(m).getElementById(a.getAttribute("aria-controls") ?? "")).not.toBeNull();

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
  const chip = (m: Mounted, label: string) =>
    must(
      [...root(m).querySelectorAll<HTMLElement>(".fchip:not(.bandchip)")].find((c) =>
        c.textContent.includes(label),
      ),
      `${label} chip`,
    );

  test("a category chip narrows the list to that category and is pressed", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    const all = items(m).length;
    const doorbell = chip(m, en["category.doorbell"]);
    expect(doorbell.getAttribute("aria-pressed")).toBe("false");

    // The example day has one doorbell ring, described by LLM Vision.
    await userEvent.click(doorbell);
    await m.card.updateComplete;
    expect(doorbell.getAttribute("aria-pressed")).toBe("true");
    expect(ids(m)).toEqual(["llmvision:ex-4"]);
    expect(doorbell.querySelector(".n")?.textContent).toBe("1");

    // Off again: every row is back.
    await userEvent.click(doorbell);
    await m.card.updateComplete;
    expect(doorbell.getAttribute("aria-pressed")).toBe("false");
    expect(items(m).length).toBe(all);

    // People: the camera rows with a person, never Alex's own comings and goings.
    await userEvent.click(chip(m, en["category.person"]));
    await m.card.updateComplete;
    expect(ids(m).length).toBeGreaterThan(0);
    for (const id of ids(m)) expect(id).toMatch(/^(frigate|llmvision):/);
  });
});

describe("day navigation (PLAN §5.1, §3.7)", () => {
  test("‹ shows Yesterday and never the live range's rows under it", async () => {
    // Every row of the live view starts today: the example data spans the last 15 hours.
    const first = await mount();
    await until(() => ids(first).some((id) => id.startsWith("frigate:")));
    const live = new Set(ids(first));
    first.remove();

    // Frigate and LLM Vision are still loading the live range when ‹ is clicked.
    const m = await mount({ hold: ["frigate", "llmvision"] });
    await until(() => ids(m).some((id) => id.startsWith("entity:") || id.startsWith("burst:")));

    await userEvent.click(must(root(m).querySelector<HTMLElement>(".navbtn.prev")));
    await m.card.updateComplete;
    expect(root(m).querySelector(".daylabel")?.textContent.trim()).toBe(en["nav.yesterday"]);

    // From here on, under "Yesterday", no row of the live range may show: not the ones on
    // screen before the click, nor the live answers that arrive after it.
    const seen = new Set<string>();
    const record = () => ids(m).forEach((id) => seen.add(id));
    record();
    const observer = new MutationObserver(record);
    observer.observe(root(m), { subtree: true, childList: true, attributes: true });
    m.release("frigate");
    m.release("llmvision");
    await until(() => status(m) === en["empty.yesterday"]);
    await sleep(300);
    record();
    observer.disconnect();
    expect([...seen].filter((id) => live.has(id))).toEqual([]);
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

  test("at 375 px a door burst and a long AI title read in full (PLAN §5.2)", async () => {
    await page.viewport(375, 800);
    try {
      const m = await mount({ parent: document.body });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      const titleOf = (pred: (r: HTMLElement) => boolean, what: string) =>
        must(rows(m).find(pred)?.querySelector<HTMLElement>(".title"), what);
      // The example day has a four-step front door burst and an AI title of 36 characters;
      // at this width neither fits on one line (presence is on, so the title column is narrow).
      const burst = titleOf(
        (r) => (r.dataset.id ?? "").startsWith("burst:") && r.textContent.includes("Front door"),
        "burst title",
      );
      const car = titleOf(
        (r) => r.textContent.includes("Unfamiliar car waits in the driveway"),
        "AI title",
      );
      for (const title of [burst, car]) {
        expect(title.getClientRects().length, "rendered").toBeGreaterThan(0);
        // Nothing hidden sideways or below the line clamp.
        expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
        expect(title.scrollHeight).toBeLessThanOrEqual(title.clientHeight + 1);
        // And it really wrapped: more than one line.
        const line = parseFloat(getComputedStyle(title).lineHeight) || 20;
        expect(title.clientHeight).toBeGreaterThan(line * 1.5);
      }
    } finally {
      await page.viewport(1024, 900);
    }
  });

  test("at 320 px titles clamp at 2 lines, a burst at 3, and an opened row shows all", async () => {
    const m = await mount({ width: 320 });
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    await m.card.updateComplete;
    const rowWith = (text: string) =>
      must(
        rows(m).find((r) => r.textContent.includes(text)),
        text,
      );
    // One line: the height of a short title (Alex coming home).
    const line = must(rowWith("Alex").querySelector<HTMLElement>(".title")).clientHeight;
    const lines = (el: HTMLElement) => Math.round(el.clientHeight / line);
    // "Front door: Unlocked ×5 · Open · Closed · Locked" needs four lines here.
    const burst = must(rowWith("Unlocked ×5").querySelector<HTMLElement>(".title"));
    expect(lines(burst)).toBe(3);
    expect(burst.scrollHeight).toBeGreaterThan(burst.clientHeight);
    // "Unfamiliar car waits in the driveway" needs three.
    const carRow = rowWith("Unfamiliar car waits in the driveway");
    const car = must(carRow.querySelector<HTMLElement>(".title"));
    expect(lines(car)).toBe(2);
    expect(car.scrollHeight).toBeGreaterThan(car.clientHeight);

    // Opened, the row shows the whole title.
    await userEvent.click(carRow);
    await m.card.updateComplete;
    expect(car.scrollHeight).toBeLessThanOrEqual(car.clientHeight + 1);
    expect(lines(car)).toBeGreaterThanOrEqual(3);
  });

  test("comfortable keeps its big preview in a narrow card, and takes the small one on a phone", async () => {
    const thumb = async (width: number) => {
      const m = await mount({ width, config: { density: "comfortable" } });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      const t = must(root(m).querySelector<HTMLElement>(".row.camera .thumb"), "thumbnail");
      const r = t.getBoundingClientRect();
      m.remove();
      mounted = undefined;
      return [Math.round(r.width), Math.round(r.height)];
    };
    // PLAN §5.2: comfortable is 112×63; on a phone, compact's 64×36.
    expect(await thumb(440)).toEqual([112, 63]);
    expect(await thumb(375)).toEqual([64, 36]);
  });
});
