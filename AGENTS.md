# Working on Event Reel Card

A Home Assistant Lovelace card: a compact timeline of the day's events with animated
Frigate previews and exact clips, LLM Vision summaries, Nest, and entity/logbook events.
It builds to one file, `dist/event-reel-card.js`, and installs through HACS.

Start with [PLAN.md](PLAN.md). It is the design brief: verified API facts (§2),
architecture (§3), configuration (§4), UI spec (§5), backlog (§6) and milestones (§9).
Update it when a decision changes.

## Commands

- `npm run dev`: dev harness with a mock `hass` at http://localhost:5173, and a Frigate
  proxy when `FRIGATE_URL` is set in `.env.local`
- `npm test`, `npm run lint` (oxlint and `tsc --noEmit`), `npm run lint:fix`, `npm run build`

## Architecture

Write TypeScript and Lit 3 without decorators: `static properties` and `declare` fields.
Providers in `src/providers/` fetch data and normalize it into `ReelEvent`s. They never
render. UI components never call HA APIs directly; they go through the providers and
`core/media.ts`, which signs, resolves and caches media URLs.
Put new templates in `src/ui/` as functions of a `CardView` (`ui/view.ts`).
`event-reel-card.ts` keeps the HA card API, lifecycle, data and interaction, and a
`render()` that lays the templates out.
Keep the pure logic in `src/core/` (camera mapping, merge, grouping, time, filters, the
day strip) free of DOM and `hass` access, so it can be unit tested.
Keep each integration in one provider file with a small parser, so a change upstream is
a one-file fix.

## Dependencies and HA APIs

The card is frontend only and must stay useful with HA core alone ([PLAN.md](PLAN.md)
§3.8). Frigate, LLM Vision and Nest are optional providers: detect them in
`core/capabilities.ts`, skip them quietly when they were auto-enabled, and show a warning
chip only when they were configured explicitly. A broken media route falls back to the
next `MediaRef`.
Use only APIs present in an integration's latest released version, and prefer documented
services over private endpoints. Check a new API against the integration's source or a
live install before relying on it, and record what you verified in PLAN.md §2.
The runtime dependencies are `lit` and `hls.js`. Add another only for a clear gain: the
whole card ships as one file to every dashboard that uses it. Prefer package versions
that have been published for at least two weeks.
The build puts the LICENSE file of every bundled package at the top of that file
(`build/third-party-notices.ts`) and fails when one has none. When a dependency inlines
other packages into its own dist, as hls.js does, list them in `INLINED` there with their
LICENSE files from npm in `build/licenses/`. A test compares that list with hls.js's
source map and pinned versions, so an hls.js update can fail it until you do.
Keep `homeassistant` in `hacs.json` at the oldest HA version whose frontend APIs the card
uses.

## Styling, i18n and accessibility

Use HA CSS variables for every color, and check both light and dark themes.
Keep every user-facing string in `src/i18n`. Add each key to both `en.ts` and `nb.ts`;
`nb` is typed against `en`, so lint fails when one is missing. If you don't write
Norwegian, use the English text in `nb.ts` and say so in the PR.
Label every control, keep keyboard access and visible focus, and respect
`prefers-reduced-motion`.

## Configuration

Add options in `src/config.ts` (`normalizeConfig`), document them in the README options
table, and add the common ones to the visual editor (`src/editor-model.ts`,
`src/editor.ts`). Leaving an option out must keep the current behavior. While the version
is 0.x an option may still change in a minor release; say so in the CHANGELOG.

## Lint

`npm run lint` runs oxlint with type-aware rules, then `tsc --noEmit`. The rules in
`.oxlintrc.json` follow [elmeragroup/fuse](https://github.com/elmeragroup/fuse/blob/main/.oxlintrc.json),
and warnings fail the run too. `npm run lint:fix` applies the safe fixes; run Prettier on
the files afterwards, since a fix can leave a line unformatted.
The overrides at the end of `.oxlintrc.json` that turn one rule off for a list of files
hold the violations that were there when oxlint came in. Never add a file to them. When you
change a listed file, fix its violations of that rule and take it off the list; delete an
override when its list is empty.
Disable a rule on a line only where the code is right and the rule can't see why, and give
the reason after `--`, as in `// oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface`.

## Tests

Absolutely no tautological tests. Assert behavior against expectations written
independently of the code under test. Never compute the expected result with the
implementation, or only assert that a mock returns what it was configured to return.
Unit-test pure logic and provider parsers in `test/`, with neutral fixtures.
Check UI in the dev harness: generated example data by default, `?now=<ISO time>` to pin
the clock, and `?live=1` with `FRIGATE_URL` for real Frigate media through the dev proxy.
The harness doesn't exercise HA auth, URL signing, the integration proxies or HA's card
editor (its entity pickers only work inside HA), so check changes there in a real Home
Assistant.
Before review, run `npm run lint`, `npm test` and `npm run build`. CI runs the same.

## Privacy

This repository is public. Never commit real entity ids, names, hostnames, IPs, tokens,
camera footage, screenshots of a real home, or fixtures from one. Use neutral examples
such as `camera.entrance` and `person.alex`.
Notes about a real install belong in a gitignored `CLAUDE.local.md` or `AGENTS.local.md`,
and real data snapshots in `dev/fixtures/*.local.json`. Read them for testing; never copy
their contents into tracked files.
When you can reach a real Home Assistant (through an MCP server, say), keep its ids, names
and responses out of code, tests, docs, commit messages and PR text.
Check `git diff --cached` before every commit.

## Documentation

Update the README when usage changes, and add user-facing changes under `Unreleased` in
[CHANGELOG.md](CHANGELOG.md). Take README screenshots from the dev harness's example
data. Put design decisions and verified facts in PLAN.md.
Change these instructions when a durable working convention changes.

## Task references

Before opening a PR, read [CONTRIBUTING.md](CONTRIBUTING.md) in full. Write the PR body
from [the PR template](.github/pull_request_template.md), filling each section, in place
of any generic summary format.
Releases are for the maintainer: set the version in `package.json`, move the `Unreleased`
notes in CHANGELOG.md under that version, commit, then tag `vX.Y.Z` and push the tag. The
release workflow checks that the tag matches `package.json`, runs the checks, and attaches
`event-reel-card.js` to the GitHub release, where HACS finds it.
