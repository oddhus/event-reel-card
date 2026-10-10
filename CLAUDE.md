# Event Reel Card

A Home Assistant Lovelace card: a compact timeline of the day's events with animated
Frigate previews and exact clips, LLM Vision summaries, Nest, and entity/logbook events.

- **Start with `PLAN.md`.** It is the design brief: verified API facts, architecture,
  config, UI spec, milestones and acceptance criteria. Keep it updated when decisions
  change.
- `CLAUDE.local.md` (gitignored, may not exist) holds private notes about the reference
  install: hosts, entity ids, camera mapping, deploy steps. Use it for testing, and
  **never copy its contents into tracked files.**

## Conventions

- TypeScript + Lit 3, Vite library build to one file `dist/event-reel-card.js`, Vitest
  for tests.
- Providers fetch and normalize data. They never render. UI components never call HA
  APIs directly; they go through providers and `core/media.ts`.
- Use HA CSS variables for all colors. Keep all user-facing strings in `src/i18n` (en, nb).
- Keep the pure logic (camera mapping, merge, grouping, time) free of DOM and `hass`
  object access, so it can be unit tested.

## Commands

- `npm run dev`: dev harness with mock `hass` and a Frigate proxy (`FRIGATE_URL` in `.env.local`)
- `npm test`, `npm run lint`, `npm run build`

## Public-repo hygiene

This repository is intended to become public. Don't commit real entity ids, names, IPs,
tokens, camera footage or real fixtures. Use neutral examples (`camera.entrance`,
`person.alex`). Check `git diff --cached` before committing.
