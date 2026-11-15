# Review log

Notes from the reviews of each milestone and PR: what the reviewers found and what
changed. Moved out of [PLAN.md](../PLAN.md) §12, which keeps the design decisions and
verified facts; the § numbers below refer to PLAN.md. Newest entries go at the end.

**2026-10-10.** Reviewed by Claude (Opus 5.5) and GPT-6-sol (xhigh), with live checks
against the reference install. Changes:
- The time-range preview route is not in the released Frigate integration (404).
  Removed from M1, feature-detected later.
- HLS signing verified end to end through HA. The `hev1` sample entry and the 4K bitrate
  make the codec fallback a main path. The fallback now triggers on real errors instead
  of a fixed `isTypeSupported` probe.
- Frigate websocket results are JSON strings, and `severity` takes one value.
- The notification proxy routes are unauthenticated by default and can be switched off,
  so there is a fallback chain for every media item.
- Merge is many-to-one, with no synthesized clips in M1, and footage is never hidden
  because of AI output by default.
- Door, lock and presence come from the entity provider instead of LLM Vision copies.
  Activity bursts and bounces are grouped.
- Doorbell clips exist, and LLM Vision events join Nest exactly by token.
- The default range is a rolling 24 h. The UI language follows HA (`auto`).
- New dependency policy (§3.8). The card works with HA core alone.
- M1 is now a thin "replace the 24 h timeline" milestone with acceptance criteria. The
  old M1–M3 feature set is spread over M1–M3 by priority.

**2026-10-10, M1 code review.** A fresh Claude (Opus 5.5) context and GPT-6-sol (xhigh)
reviewed the first M1 implementation. Fixed:
- Events keep their object identity across refreshes when unchanged, so an open clip no
  longer restarts and previews keep playing. The player restarts only for a different clip.
- The player invalidates pending loads on disconnect (no orphaned hls.js), has a start
  timeout, treats decode errors as codec failures, re-signs once on 401/403, and falls back
  from the preview to a still. Manifest signatures are cached for 5 minutes only.
- Bursts take only plain state changes; events with media but no mapped camera keep their
  own rows and group by camera label.
- A bounce needs at least 3 rapid flips (a quick open → close stays two steps). Presence
  flapping groups per person.
- Live state changes stay until the logbook returns them. Subscriptions start when a
  provider becomes available. Aliases apply to Frigate and Nest keys. Unknown Nest tokens
  are retried every 10 minutes at most. The merged clip end covers a late AI moment.
  Hour separators stay distinct on the DST fall-back day. One configured severity is sent
  to Frigate.
- Real ids in samples and tests were replaced with synthetic ones. They remain in the git
  history, so squash or rewrite it before the repository goes public.

Not changed: the integration's schema uses `Coerce(float)` for `after`/`before`, so
integer and fractional times both work.

**2026-10-10, M2 code review.** GPT-6-sol (xhigh) and a fresh Claude (Opus 5.5) context
reviewed M2. Fixed:
- Chip counts and active chips. The camera menu can't get stuck hidden, its value follows
  the filter, and per-event media keys are no longer listed as cameras.
- Deep links: they open bursts, refresh on a miss, are removed from the URL afterwards,
  and can be followed again.
- Day strip: it is a keyboard slider, accepts a touch tap or horizontal drag only, and makes
  one selection per frame. Hour marks are correct in half-hour zones. The toolbar and strip
  stick under the HA header.
- Empty state: it queries a real Frigate window, uses the card's filters, includes entities
  and asks again when rows age out.
- Editor: it validates ranges, restores a custom severity list, and returns a provider to
  "auto" when it started out absent. The card only refetches when data options change.
- Mark reviewed: failures are reported, and focus stays near the pressed control.
- Frigate items are fetched as reviewed + unreviewed and merged. Frigate 0.18 returns both
  when `reviewed` is omitted (verified in its source), but older versions default to
  unreviewed only.

**2026-10-11, loading and day navigation review.** GPT-6-sol (xhigh) and a fresh Claude
(Opus 5.5) context reviewed the provider loader and day navigation before 0.2.0. Fixed:
- A reload asked for while a request hung was lost when that request timed out; the
  timeout now starts it.
- Requests no longer pile up: a new view (day click, config change) queues behind a
  request still running for the same source instead of sending a second one.
- A deep link waits for late answers after a timeout (at most 60 s) before saying "not
  found".
- Days where DST skips midnight (America/Santiago, America/Havana) start at the jump,
  not an hour early on the evening before.
- An empty-state lookup started for the live range can't land on a past day, and it is
  asked again when the live range returns.
- Keyboard focus moves to ‹ when "Today" disappears or › is disabled.
- The day buttons read the date when clicked, so a page left open past midnight steps
  correctly; a past day's label re-renders every refresh interval.

Not changed: switching days shows "Loading…" instead of keeping the previous day's rows
up until the new day is ready, so rows never appear under the wrong date. The first-paint
gate lives in the card and has no unit test; it was checked in the dev harness with
`?slow=frigate:4` and `?slow=frigate:hang`.

**2026-10-11, improvement review after 0.2.0.** GPT-6-astra (xhigh) and Claude (Opus 5.5)
looked for improvements across the code. Fixed:
- The editor's range check had lost its regex escapes, so only "today" passed. It now
  uses the card's own range parser (`parseRangeStrict`).
- LLM Vision waited for the Nest token lookup, and a browse that never answered blocked
  it for good. The lookup now waits at most 3 s (§2.3).
- The day strip keeps a cursor separate from the 2-second highlight, so arrow keys step
  on after a pause and the slider value doesn't reset.
- Reduced motion and data saving: the player shows the still while loading, not the
  looping preview. `preview: hover` also plays on focus of the row (§5.5).
- `range: today` takes its start from `dayRange`, which handles DST skipping midnight.
- Previews drop URLs resolved for media they no longer show.
- `entities` given as a string is rejected instead of read letter by letter.
- The build minifies whitespace too (Vite keeps it for ES libraries): 603 → 478 KB.

GPT-6-astra and a fresh Claude (Opus 5.5) context then reviewed that diff. Fixed:
- A click or tap focuses the row too, so only `:focus-visible` counts as focus for hover
  previews; a hovered or focused preview keeps playing when its media changes.
- A late Nest answer asks for a refetch (`subscribe`); a failed browse keeps known
  tokens; a browse started before a token was asked for doesn't mark it unknown.
- The strip ignores a cursor whose row is gone, and a deep link moves the cursor.
- Ranges are trimmed before parsing and stored trimmed by the editor.
- While loading, the still stays under the preview video until it has a frame.
- Player video listeners belong to one load (`AbortController`); they used to pile up
  per ±30 s press.

Not changed: the codec/unavailable fallback still autoplays the preview with reduced
motion, since it replaces a clip the user opened (§5.5 covers thumbnails). Low priority
and left for later: defensive parsing of malformed Frigate records, eviction in the media
URL cache, the clip end for ongoing reviews (now + padding instead of now − 5 s, impact
unverified), and the empty-state lookup ignoring LLM Vision `categories` and
`show_unmatched: false`. The UI fixes were checked in the dev harness, including
`?slow=nest:hang` and `?slow=nest:5`, and the minified file was loaded in a browser.

**2026-10-11, improvement review of 0.2.1.** GPT-6-astra (xhigh) looked for improvements
across the code; Claude (Opus 5.5) checked each finding. Fixed:
- Camera group children are keyed by event id, so an open clip keeps its player when a
  newer event joins the group (checked in the dev harness: the old code replaced it).
- An actor no longer comes from the next change of a bouncing lock: the lookup stops at
  the next state change (§2.4). Live data showed 3 of 5 changes in one bounce with the
  wrong actor before.
- The actor lookup (`ActorResolver`) waits at most 3 s, remembers actors per attribute and
  change, and asks only for changes without a final answer; a late answer with new actors
  asks for a refetch. An answer is final when the change was at least 30 s old as the
  history was read, since the attribute may arrive after the state. Only the attribute
  counts (the logbook's automation name stays a fallback), a newer lookup wins over an
  older one, and a lookup that hangs or is no longer needed stops holding back new ones.
- Events with a description stay out of bursts, where only a label shows (§5.3).
- `time_format: system` takes the clock of the browser's locale, as HA does.
- The browser time zone is read once instead of once per timestamp.
- Durations come from i18n (`duration.*`).

GPT-6-astra and a fresh Claude (Opus 5.5) context then reviewed the diff. The resolver's
bookkeeping above came out of that review (finality, attribute-only answers, newer lookups
winning, pruning), and a live row's actor now carries over to the fetched row while its
lookup hasn't answered. Not changed: finality compares server change times with the
browser clock, so a clock more than about 30 s fast can make an early answer final; the
same skew already shifts the live range.

Not changed (low priority): `frigate.cameras` with an alias pointing from a Frigate camera
to another camera, retrying a failed Frigate subscription (polling covers it), push
refreshes while the page is hidden, a constant `getCardSize()`, no warning for an
explicit `nest: true` without Nest, and eager loading of `*.local.json` fixtures in the
dev harness. Suggested features: an unreviewed-only filter and a notice when
`max_events` cuts rows.

**2026-10-12, Event Reel review before publishing.** GPT-6-sol (xhigh) and a fresh Claude
(Opus 5.5) context reviewed the new integration and the card's Event Reel provider. Fixed
in the integration (its own repository and tests):
- Removing or purging an event could delete any file an `add_event` image pointed to;
  only frames the integration saved itself (`<day>/<id>.jpg`) are deleted now.
- A ring after a moment where the AI saw nobody was lost during the cooldown, and a ring
  could mark an older event that finished late. Trigger snapshots are now taken at the
  trigger, not when the single worker gets to the job. A network error or an AI with no
  answer within 3 minutes keeps the event without text instead of losing it.
- Nest cameras without clips are described from the full picture, not the 175 px
  thumbnail, and events record `nest.video`.
- Websocket results and `get_events` called by a person are filtered by camera read
  permission; `remove_event` is admin-only; `describe` takes only HA paths and media
  sources; signed URLs never reach the log; purges announce removals; removing the
  integration deletes its data.

Fixed in the card: labels (`chime` reads "Rang the bell"), no clip for picture-only Nest
events, the list limit clamped to 1–5000, `not_loaded` skipped quietly unless
`event_reel` was set explicitly, and a ring described twice keeps both texts when the row
also joins a Frigate review. Not changed: a reload cancels a running analysis (the caller
of `describe` gets an error); naive websocket times were already read in HA's time zone,
since HA sets the process time zone, and are now explicit.

**2026-10-13, what next after 0.3.0.** GPT-6-sol (xhigh) ranked a reliability release
before new features, then a HACS default-list submission (the card can go before the
integration; HACS needs the HACS Action to pass and a release after that), then context
bands with a threat badge only after looking at real values. Claude (Opus 5.5) checked its
risks in the code and on Frigate. Fixed for 0.3.1:
- `max_events` cut the newest events before the category and camera filters, so a filter
  could come up short or empty while older matches existed, and nothing said rows were
  cut. The cap now applies to the filtered rows (`capItems`; a group across the limit stays
  whole), and a note under the list counts the rest. Chip counts cover the whole range;
  "mark all" and the day strip cover the rows shown. The list always reaches the last row
  opened or linked to (`_reach`), so a deep link past the cap opens, and closing that row
  keeps it (and keyboard focus) in place; a day switch clears it. Event Reel and LLM
  Vision fetch at least 500 events (twice `max_events` above that), as Frigate already
  did, so the filters have older events to find.
- A malformed Frigate review (no id, camera or start, or a non-string label) failed the
  whole Frigate load; it is skipped now (§2.2).

Not a bug: the clip of an ongoing review asks for up to 15 s past now, which Frigate
answers with what it has (§2.2, S4). Firefox and iOS playback is partly checked (S1). On
the reference install all four GenAI summaries so far had `potential_threat_level` 0, so a
threat badge would rarely show there.

GPT-6-sol (xhigh) and a fresh Claude (Opus 5.5) context then reviewed the first version.
Both found that closing a deep-linked row past the cap removed it and lost keyboard focus,
that a burst link kept the list long, and that provider fetch limits still followed
`max_events`; `_reach` and the higher limits above came out of that. Also fixed from the
Claude review:
- Grouping now sees every event in range, so one busy camera can form a very large group.
  An open group shows at most `max_events` events (`capList`), with the same note.
- The note said "only the newest N are shown", which is wrong when a whole group or a kept
  row shows more. It now counts what is hidden and names the limit. `max_events` is
  rounded.
- The render order (filter, then cap) is a pure `visibleRows` with a test where capping
  first would show no matches; presence grouping no longer copies its list per event.

Not changed: the note counts only fetched events, so it can't report events past a
provider's fetch limit. The recompute now groups and stabilizes every in-range event
instead of the newest `max_events`; merging already handled all of them, and only noisy
entities over long ranges would notice.

**2026-11-14, readable titles at phone width.** Three rounds with a fresh Claude (Fable 5.2)
context and GPT-6-sol (xhigh), each on the fixes of the round before. Changes:
- The first version wrapped titles only in cards up to 480 px. At 481 px they were cut
  again, and the meta column came back with them: the title kept 129 px (81 px in
  comfortable density with presence). Titles now wrap at every width, clamped at 2 lines
  (3 for a burst), an opened row shows all of it, and the camera/duration line goes under
  the title in cards up to 600 px (§5.2), where the column-free layout gives the title
  about as much room as the column layout does above.
- Comfortable's small thumbnail: a 480 px container rule took the big preview from a
  sections view column on a desktop, and a 400 px one missed large phones (a card of about
  414 px). It now follows the screen (`@media (max-width: 600px)`) or a card up to 400 px;
  between 400 and 480 px the card's own width can't tell a large phone from a desktop
  column. Comfortable rows keep their 72 px height with the small thumbnail.
- The tests didn't cover the clamp, comfortable density or the camera line under the
  title; each now has a browser test that fails without its rule. The README screenshots
  `mobile-dark.png` and `details.png` were retaken from the harness.

Not changed: `docs/demo.gif` (540 px) still shows the camera column; retake it with the
next recording. WebKit was checked by GPT only (Playwright's WebKit on Windows).

**2026-11-14, the chip bar on a phone.** Three rounds by a fresh Fable 5.2 context and
GPT-6-sol (xhigh). Fixed:
- Right to left, `scrollLeft` runs from 0 to negative, so the wrong edge faded and never
  cleared. The fade classes now name physical sides (`more-left`, `more-right`), and the
  offset is direction-aware and clamped, so Safari's rubber-band bounce counts as the end.
- The fade also updates when a chip's width changes without a scroll or resize (an icon
  that loads late), and after the card is moved in the page.
- A chip reached with Tab stops clear of the fade (`scroll-padding-inline`).
- The icon-sized camera menu shows its focus ring for keyboard focus only, with a
  `:focus-within` fallback where `:has()` is missing (Firefox ESR 115).
- The CHANGELOG says the icon applies in any card up to 600 px wide, which includes a
  sections column on a desktop, not only a phone.

**2026-11-14, "Unreviewed" and "Nobody home" chips.** Three rounds by a fresh Fable 5.2
context and GPT-6-sol (xhigh). Fixed:
- Marking a row reviewed while "Unreviewed" is picked hid the row and lost focus; focus now
  moves to the nearest row still shown, and the open detail closes.
- A camera group showed the blue dot only when its first review was unreviewed; any one now
  counts.
- A picked chip vanished on a day with no matching rows, so it could not be switched off; the
  bar stays up while a chip is picked.
- An open row that a chip or the camera menu hides is closed, so it doesn't reopen with its
  media when the filter is cleared.
- The browser tests took their expected counts from the card's own indicators; they now come
  from the fixture, with one review marked reviewed. The third round found nothing.

**2026-11-14, door and lock changes on camera rows.** Three rounds by a fresh Fable 5.2
context and GPT-6-sol (xhigh). Round 1 found that a deep link lost its step when the camera
loaded after the change, and that a filter narrowing a camera group kept changes whose
event it no longer showed; both fixed. Rounds 2 and 3 were about following a change that
moves onto a camera row when that camera's sources answer late. Fixed:
- An open change, an open burst, or a linked step follows to its camera row once; closing
  that row sticks, even when the row's id changes because another review grouped in.
- A burst whose changes split (some join the camera row, the rest stay a burst) opens every
  row that took a change and keeps the remaining burst open.
- A refresh never takes the open detail from the row the user is looking at, never opens a
  row the current filter hides, and a click, Escape or a filter cancels a pending link
  follow. Closing a group also closes the detail open inside it.
- The browser tests now force a real recompute (a live state change through the harness's
  new `setState`), so "closing sticks" is tested, and each fix fails its test without it.
Rebutted: a camera row is sorted and labelled by its camera event, not by its latest
attached change. Left open: with a very small `max_events`, a split burst's remaining part
can fall under the cap.

**2026-11-15, Nest events as rows.** Three rounds by a fresh Fable 5.2 context and
GPT-6-sol (xhigh), after a read-only check of the event entities on a live install (PLAN
§2.3). Fixed:
- The recorder stores a trigger seconds after the state changes, so the provider also reads
  each entity's current state (allowing 60 s of clock skew), and the card refetches when
  Nest event entities appear or Nest finishes loading, not only on a trigger.
- AI text joins its Nest row by a `nestToken` field, so LLM Vision text whose device wasn't
  found and Event Reel text without a clip still join; two producers' texts about one Nest
  event collapse by token even without a clip or camera.
- Nest's own type wins over LLM Vision's doorbell guess, a ring stays a doorbell, and a
  more specific AI category names the row whichever producer answered first.
- Row ids are `nest:<device>:<session>`, stable when a visit's first trigger leaves the
  range; dedupe is per device; labels are translated; the empty state's "last event"
  includes Nest; the harness mock honours `entity_ids`.
Rebutted: in-place changes to `hass.entities` (HA replaces the object); links to
`nest:<token>` ids (never released); identical tokens on two devices (tokens carry a
session counter); with two AI producers on one ring, "doorbell" from either still wins over
the other's category (the rule on main). Left open: texts joined to Nest rows don't count
toward `hide_unconfirmed` (PLAN §3.5). Not checked yet: a dev build on a real Home
Assistant (clip playback, signing, resolve of these tokens).
