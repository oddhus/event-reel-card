import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rolldown } from "vite";

// The minifier drops the `@license` comments of bundled code, and hls.js ships none, so the
// build prepends one banner with the LICENSE file of every package that has code in the
// bundle (what Vite's `build.license` collects, but inside the one file HACS installs).

/** A license text and the package it covers. */
export interface Notice {
  /** `name version`, or `name version inside host` */
  package: string;
  /** SPDX expression from package.json */
  license?: string;
  text: string;
}

/**
 * Code that a bundled package inlines into its own dist files, so it has no node_modules
 * entry of its own. `file` is that package's LICENSE file from npm, kept in `build/licenses/`.
 * The tests compare this list with hls.js's source map and pinned versions.
 */
export const INLINED: Record<
  string,
  { name: string; version: string; license: string; file: string }[]
> = {
  "hls.js": [
    {
      name: "@svta/cml-id3",
      version: "1.0.6",
      license: "Apache-2.0",
      file: "svta-cml-id3.LICENSE",
    },
    {
      name: "@svta/cml-utils",
      version: "1.5.0",
      license: "Apache-2.0",
      file: "svta-cml-utils.LICENSE",
    },
    { name: "eventemitter3", version: "5.0.4", license: "MIT", file: "eventemitter3.LICENSE" },
    { name: "url-toolkit", version: "2.2.5", license: "Apache-2.0", file: "url-toolkit.LICENSE" },
  ],
};

const LICENSE_FILE = /^(licen[sc]e|copying)(\.|$)/i;
const INLINED_DIR = fileURLToPath(new URL("./licenses/", import.meta.url));

// Several Apache-2.0 LICENSE files repeat the full terms ahead of their own copyright notice.
// The terms are printed once at the end. The appendix only tells licensors how to apply them.
const APACHE_TERMS =
  /Apache License\nVersion 2\.0, January 2004\n[\s\S]*?\nEND OF TERMS AND CONDITIONS/;
const APACHE_APPENDIX =
  /APPENDIX: How to apply the Apache License to your work\.[\s\S]*?\nidentification within third-party archives\./;

/** The package directory that holds a bundled module, or undefined outside node_modules. */
export function packageDir(moduleId: string): string | undefined {
  if (moduleId.startsWith("\0")) return undefined;
  const path = moduleId.replace(/\\/g, "/").replace(/[?#][^/]*$/, "");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const depth = rest[0].startsWith("@") ? 2 : 1;
  if (rest.length <= depth) return undefined;
  return path.slice(0, at + "/node_modules/".length) + rest.slice(0, depth).join("/");
}

/**
 * Collapses whitespace inside each line and drops blank-line runs. The words stay as
 * published; only the layout changes (license matching ignores whitespace too).
 */
function compact(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One block comment: the header, then each distinct license text after the packages it covers. */
export function formatBanner(header: string, notices: Notice[]): string {
  const groups = new Map<string, Notice[]>();
  const apacheTerms = new Set<string>();
  for (const notice of notices) {
    let key = compact(notice.text);
    const terms = APACHE_TERMS.exec(key)?.[0];
    if (terms) {
      apacheTerms.add(terms);
      key = compact(key.replace(terms, "").replace(APACHE_APPENDIX, ""));
    }
    groups.set(key, [...(groups.get(key) ?? []), notice]);
  }
  const blocks = [...groups].map(([text, covered]) => {
    const names = covered.map((n) => n.package).sort();
    const licenses = [...new Set(covered.flatMap((n) => n.license ?? []))].join(", ");
    return `${names.join(", ")}${licenses ? ` (${licenses})` : ""}:\n${text}`;
  });
  for (const terms of apacheTerms) blocks.push(`Terms of the Apache License 2.0 above:\n${terms}`);
  // Nothing inside may end the comment early.
  return `/*! ${[header, ...blocks].join("\n\n").replace(/\*\//g, "* /")}\n*/`;
}

function licenseText(dir: string, name: string): string {
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  if (!file) throw new Error(`No LICENSE file for bundled package ${name} in ${dir}`);
  return readFileSync(join(dir, file), "utf8");
}

/** Notices for the packages with code in this chunk, including code they inline. */
export function bundledNotices(chunk: Rolldown.RenderedChunk): Notice[] {
  const dirs = new Set<string>();
  for (const [id, module] of Object.entries(chunk.modules)) {
    if (module.renderedLength === 0) continue;
    const dir = packageDir(id);
    if (dir) dirs.add(dir);
    else if (/[\\/]node_modules[\\/]/.test(id) && !id.startsWith("\0")) {
      throw new Error(`Can't tell which package bundled module ${id} belongs to`);
    }
  }
  const notices: Notice[] = [];
  for (const dir of dirs) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) throw new Error(`No package.json for bundled code in ${dir}`);
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    const name = String(pkg.name);
    notices.push({
      package: `${name} ${String(pkg.version)}`,
      license: typeof pkg.license === "string" ? pkg.license : undefined,
      text: licenseText(dir, name),
    });
    for (const inlined of INLINED[name] ?? []) {
      notices.push({
        package: `${inlined.name} ${inlined.version} inside ${name}`,
        license: inlined.license,
        text: readFileSync(join(INLINED_DIR, inlined.file), "utf8"),
      });
    }
  }
  return notices;
}
