# Contributing

Contributions to Event Reel Card are welcome: bug reports, fixes, features, translations
and documentation. Before opening a PR, establish why the change belongs in the card and
complete the review and verification below.

These rules apply to every PR, including drafts. Meeting them makes a PR eligible for
merge. The maintainer decides whether to merge it.

<a id="ai"></a>

## AI-assisted contributions are welcome

You may use AI coding agents, such as Claude Code, Codex, Copilot or Cursor, for any part
of a contribution: code, tests, documentation and reviews. Much of this card was written
that way. The rules are the same for changes written by an agent and by hand:

- **You own the change.** Read the whole diff before you open the PR, be able to explain
  it, and run the checks yourself. "The agent wrote it" doesn't answer a review comment.
- **Give the agent [AGENTS.md](AGENTS.md).** It holds the code, test and privacy
  conventions. Most agents read it on their own; Claude Code reads it through
  [CLAUDE.md](CLAUDE.md).
- **Say what the agent did.** In the PR's Review section, name the tool, which parts it
  wrote and how you checked them. This helps the review and doesn't count against the
  PR.
- **Watch for private data.** An agent connected to your Home Assistant (through an MCP
  server, say) easily copies your real entity ids, names or API responses into examples,
  tests and PR text. Check before you commit (see [Keep your home out of it](#privacy)).
- **Send only what you stand behind.** PRs that were never run, whose description
  doesn't match the diff, or that arrive as an unreviewed batch get closed.

## Reporting a bug

Open an issue with the card version, your Home Assistant version, the browser or
Companion app, the relevant card configuration with your own names replaced, what you
expected and what happened, and any errors from the browser console. Name the Frigate,
Frigate integration or LLM Vision version when the bug involves them.

## Setup and workflow

You need Node 24 (the version CI uses).

```bash
npm install
npm run dev     # dev harness with a mock hass at http://localhost:5173
```

Read [AGENTS.md](AGENTS.md) for the code, styling, documentation and test conventions,
and [PLAN.md](PLAN.md) for the design: the verified API facts, the architecture and the
UI spec. PLAN.md §7 describes the dev harness.

For a new feature, provider or option, open an issue first so we can agree on the
approach before you build it. Bug fixes and small improvements can go straight to a PR.

<a id="belongs-in-the-card"></a>

## Ask first: does it belong in the card?

Before adding a feature, option or provider, ask: "Is this a good addition to the card,
or does it belong in my Home Assistant configuration, an automation or another card?"

An addition to the card should meet these criteria:

- It serves the card's purpose: one compact timeline of the day's events, with the
  media behind them.
- It helps other installs, not only yours. Install-specific needs belong in the card's
  configuration (`entities`, `camera_aliases`, `cameras`) or in your own automations,
  not in special cases in the code.
- It keeps the card frontend only and useful with Home Assistant core alone. Support for
  another integration is an optional provider that is detected, degrades quietly and
  uses only APIs in that integration's latest release ([PLAN.md](PLAN.md) §3.8).
- It adds no runtime dependency without a clear gain. The card ships as one file to
  every dashboard that uses it.

The rule has exceptions. Explain the general need in the PR when you make one.

<a id="one-problem"></a>

## Solve one problem per PR

Split a PR that solves several independent problems, even when each fix is useful on
its own. Count the underlying problems, not the linked issues.

Include the source, tests, translations and documentation the problem requires: add
user-facing changes under `Unreleased` in [CHANGELOG.md](CHANGELOG.md), and update the
[README](README.md) when usage changes. Put unrelated cleanup and other fixes in
separate PRs.

<a id="pr-title"></a>

## Title the PR as a plain sentence

Write the PR title as a plain-language sentence in the imperative and in sentence case,
such as "Keep the camera filter when a camera has no events today". Keep code names in
their own casing and leave out conventional commit prefixes such as `fix:`. PRs are
squash-merged, so the title becomes the commit subject on `main` and a line in the
release notes.

<a id="review-before-submitting"></a>

## Review it before you open it

Complete a full review pass before opening a PR, or before marking a draft ready for
review.

Use a reviewer other than the code's author: another person, or an AI agent with a
fresh context. When an agent wrote the change, the person who directed it can review it.
The reviewer checks the complete diff and the relevant surrounding code against the
agreed scope, this guide and [AGENTS.md](AGENTS.md). Say in the PR who reviewed it.

<a id="verification"></a>

## Show that it works

Explain how you established the problem and how you checked the change. Record the
commands and manual checks you ran, the results and anything you could not check.

- `npm run lint`, `npm test` and `npm run build` pass. CI runs the same.
- Behavior changes include tests that follow [AGENTS.md](AGENTS.md#tests).
- UI changes are checked in the dev harness, in light and dark themes and at phone width
  (375 px). Changes to media playback, URL signing, live updates or the visual editor
  are also checked in a real Home Assistant, since the harness doesn't exercise them.
- Name the versions you tested against when they matter: Home Assistant, Frigate and its
  integration, LLM Vision, and the browser or Companion app.
- Visual changes include before and after screenshots. For new UI, show the result. Add
  a short recording when motion, timing or interaction is part of the change. Take them
  from the dev harness's example data, upload them to the PR and keep them out of the
  repository. The README screenshots in `docs/` are the only exception.

<a id="privacy"></a>

## Keep your home out of it

This repository is public. Keep real entity ids, names, hostnames, IPs, tokens, camera
footage and screenshots of your home out of code, tests, fixtures, documentation, commit
messages, PR text and screenshots. Use neutral examples such as `camera.entrance` and
`person.alex`.

Keep notes about your own install in a gitignored `CLAUDE.local.md` or `AGENTS.local.md`,
and real data snapshots in `dev/fixtures/*.local.json`. Check `git diff --cached` before
every commit.

When a bug shows only with your data, describe its shape, such as "a review that starts
before the AI event and has no end time", or anonymize the data before you attach it.

## Merging and closing

Before merging, the maintainer checks the problem, whether it belongs in the card, the
scope and the verification evidence. The maintainer also cuts the releases.

The maintainer may close a PR or request changes when it belongs elsewhere, solves
several independent problems, lacks a completed review or evidence, or contains private
data. The closing comment names the rule and explains what would change the outcome.

Address the reason and reopen the PR, or open focused replacement PRs and link them to
the original.
