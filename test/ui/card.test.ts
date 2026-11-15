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

  test("comfortable keeps its big preview in a narrow card on a desktop, the small one on a phone", async () => {
    const measure = async (width = 440) => {
      const m = await mount({ width, config: { density: "comfortable" } });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      const row = must(root(m).querySelector<HTMLElement>(".row.camera"), "camera row");
      const t = must(row.querySelector<HTMLElement>(".thumb"), "thumbnail").getBoundingClientRect();
      const out = {
        thumb: [Math.round(t.width), Math.round(t.height)],
        minHeight: getComputedStyle(row).minHeight,
        tall: row.getBoundingClientRect().height >= 72,
      };
      m.remove();
      mounted = undefined;
      return out;
    };
    // PLAN §5.2: comfortable is 112×63 with 72 px rows. A 440 px card on a desktop screen
    // (a sections view column) keeps that; on a phone, or in a card under 400 px, the
    // thumbnail is compact's 64×36 and the row keeps its height.
    const big = { thumb: [112, 63], minHeight: "72px", tall: true };
    const small = { thumb: [64, 36], minHeight: "72px", tall: true };
    expect(await measure()).toEqual(big);
    // A card under 400 px on a desktop screen (the editor preview, a narrow column): small.
    expect(await measure(360)).toEqual(small);
    await page.viewport(440, 900);
    try {
      expect(await measure()).toEqual(small);
    } finally {
      await page.viewport(1024, 900);
    }
  });

  test("from 481 to 600 px the title keeps room, the camera line under it", async () => {
    // PLAN §5.2: up to 600 px the camera/duration text goes under the title. Before, a 481 px
    // card put it in a column and left the title about 130 px (80 px in comfortable).
    for (const density of ["compact", "comfortable"] as const) {
      for (const width of [481, 560, 600]) {
        const m = await mount({ width, config: { density } });
        await until(() => ids(m).some((id) => id.startsWith("frigate:")));
        await m.card.updateComplete;
        const titles = rows(m).map((r) => must(r.querySelector<HTMLElement>(".title")).clientWidth);
        expect(Math.min(...titles), `${density} at ${width} px`).toBeGreaterThanOrEqual(180);
        const row = must(root(m).querySelector<HTMLElement>(".row.camera"));
        const meta = must(row.querySelector<HTMLElement>(".meta"));
        expect(getComputedStyle(meta).display).toBe("none");
        // The camera and duration show under the title instead.
        const sub = must(row.querySelector<HTMLElement>(".sub"), "camera line");
        expect(getComputedStyle(sub).display).not.toBe("none");
        expect(sub.textContent).toBe(meta.textContent);
        expect(sub.textContent.trim()).not.toBe("");
        m.remove();
        mounted = undefined;
      }
    }
    // Above 600 px the column is back.
    const wide = await mount({ width: 601 });
    await until(() => ids(wide).some((id) => id.startsWith("frigate:")));
    await wide.card.updateComplete;
    const meta = must(root(wide).querySelector<HTMLElement>(".row.camera .meta"));
    expect(getComputedStyle(meta).display).not.toBe("none");
  });

  test("at 375 px the chip bar shows which side has more chips, and the camera menu is an icon", async () => {
    await page.viewport(375, 800);
    try {
      const m = await mount({ parent: document.body });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      const bar = must(root(m).querySelector<HTMLElement>(".chipbar"), "chip bar");
      const faded = () => [
        bar.classList.contains("more-left"),
        bar.classList.contains("more-right"),
      ];
      // The example day has more chips than fit: more to the right at first …
      expect(bar.scrollWidth).toBeGreaterThan(bar.clientWidth);
      await until(() => faded()[1]);
      expect(faded()).toEqual([false, true]);
      // … more on both sides in the middle, and only to the left at the end.
      bar.scrollLeft = 40;
      await until(() => faded()[0]);
      expect(faded()).toEqual([true, true]);
      bar.scrollLeft = bar.scrollWidth;
      await until(() => !faded()[1]);
      expect(faded()).toEqual([true, false]);

      // The camera menu takes an icon's room until a camera is picked, then shows its name.
      const wrap = must(root(m).querySelector<HTMLElement>(".camwrap"), "camera menu");
      expect(wrap.getBoundingClientRect().width).toBeLessThanOrEqual(40);
      const select = must(wrap.querySelector<HTMLSelectElement>("select"));
      expect(select.getAttribute("aria-label")).toBe(en["filter.camera"]);
      select.value = select.options[1].value;
      select.dispatchEvent(new Event("change"));
      await m.card.updateComplete;
      expect(wrap.getBoundingClientRect().width).toBeGreaterThan(60);
      expect(getComputedStyle(select).opacity).toBe("1");
    } finally {
      await page.viewport(1024, 900);
    }
  });

  test("right to left, the fade is on the left, where the hidden chips are", async () => {
    await page.viewport(375, 800);
    const parent = document.createElement("div");
    parent.dir = "rtl";
    document.body.appendChild(parent);
    try {
      const m = await mount({ parent });
      await until(() => ids(m).some((id) => id.startsWith("frigate:")));
      await m.card.updateComplete;
      const bar = must(root(m).querySelector<HTMLElement>(".chipbar"), "chip bar");
      const faded = () => [
        bar.classList.contains("more-left"),
        bar.classList.contains("more-right"),
      ];
      expect(getComputedStyle(bar).direction).toBe("rtl");
      await until(() => faded()[0]);
      expect(faded()).toEqual([true, false]);
      // Scrolled to the far end (the left), only the right has more.
      bar.scrollLeft = -bar.scrollWidth;
      await until(() => !faded()[0]);
      expect(faded()).toEqual([false, true]);
    } finally {
      parent.remove();
      await page.viewport(1024, 900);
    }
  });
});

describe("Unreviewed and Nobody home chips (PLAN §5.1, §5.10)", () => {
  const chipByClass = (m: Mounted, cls: string) =>
    must(root(m).querySelector<HTMLElement>(`.fchip.${cls}`), cls);

  const frigateIds = (m: Mounted) => ids(m).filter((id) => id.startsWith("frigate:"));
  const frigateId = (reviewId: string) => `frigate:frigate:${reviewId}`;

  test("Unreviewed keeps only the reviews nobody marked, and counts them", async () => {
    // One review of the example day is marked reviewed in Frigate before the card loads.
    const m = await mount({ hold: ["frigate"] });
    const reviewed = m.data.reviews[0];
    reviewed.has_been_reviewed = true;
    m.release("frigate");
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    const expected = m.data.reviews.filter((r) => !r.has_been_reviewed).map((r) => frigateId(r.id));
    expect(expected.length).toBe(m.data.reviews.length - 1);

    const chip = chipByClass(m, "unreviewedchip");
    expect(Number(chip.querySelector(".n")?.textContent)).toBe(expected.length);
    await userEvent.click(chip);
    await m.card.updateComplete;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Only Frigate rows, and exactly the unreviewed ones.
    expect(ids(m).every((id) => id.startsWith("frigate:"))).toBe(true);
    expect([...frigateIds(m)].sort()).toEqual([...expected].sort());
    expect(ids(m)).not.toContain(frigateId(reviewed.id));
  });

  test("Nobody home keeps only the events while nobody was home", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    // From the example's presence history: the house is empty from Sam leaving (Alex left
    // earlier) until Sam comes back. The first and last 10 minutes aren't flagged (PLAN §5.10).
    const left = (id: string) =>
      Math.max(...m.data.history[id].filter((r) => r.s === "not_home").map((r) => r.lu));
    const empty = { start: Math.max(left("person.alex"), left("person.sam")) + 600 };
    const back = Math.min(
      ...["person.alex", "person.sam"].flatMap((id) =>
        m.data.history[id].filter((r) => r.s === "home" && r.lu > empty.start).map((r) => r.lu),
      ),
    );
    const end = back - 600;
    const inside = m.data.reviews
      .filter((r) => r.start_time >= empty.start && r.start_time <= end)
      .map((r) => frigateId(r.id));
    expect(inside.length).toBeGreaterThan(0);

    const chip = chipByClass(m, "nobodychip");
    await userEvent.click(chip);
    await m.card.updateComplete;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Every review inside the empty house shows, and none outside it.
    expect([...frigateIds(m)].sort()).toEqual([...inside].sort());
    // Every row left is flagged; the chip counts them.
    for (const r of rows(m)) expect(r.querySelector(".home .nobody"), r.dataset.id).not.toBeNull();
    expect(Number(chip.querySelector(".n")?.textContent)).toBe(rows(m).length);
  });

  test("a picked chip stays on an empty day, so it can be switched off there", async () => {
    // Without context bands, which would keep the bar up on their own.
    const m = await mount({ config: { context: [] } });
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    await userEvent.click(chipByClass(m, "unreviewedchip"));
    await m.card.updateComplete;

    // The example data has nothing yesterday, so the list shows the empty state.
    await userEvent.click(must(root(m).querySelector<HTMLElement>(".navbtn.prev")));
    await until(() => status(m) === en["empty.yesterday"]);
    const chip = chipByClass(m, "unreviewedchip");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(chip);
    await m.card.updateComplete;
    expect(root(m).querySelector(".fchip.unreviewedchip[aria-pressed=true]")).toBeNull();
  });

  const markInDetail = async (m: Mounted) => {
    const button = must(
      [...root(m).querySelectorAll<HTMLElement>(".detail button")].find(
        (b) => b.textContent.trim() === en["action.mark_reviewed"],
      ),
      "Mark reviewed",
    );
    await userEvent.click(button);
    await m.card.updateComplete;
    await m.card.updateComplete;
  };

  test("marking a row with Unreviewed picked closes it and moves focus to the next row", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    await userEvent.click(chipByClass(m, "unreviewedchip"));
    await m.card.updateComplete;
    const before = ids(m);
    expect(before.length).toBeGreaterThan(2);
    // The second row: there is a row after it and one before it.
    await userEvent.click(rows(m)[1]);
    await m.card.updateComplete;
    await markInDetail(m);

    await until(() => ids(m).length === before.length - 1);
    expect(ids(m)).toEqual([before[0], ...before.slice(2)]);
    expect(rows(m).filter((r) => r.getAttribute("aria-expanded") === "true")).toEqual([]);
    expect(root(m).activeElement).toBe(rows(m)[1]);
    expect((root(m).activeElement as HTMLElement).dataset.id).toBe(before[2]);

    // Switching the chip off doesn't open the marked row again.
    await userEvent.click(chipByClass(m, "unreviewedchip"));
    await m.card.updateComplete;
    expect(root(m).querySelectorAll(".detail")).toHaveLength(0);
  });

  test("marking the last unreviewed row leaves focus on the picked chip", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    await userEvent.click(chipByClass(m, "unreviewedchip"));
    await m.card.updateComplete;
    // Mark all but one with the toolbar button's action, then the last one from its detail.
    while (rows(m).length > 1) {
      await userEvent.click(rows(m)[0]);
      await m.card.updateComplete;
      const n = rows(m).length;
      await markInDetail(m);
      await until(() => rows(m).length === n - 1);
    }
    await userEvent.click(rows(m)[0]);
    await m.card.updateComplete;
    await markInDetail(m);
    await until(() => rows(m).length === 0);
    expect(root(m).activeElement).toBe(chipByClass(m, "unreviewedchip"));
  });

  test("a chip that hides the open row closes it", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    // A row with people home, opened, then hidden by Nobody home.
    const home = must(
      rows(m).find((r) => r.classList.contains("camera") && !r.querySelector(".home .nobody")),
      "camera row with people home",
    );
    const id = home.dataset.id;
    await userEvent.click(home);
    await m.card.updateComplete;
    expect(root(m).querySelectorAll(".detail")).toHaveLength(1);
    await userEvent.click(chipByClass(m, "nobodychip"));
    await m.card.updateComplete;
    expect(ids(m)).not.toContain(id);
    await userEvent.click(chipByClass(m, "nobodychip"));
    await m.card.updateComplete;
    expect(ids(m)).toContain(id);
    expect(root(m).querySelectorAll(".detail")).toHaveLength(0);
  });

  test("a change to presence clears the Nobody home pick", async () => {
    const m = await mount();
    await until(() => ids(m).some((id) => id.startsWith("frigate:")));
    await userEvent.click(chipByClass(m, "nobodychip"));
    await m.card.updateComplete;
    const all = ids(m).length;
    m.card.setConfig({ ...m.config, presence: ["person.alex"] });
    await until(() => !!root(m).querySelector(".fchip.nobodychip"));
    expect(chipByClass(m, "nobodychip").getAttribute("aria-pressed")).toBe("false");
    await until(() => ids(m).length >= all);
  });
});
