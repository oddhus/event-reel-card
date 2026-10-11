import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Rolldown } from "vite";
import { INLINED, bundledNotices, formatBanner, packageDir } from "../build/third-party-notices";

function chunkOf(modules: Record<string, number>): Rolldown.RenderedChunk {
  const entries = Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }]);
  return { modules: Object.fromEntries(entries) } as unknown as Rolldown.RenderedChunk;
}

describe("packageDir", () => {
  it("finds the package that holds a module", () => {
    expect(packageDir("C:\\work\\node_modules\\@scope\\pkg\\dist\\index.js")).toBe(
      "C:/work/node_modules/@scope/pkg",
    );
    expect(packageDir("/work/node_modules/outer/node_modules/inner/lib/a.mjs")).toBe(
      "/work/node_modules/outer/node_modules/inner",
    );
    expect(packageDir("/work/node_modules/pkg/index.js?commonjs-proxy")).toBe(
      "/work/node_modules/pkg",
    );
    expect(packageDir("/home/u/C#?proj/node_modules/pkg/index.js")).toBe(
      "/home/u/C#?proj/node_modules/pkg",
    );
  });

  it("ignores the card's own and virtual modules", () => {
    expect(packageDir("/work/src/card.ts")).toBeUndefined();
    expect(packageDir("\0rolldown/runtime.js")).toBeUndefined();
    expect(packageDir("/work/node_modules/@scope")).toBeUndefined();
  });
});

describe("formatBanner", () => {
  it("prints each license text once, after the packages it covers", () => {
    const banner = formatBanner("Card 1.0. Licenses:", [
      { package: "b 2.0.0", license: "MIT", text: "Copyright B\n\n  Permission granted.\n" },
      { package: "c 1.0.0", license: "ISC", text: "Copyright C\n" },
      { package: "a 1.0.0", license: "MIT", text: "Copyright B\r\n\r\n\r\nPermission   granted." },
    ]);
    expect(banner).toBe(
      "/*! Card 1.0. Licenses:\n\n" +
        "a 1.0.0, b 2.0.0 (MIT):\nCopyright B\n\nPermission granted.\n\n" +
        "c 1.0.0 (ISC):\nCopyright C\n*/",
    );
  });

  it("prints the Apache terms once, after each package's own notice", () => {
    const terms =
      "Apache License\nVersion 2.0, January 2004\n\n1. Definitions.\n\nEND OF TERMS AND CONDITIONS";
    const appendix =
      "APPENDIX: How to apply the Apache License to your work.\n\nTo apply ...\nidentification within third-party archives.";
    const banner = formatBanner("Licenses:", [
      {
        package: "p 1.0.0",
        license: "Apache-2.0",
        text: `   ${terms.replace(/\n/g, "\n      ")}\n\nCopyright P`,
      },
      { package: "q 2.0.0", license: "Apache-2.0", text: `${terms}\n\n${appendix}\n\nCopyright Q` },
      {
        package: "r 3.0.0",
        license: "Apache-2.0",
        text: "Copyright R. Licensed under the Apache License.",
      },
    ]);
    expect(banner).toBe(
      "/*! Licenses:\n\n" +
        "p 1.0.0 (Apache-2.0):\nCopyright P\n\n" +
        "q 2.0.0 (Apache-2.0):\nCopyright Q\n\n" +
        "r 3.0.0 (Apache-2.0):\nCopyright R. Licensed under the Apache License.\n\n" +
        "Terms of the Apache License 2.0 above:\n" +
        "Apache License\nVersion 2.0, January 2004\n\n1. Definitions.\n\nEND OF TERMS AND CONDITIONS\n*/",
    );
  });

  it("keeps a text from closing the comment early", () => {
    const banner = formatBanner("Licenses:", [
      { package: "x 1.0.0", text: "see /* notes */ and **/" },
    ]);
    expect(banner.indexOf("*/")).toBe(banner.length - 2);
    expect(banner).toContain("x 1.0.0:\n");
  });
});

describe("bundledNotices", () => {
  it("covers bundled packages with code, and the code hls.js inlines", () => {
    const root = join(process.cwd(), "node_modules");
    const notices = bundledNotices(
      chunkOf({
        [join(root, "hls.js", "dist", "hls.light.mjs")]: 1000,
        [join(root, "lit-html", "lit-html.js")]: 500,
        [join(root, "lit", "index.js")]: 0,
        [join(process.cwd(), "src", "event-reel-card.ts")]: 2000,
      }),
    );
    const labels = notices.map((n) => n.package);
    expect(labels).toHaveLength(6);
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^hls\.js \d+\.\d+\.\d+$/),
        expect.stringMatching(/^lit-html \d+\.\d+\.\d+$/),
        expect.stringMatching(/^@svta\/cml-id3 \S+ inside hls\.js$/),
        expect.stringMatching(/^@svta\/cml-utils \S+ inside hls\.js$/),
        expect.stringMatching(/^eventemitter3 \S+ inside hls\.js$/),
        expect.stringMatching(/^url-toolkit \S+ inside hls\.js$/),
      ]),
    );
    const byName = (prefix: string) => notices.find((n) => n.package.startsWith(prefix))!;
    expect(byName("hls.js").license).toBe("Apache-2.0");
    expect(byName("hls.js").text).toContain("Dailymotion");
    expect(byName("lit-html").text).toContain("BSD 3-Clause License");
    expect(byName("@svta/cml-id3").text).toContain("Streaming Video Technology Alliance");
    expect(byName("eventemitter3").text).toContain("Arnout Kazemier");
    expect(byName("url-toolkit").text).toContain("Tom Jenkinson");
    expect(byName("url-toolkit").text).toContain("TERMS AND CONDITIONS FOR USE");
  });

  it("fails the build when a bundled package has no license file", () => {
    expect(() => bundledNotices(chunkOf({ "/work/node_modules/@scope": 10 }))).toThrow(
      /Can't tell which package/,
    );
    const root = mkdtempSync(join(tmpdir(), "notices-"));
    try {
      const dir = join(root, "node_modules", "unlicensed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), '{"name":"unlicensed","version":"1.0.0"}');
      expect(() => bundledNotices(chunkOf({ [join(dir, "index.js")]: 10 }))).toThrow(
        /No LICENSE file for bundled package unlicensed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// hls.js inlines other packages into its dist. Its source map names them, either as
// node_modules sources or as imports inside those sources, so an hls.js update that
// changes them fails here until INLINED and build/licenses/ follow.
describe("code inlined by hls.js", () => {
  const hlsDir = join(process.cwd(), "node_modules", "hls.js");
  const hlsPkg = JSON.parse(readFileSync(join(hlsDir, "package.json"), "utf8"));
  const packageName = (spec: string) =>
    spec
      .split("/")
      .slice(0, spec.startsWith("@") ? 2 : 1)
      .join("/");

  it("lists every package in the hls.js build the card imports", () => {
    // The card imports "hls.js/light" as an ES module.
    const entry = join(hlsDir, hlsPkg.exports["./light"].import);
    const map = JSON.parse(readFileSync(`${entry}.map`, "utf8"));
    const found = new Set<string>();
    map.sources.forEach((source: string, i: number) => {
      const inNodeModules = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source);
      if (inNodeModules) found.add(inNodeModules[1]);
      const code: string = map.sourcesContent[i] ?? "";
      const imports = code.matchAll(
        /\b(?:(?:import|export)\s+(type\s)?[^'";]*?\bfrom\s*|require\(\s*)['"]([^'"./][^'"]*)['"]/g,
      );
      for (const [, typeOnly, spec] of imports) if (!typeOnly) found.add(packageName(spec));
    });
    expect([...found].sort()).toEqual(INLINED["hls.js"].map((p) => p.name).sort());
  });

  it("records the versions hls.js pins", () => {
    for (const inlined of INLINED["hls.js"]) {
      expect(`${inlined.name} ${inlined.version}`).toBe(
        `${inlined.name} ${hlsPkg.devDependencies[inlined.name]}`,
      );
    }
  });
});
