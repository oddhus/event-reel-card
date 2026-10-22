# Event Reel Card: implementation plan

A Home Assistant Lovelace card that shows one compact timeline of the day's events:
door, lock and presence changes, AI-described camera activity (Frigate GenAI, the
companion Event Reel integration or LLM Vision), Frigate
review items with **animated thumbnails** and **the exact video clip**, Nest doorbell
clips, and any other event you want to log.

Status: v0.4.1 released 2026-10-21 (M1–M3 done, then loading and day navigation, review fixes, the Event Reel provider for the companion integration, the GenAI threat badge, and playback that tells a stall from a codec failure; §9, §2.6, §2.2, §5.4). Reviews are logged in §12. This
document is the brief for the implementing agent. Private details about the reference install
(entity ids, hosts, camera mapping, deploy steps) live in `CLAUDE.local.md`, which is
gitignored. Read it if it exists, and never copy its contents into tracked files.

---

## 1. Goals

1. **One timeline, many providers.** HA entities/logbook, Event Reel, LLM Vision, Frigate
   and Nest, plus custom events. Adding a provider must not touch the UI code.
2. **Few hard dependencies.** The card needs nothing beyond Home Assistant core. Frigate,
   Event Reel, LLM Vision and Nest are optional providers that add media and descriptions
   when they are present. See §3.8.
3. **Video first.** Camera events get a moving thumbnail. Tapping one plays the exact
   recorded clip inline, with no download needed.
4. **Compact by default.** A full day fits on a phone screen without endless scrolling.
   Door/lock sequences and camera bursts collapse into single rows (§5.3).
   `density: compact | comfortable`.
5. **Easy to configure.** Works out of the box with auto-discovery, has a GUI editor for
   the common options, and supports YAML for everything else.
6. **Frontend only.** The card itself goes only through APIs Home Assistant already
   exposes, and is distributed through HACS as a "Dashboard" (plugin) repository. AI
   analysis lives in a separate, optional companion integration, **Event Reel**
   (`oddhus/event-reel`, a HACS "Integration" repository, §2.6). The card works the same
   without it. Decided 2026-10-12, when LLM Vision was replaced on the reference install:
   a Nest doorbell needs frames from its event clip, which only server-side code can fetch,
   and the descriptions have to be kept for automations (daily summaries, notifications),
   which a card can't do.

**First target:** replace a "last 24 hours" dashboard view on the reference install that
uses `llmvision-card` today (§9, M1).

### Non-goals for v1

- Live camera streams. Other cards (Advanced Camera Card etc.) already do this well.
- Running AI analysis in the card. The card displays results; producers are Frigate GenAI,
  the Event Reel integration, LLM Vision or automations.
- A backend or database inside the card. The Event Reel integration keeps its own events.
- Depending on other custom cards.

---

## 2. Verified facts about the data sources

Checked on 2026-10-10 against a real install (HA 2026.x, Frigate 0.18.0, Frigate
integration v5.15.6 (the latest release), LLM Vision v1.7.2, Nest core integration).
Unless noted, every check went **through Home Assistant** (websocket and HTTP proxies),
not to Frigate directly. Items marked **verify** were not tested.

### 2.1 LLM Vision

- Fetch with the documented service (verified):
  ```js
  hass.callWS({ type: "call_service", domain: "llmvision", service: "get_events",
    service_data: { start: "YYYY-MM-DD HH:MM:SS", end: "YYYY-MM-DD HH:MM:SS",
                    limit: 100 /* cameras, categories, labels, include_no_activity */ },
    return_response: true })   // -> { response: { events: [...] } }
  ```
  `llmvision-card` uses an undocumented REST endpoint instead
  (`GET /api/llmvision/timeline/events?start&end&limit&include_no_activity`, where `limit`
  defaults to 10). Prefer the service, which is the public contract.
- Event shape (sample, ids replaced):
  ```json
  {"uid":"5f0e…","title":"Person on the front steps","description":"…",
   "start":"2026-10-08T14:16:26.866834+02:00","end":"2026-10-08T14:17:31.022224+02:00",
   "key_frame":"/media/llmvision/snapshots/example-0.jpg",
   "camera_name":"image.entrance_person", "category":"person", "label":"person"}
  ```
- `camera_name` (from the v1.7.2 source, confirmed in real data):
  - Image analyzer: the first `image_entity` (`image.*` from Frigate, or `camera.*`).
  - Video analyzer: the last path segment of the video path, without `.mp4`. For a Nest
    automation attachment (`/api/nest/event_media/{device_id}/{token}`) this is the
    **Nest event token**, the same token as in the Nest media-source id (verified). That
    gives an exact join to the Nest clip (§2.3).
  - `""` for events from `llmvision.create_event`.
- `key_frame` is a path under `/media/llmvision/snapshots/`. Resolve it the way
  `llmvision-card` does (seen in its source): replace the leading `/media/` with
  `media-source://media_source/local/` and call `media_source/resolve_media`, which
  returns a signed URL.
- "No activity" events: the server drops every event whose title contains "no activity"
  (case-insensitive) unless `include_no_activity: true`. The card needs no filter of its
  own.
- Timing: `start` is when the analyzer was triggered. On the reference data it matches
  the Frigate review start (median 0 s, §2.5). `end` is about start + 60–75 s and has no
  meaning.
- Events from `create_event` (door, lock, presence) have inconsistent `category` and
  `label` (often empty). Don't build on them. Use the entity provider (§2.4) for these.
- Live updates: the `calendar.llm_vision_timeline` entity rewrites its state after every
  timeline write (v1.7.2 source, debounced). Use a change as a refetch hint and keep
  polling as the baseline (**verify** in practice).
- Fallback without the LLM Vision service: the same calendar entity serves the events
  through HA's core calendar API, with `location = "{key_frame},{camera_name}"` (from
  source, **verify**). There is no category in that path.

### 2.2 Frigate (through the HA Frigate integration)

The **instance id** is the camera entity attribute `client_id` (for example `frigate`).
Frigate cameras are `camera.*` entities with `attributes.client_id` and
`attributes.camera_name` (the Frigate camera name).

Websocket commands (all take `instance_id`):

| Command | Use |
|---|---|
| `frigate/reviews/get` | `cameras`, `labels`, `zones`, `severity` (**one** string), `after`, `before` (float epoch), `limit`, `reviewed`. Verified. |
| `frigate/reviews/subscribe` / `unsubscribe` | Live review updates. `unsubscribe` takes `subscription_id`. Payload shape: **verify** (expected: Frigate MQTT `reviews` message with `type`, `before`, `after`). |
| `frigate/reviews/viewed` | `ids: [...]`, `viewed: bool`. Marks items as reviewed in Frigate. |
| `frigate/events/get` | Object events (faces/sub_labels, has_clip…). |
| `frigate/recordings/get` / `summary` | Recording coverage (for later, §3.5). |

- **The results are JSON strings.** The integration passes Frigate's body through
  unparsed (`decode_json=False`), so do `JSON.parse(result)`.
- Filter several severities client-side, or make one call per severity.

Review item shape (sample, ids replaced):
```json
{"id":"1791450000.123456-abc123","camera":"entrance","start_time":1791450000.12,
 "end_time":1791450049.35,"severity":"alert",
 "thumb_path":"/media/frigate/clips/review/thumb-entrance-1791450000.123456-abc123.webp",
 "data":{"detections":["1791449999.654321-def456"],"objects":["person"],
         "verified_objects":[],"sub_labels":[],"zones":[],"audio":[],
         "thumb_time":1791450000.18,"metadata":null},
 "has_been_reviewed":false}
```
`end_time` is `null` while the activity is ongoing. `data.metadata` holds Frigate GenAI
review summaries (`title`, `scene`, `shortSummary`, `confidence`,
`potential_threat_level`, `other_concerns`; Frigate 0.18 also writes `observations` and
`time`) when `review.genai` is enabled in Frigate. `potential_threat_level` is 0 (normal),
1 (suspicious) or 2 (critical threat) in 0.18, which forces it to 0 when the review
contains a verified (named) object; Frigate's UI calls 1 "Needs review" and 2 "Security
concern". In 0.17 the field allowed 0–3 (1 minor anomaly, 2 moderate concern, 3 high
threat). The card shows "Suspicious" for 1 and "Security concern" for 2 and up (checked in
the v0.17.0, v0.17.2 and v0.18.x source, 2026-10-17). `other_concerns` are the user's
configured additional concerns the model observed. Use them when present. The card keeps
only the fields it reads and skips a record without an `id`, a `camera` or a numeric
`start_time`. An answer that isn't a list still fails the provider.

HTTP media through the integration proxy. `{iid}` is the instance id.

| What | HA path | Status |
|---|---|---|
| Animated review preview (mp4) | `/api/frigate/{iid}/notifications/{review_id}/review_preview.gif?format=mp4` | ✅ 200, `video/mp4`, 88 KB. The query is forwarded. Notification proxy, see below. |
| Animated review preview (gif) | `/api/frigate/{iid}/notifications/{review_id}/review_preview.gif` | 242 KB (measured on Frigate directly) |
| Still review thumbnail | `/api/frigate/{iid}/clips/review/thumb-{camera}-{review_id}.webp` (from `thumb_path`) | Route exists in v5.15.6 (`ReviewClipsProxyView`), normal auth. **Verify.** |
| Still review thumbnail (alt) | `/api/frigate/{iid}/notifications/{review_id}/{camera}/review_thumbnail.webp` | Notification proxy |
| Still object thumbnail | `/api/frigate/{iid}/thumbnail/{event_id}` | 9 KB |
| Animated preview for a time range | `/api/frigate/{iid}/preview/{camera}/start/{s}/end/{e}` | ❌ **404 on v5.15.6.** The route was added on the integration's main branch on 2026-09-24 and is not in a release yet. Feature-detect it (§3.8), never require it. |
| **Exact clip, streamed (HLS)** | `/api/frigate/{iid}/vod/{camera}/start/{s}/end/{e}/index.m3u8` | ✅ Verified end to end, see below |
| Full-quality MP4 download | `/api/frigate/{iid}/recording/{camera}/start/{s}/end/{e}` | ~0.8 MB/s for 4K (75 s ≈ 60 MB). Download only. |

- **Notification proxy.** The `notifications/...` routes are **unauthenticated by
  default** (integration option "notification proxy" enabled, no expiry). A user can
  turn the option off, and then these routes fail even for authenticated requests. So
  sign them anyway, and fall back to the `clips/...` still on error.
- **HLS auth (verified through HA).** Sign the manifest path. Frigate's nginx-vod copies
  the query string (`?authSig=…`) onto the `init` and segment URLs, and the integration's
  segment view accepts a segment when the signed path starts with the segment's
  directory. Signed manifest, init and segments all returned 200. Unsigned manifest and
  segments returned 401. One signed manifest URL therefore works in hls.js and in a
  native `<video src>`, with no Authorization headers.
- `auth/sign_path` returns `{ path }` (the signed path). The signature covers the query
  parameters, so sign the full path including the query.
- **Codecs.** Frigate previews are low-res H.264 and play everywhere. Full recordings can
  be HEVC. The reference 4K HEVC camera's init segment uses the `hev1` sample entry (not
  `hvc1`), which Safari and iOS native HLS are likely to reject. It also runs at about
  6.3 Mbit/s (13.4 MB for a 17 s segment), which is heavy on mobile data. On the
  reference install most camera events come from that camera, so the codec fallback is a
  main path, not an edge case (§5.4).
- Never auto-download the MP4. Download only on an explicit button press.
- **Ranges that end in the future** (checked on Frigate 0.18 directly, 2026-10-13): a VOD
  manifest or `clip.mp4` whose end is up to 20 s ahead returns the same segments as one
  ending now, so the padding after an ongoing review's "now − 5 s" is harmless. A range
  that starts in the future gets 404 (VOD) or 400 (`clip.mp4`). A range past retention
  gets 404, which the player shows as "deleted".

### 2.3 Nest (core integration, through HA media source)

- `media_source/browse_media` with `media-source://nest` lists the devices. With
  `media-source://nest/{device_id}` it lists events (200+ entries, months back):
  ```json
  {"title":"Person @ 2026-10-08 13:44:55","media_class":"image",
   "media_content_id":"media-source://nest/{device_id}/{token}",
   "thumbnail":"/api/nest/event_media/{device_id}/{token}/thumbnail"}
  ```
- `media_class` is `image` for every event, even when the media is a clip.
  `media_source/resolve_media` returned **`video/mp4`** with a signed URL for a doorbell
  event (verified), so the doorbell does provide clips.
- The token is base64 of a JSON array. It equals LLM Vision's `camera_name` for video
  analyzer events on Nest attachments (§2.1).
- Titles are `"<Type> @ <local timestamp>"` (Doorbell, Person, Motion…). Parsing time and
  type from a localized title is fragile, so the full Nest provider is P2. M1 only uses
  Nest to play clips for LLM Vision doorbell events joined by token.
- The token lookup browses media source (the root, then one call per device). LLM Vision
  waits at most 3 s for it, so a slow browse never holds back the AI events: doorbell rows
  show without a clip, and when the browse answers, the provider's `subscribe` asks for a
  refetch (also on a past day, which isn't polled). A failed browse keeps the tokens found
  earlier. A browse with no answer after 60 s no longer blocks a new one, and only a browse
  started after a token was asked for can mark it unknown (retried after 10 min).
- Automations also get `trigger.event.data.attachment.video|image` (`/api/nest/event_media/...`).

### 2.4 Entities and logbook (HA core)

- `logbook/get_events` with `{ start_time, end_time, entity_ids }` returns entries with
  `when`, `entity_id`, `state`, `name`/`message` (for `logbook.log` entries) and, when
  known, `context_user_id`, `context_event_type`, `context_domain`, `context_name`,
  `context_entity_id`.
- Verified: for one day, the logbook held exactly the same 36 door, lock and presence
  changes that an automation had copied into LLM Vision with `create_event`.
- Physical and keypad changes carry no `context_*`. `context_user_id` is a user id.
  Names need the admin-only `config/auth/list`, so show an actor only when it is cheap:
  - an attribute such as a lock's `changed_by` (needs `history/history_during_period`
    with attributes for that entity; verified, §9 S5), or
  - the friendly name of `context_entity_id` (the automation or script).
- Verified on the reference install (2026-10-11): history rows come sorted by `lu`, a
  change's row has `lu` equal to the logbook `when`, and the first row is the state at
  `start_time` with `lu` set to `start_time`. During a bounce the attribute of each change
  is on its own row, so the actor comes from the change's row and the attribute-only rows
  after it, up to the next state change. The card asks only for changes without a final
  answer (§12), from 2 s before to 5 s after them, and doesn't hold the rows back more than
  3 s for it.
- Drop transitions from or to `unknown`/`unavailable` (restart noise) and attribute-only
  updates.
- Locks can bounce (unlocked → locked → unlocked within seconds, seen in real data).
  Grouping handles it (§5.3).
- Format states with `hass.formatEntityState(stateObj, state)` to get localized state
  names ("Locked", "Låst").
- `history/history_during_period` (minimal response) gives on/off intervals for context
  bands (§5.6).
- Retention follows the recorder (default 10 days). That is fine for a 24 h view but
  limits day navigation.

### 2.5 Reference data profile (anonymized, 6 days)

- About 54 events per day. **77 % are door, lock and presence changes.** The rest are
  camera AI events, mostly from one entrance camera (4K HEVC).
- 93 Frigate reviews, all `alert`, none with GenAI metadata. A camera without AI
  analysis had 26 of them.
- Merge with the §3.5 defaults: 65 of 67 AI events on the entrance camera fell inside a
  review's window. 5 reviews had **two** AI events each (the producer dedupes per camera
  for 90 s and reviews can last longer). 3 reviews had none.
- 6 doorbell AI events (video analyzer on the Nest clip), all joinable by token.

### 2.6 AI producers: Event Reel integration, AI Task, Frigate GenAI

Checked 2026-10-11 and 2026-10-12 against HA 2026.9/2026.10 source and the reference
install (HA 2026.10.1, Frigate 0.18.0, Ollama).

- **Event Reel** (the companion integration, its own repository) stores events and serves
  them over websocket:
  - `event_reel/events/list` with `start_time`, `end_time` (ISO 8601), `cameras`, `limit`
    (at most 5000) → `{ events: [...] }`, newest first. `start` is ISO with the local
    offset; `end` may be `null`.
  - `event_reel/events/subscribe` pushes `{ action: added | updated | removed, event }`.
    The card only uses it to refetch.
  - An event has `id`, `start`, `end`, `camera`, `title`, `description`, `category`,
    `labels`, `key_frame` (a media source id, or an HA path for events added by
    automations), `source` (`nest`, `trigger`, `service`), `analysis` (`ok`, `failed`,
    `none`) and, for Nest, `nest: { device_id, event_token, video }`. The Nest token is the
    same as in `media-source://nest/{device_id}/{token}` (§2.3), so the card builds the
    clip and the `/thumbnail` still from it, as for LLM Vision.
  - Detection: `hass.services.event_reel.get_events`.
- **AI Task** (`ai_task.generate_data`, HA core): `structure` with selectors gives a JSON
  answer. Attachments must be `media-source://camera/…` or `media-source://image/…`
  snapshots, or media sources that resolve to a **local file** ("Only local attachments
  are currently supported"). A Nest event clip resolves to a URL, so it can't be attached
  directly; Event Reel fetches the clip through HA (a path signed for the content user),
  takes frames with ffmpeg into the media folder, and attaches those.
- **Nest cameras that stream with WebRTC** return a placeholder picture as their snapshot,
  so snapshot-based analysis (core AI Task on `camera.*`, or LLM Vision's image analyzer)
  sees nothing. Their event clips are the only usable frames.
- **Thinking models:** with Ollama, `qwen3-vl:4b` (a thinking model) returned an empty
  answer when a JSON format was requested; `qwen3-vl:4b-instruct` and `gemma3:4b` answer.
  Small models also judge "is there real activity" more consistently when that field comes
  after the description in the structure.
- **Frigate GenAI review summaries** (0.17+, `review.genai`): Frigate 0.18 takes the model
  from a `genai` provider with the `descriptions` role. A summary is written once a review
  ends, into the review's `data.metadata` (`title`, `scene`, `shortSummary`, `confidence`,
  `potential_threat_level`, `other_concerns`, §2.2), and published again on MQTT
  `frigate/reviews` with `type: "genai"`. There is no API to summarize an old review again.

---

## 3. Architecture

### 3.1 Stack

- TypeScript + **Lit 3**, built with **Vite library mode** into a single ES module
  `dist/event-reel-card.js` (inline dynamic imports, no external chunks, so HACS ships
  one file).
- **hls.js** (light build) bundled. Use hls.js when MSE or ManagedMediaSource is
  available. Otherwise use native HLS via `video.src = signedManifest`.
- **Vitest** for unit tests of the pure logic (mapping, merge, grouping, time ranges,
  provider parsers).
- No runtime CDN imports. HA does not reliably share its own Lit with custom cards, so
  bundle it.
- **License notices.** Lit (BSD-3-Clause) and hls.js (Apache-2.0) ask for their notices
  in redistributed builds. The minifier drops Lit's `@license` comments (Vite turns
  rolldown's legal comments off; `output.comments.legal` would bring back only Lit's
  copyright and SPDX lines), and hls.js's dist has none. hls.js 1.7.3's light build also
  inlines eventemitter3 (MIT), url-toolkit, `@svta/cml-id3` and `@svta/cml-utils` (all
  Apache-2.0), which have no node_modules entry; its source map names them (`@svta/cml-cmcd`
  is imported for types only). So `build/third-party-notices.ts` adds one `/*! */` banner
  through rolldown's `postBanner` (after minifying), with the LICENSE file of each package
  that has rendered code in the bundle plus the inlined ones from `build/licenses/` (copied
  from their npm tarballs). Whitespace is collapsed and identical texts are merged. The
  full Apache-2.0 terms, which url-toolkit's and SVTA's LICENSE files repeat, are printed
  once at the end (Apache §4(a) asks for a copy of the license); each package keeps its
  own copyright notice. None of these npm packages ships a NOTICE file. SVTA's repository
  has one, but its attributions (SVTA's copyright, and the hls.js notice for code derived
  from hls.js) are in the banner already. The build fails when a bundled package has no
  LICENSE file, and a test checks the inlined list against hls.js's source map and pinned
  versions. Vite's `build.license` collects the same texts, but into a separate file that
  HACS wouldn't install. Cost with 0.2.0: 14.6 KB (4.9 KB gzipped).

### 3.2 Source layout

```
src/
  event-reel-card.ts        # <event-reel-card>: config, lifecycle, layout
  editor.ts                 # getConfigForm() schema (+ custom editor only if needed)
  types.ts                  # ReelEvent, MediaRef, ProviderContext, config types
  config.ts                 # normalise shorthand config → provider configs
  providers/
    registry.ts             # registerProvider(type, factory)
    entity.ts               # core: logbook state changes + logbook.log entries
    llmvision.ts
    frigate.ts
    nest.ts                 # M1: token → clip resolver only; full provider P2
    calendar.ts             # P2: any calendar entity
  core/
    capabilities.ts         # what is installed / which optional routes work (§3.8)
    cameras.ts              # camera registry + auto-mapping (§3.4)
    merge.ts                # link AI/text events to media events (§3.5)
    grouping.ts             # bursts, bounces, camera groups (§5.3)
    media.ts                # sign_path cache, URL builders, fallback chains
    time.ts                 # ranges, day boundaries in HA time zone, formatting
  ui/
    event-row.ts            # compact/comfortable row, group rows
    event-detail.ts         # expanded view: player + text + actions
    reel-preview.ts         # animated thumbnail (IntersectionObserver)
    reel-player.ts          # hls.js / native player, codec fallback
    day-strip.ts            # P1
    filter-chips.ts         # P1
  i18n/ en.ts nb.ts index.ts
  styles.ts
dev/
  index.html, mock-hass.ts  # dev harness (§7)
  fixtures/*.example.json   # anonymised; *.local.json is gitignored
test/
  *.test.ts
build/
  third-party-notices.ts    # license banner of the built file (§3.1)
  licenses/                 # LICENSE files of the packages hls.js inlines
```

### 3.3 Data model

```ts
type Category = "person" | "vehicle" | "animal" | "package" | "doorbell" | "motion"
  | "door" | "lock" | "presence" | "alarm" | "calendar" | "custom";

interface MediaRef {
  kind: "hls" | "mp4" | "image" | "gif";
  path: string;              // HA-relative path, unsigned (or a media-source id)
  sign?: boolean;            // default true for /api/*, /media/*
  resolve?: boolean;         // true for media-source ids (resolve_media signs)
}

interface ReelEvent {
  id: string;                // `${provider}:${nativeId}`
  provider: string;          // "entity" | "llmvision" | "frigate" | "nest" | ...
  sources: string[];         // after merge, e.g. ["llmvision","frigate"]
  start: number;             // epoch seconds
  end?: number;              // undefined while ongoing / for instants
  title: string;
  description?: string;
  extra?: { start: number; title: string; description?: string }[];  // more AI texts merged into the same media event
  category: Category;
  icon?: string;             // mdi:… override
  entityId?: string;         // source entity for entity events (grouping, more-info)
  state?: string;            // raw new state for entity events
  camera?: string;           // canonical camera key = HA camera entity id
  thumbnail?: MediaRef[];    // still, in fallback order
  preview?: MediaRef[];      // animated (mp4/gif), in fallback order
  clip?: MediaRef;           // exact video (hls preferred)
  download?: MediaRef;       // mp4
  labels?: string[];         // objects
  people?: string[];         // faces / sub_labels / presence names
  severity?: "alert" | "detection" | "info" | "warning";
  reviewed?: boolean;        // Frigate review state
  actor?: string;            // who/what caused it, when cheaply known (§2.4)
  raw?: unknown;             // original payload for actions/debug
}

interface Provider {
  readonly type: string;
  fetch(range: { start: number; end: number }, ctx: ProviderContext): Promise<ReelEvent[]>;
  subscribe?(ctx: ProviderContext, onChange: () => void): () => void;  // live updates
  actions?(ev: ReelEvent): ReelAction[];  // e.g. "mark reviewed"
}
```

Providers never render anything. A new provider means one file plus one
`registerProvider` call. Expose `window.eventReel.registerProvider` so third-party
scripts can add providers later (P3).

### 3.4 Camera registry and auto-mapping

The canonical camera key is the **HA camera entity id**. The registry is built from
`hass.states`, `hass.entities` (entity registry: `device_id`, `platform`) and
`hass.devices`:

1. **Frigate:** `camera.*` with `attributes.client_id` and `attributes.camera_name` →
   key ↔ (instance id, Frigate camera name).
2. **LLM Vision `camera_name` that is an entity id:**
   - `camera.*` → itself.
   - `image.*` (Frigate object image) → the `camera.*` entity on the **same device**,
     preferring platform `frigate`. **Verify** in the live frontend that `hass.entities`
     exposes `device_id` for these entities.
3. **LLM Vision `camera_name` that is a Nest token** (base64 of a JSON array): find the
   Nest device whose media-source listing contains the token (browse each Nest device
   once, cache, refresh when an unknown token shows up) → that device's `camera.*`.
4. **`camera_aliases`** in config map extra keys (entity ids or LLM Vision identifiers)
   to a canonical one. This covers the same physical camera exposed by two integrations,
   for example a Reolink entity and a Frigate camera.
5. Anything else stays **unmapped**: the row shows the key frame only. Never guess a
   camera, because a wrong guess plays the wrong clip.

Unit test every rule.

### 3.5 Merging (AI text ↔ video)

Goal: one row per real-world moment, with the AI title and description plus the video.

1. Split events into **text events** (LLM Vision or Event Reel, with a camera) and
   **media events** (Frigate reviews). Text events that share a Nest clip (the same ring
   described by both AI producers) first collapse into one, with the later text in
   `extra`.
2. For each text event `T` on camera `c` at time `t`, the candidates are media events `M`
   on the same camera where `M.start - 15 s ≤ t ≤ (M.end ?? now) + 30 s`. Pick the
   nearest by `|t - M.start|`. These defaults matched 65 of 67 events on the reference
   data. Make the windows configurable (`merge.before`, `merge.after`).
3. **Many-to-one.** A media event can take several text events. The earliest gives the
   title, description and category. The others go into `extra` and show in the detail.
   Never turn a second AI event into a separate row with a made-up clip.
4. The merged event takes its media/reviewed/severity/labels from `M`. Its start is the
   min and its end the max of the parts. `sources` lists both providers.
5. **Doorbell:** a text event whose `camera_name` is a Nest token gets its clip from
   `media_source/resolve_media` and its still from the Nest `/thumbnail` path.
6. A text event with no match keeps its `key_frame` image. **No synthesized clips in
   M1.** The time-range preview route is not released (§2.2), and a VOD URL built from a
   timestamp can point at missing footage. Later (P2): synthesize VOD after checking
   coverage with `frigate/recordings/get`, and previews once the route ships.
7. A media event with no match is shown (`frigate.show_unmatched: true`, the default).
   Its title is the GenAI `metadata.title` if present, otherwise a localized
   "{Object} at {Camera}". This covers cameras without any AI producer.
8. **Never hide footage because of AI output by default.** "No activity" rows are
   already dropped by LLM Vision (§2.1). Opt-in: `frigate.hide_unconfirmed: true` hides
   unmatched reviews on cameras that have an AI producer, after a 3-minute grace period.
9. The function is pure: `merge(events, cameraRegistry, options) → ReelEvent[]`. Cover
   it heavily with tests, including an anonymized fixture built from the reference
   profile (§2.5).

### 3.6 Media signing (`core/media.ts`)

- `sign(path, expires = 3600)` → `hass.callWS({ type: "auth/sign_path", path, expires })`
  → `.path`. Cache by path until about 60 s before expiry. Batch requests within one
  frame.
- Sign every `/api/` media path, including routes that are unauthenticated today.
- Sign lazily, only when a row becomes visible or a player opens. Re-sign once on
  `error` (expired or 401), then move to the next `MediaRef` in the fallback list.
- Sign the **full path including the query** (for example `?format=mp4`).
- Media-source ids go through `media_source/resolve_media`, which returns its own signed
  URL.
- Give up on HA's answer after 15 s (2026-10-21): every caller waiting on that request
  gets the error, the next call asks again, and a late answer is not cached. Without it, a
  request lost on a dropped connection left the player on "Loading clip…" for good.

### 3.7 Live updates

- Entities: when a watched entity's state changes in `set hass`, append the event
  straight away (with the §2.4 filters) and reconcile on the next fetch.
- Frigate: `frigate/reviews/subscribe`, then upsert on new/update/end. Unsubscribe with
  the `subscription_id`, and resubscribe after the HA connection reconnects.
- LLM Vision: refetch (debounced to 2 s) when `calendar.llm_vision_timeline` changes.
- Event Reel: refetch on each `event_reel/events/subscribe` message.
- Fallback for everything: poll every `refresh_interval` (default 60 s) while the card
  is visible (`document.visibilityState`). A past day (§5.1) isn't polled; push updates
  and becoming visible still refresh it.
- Loading (`core/loader.ts`, pure): each provider loads on its own and is published as
  soon as it answers, so a slow provider never holds back the others. A source never gets
  two requests at once, even across views: asking again while a request runs (including
  one from an earlier view) loads it once more when that request answers or times out. So
  quick day clicks or editor keystrokes don't pile up whole-day queries. A request that
  runs past 20 s counts as failed (warning chip, earlier rows kept), but its late answer is
  still used unless a newer request replaced it. A generation counter drops every answer
  from before a restart, a config change or a day change. A new view waits up to 1.5 s for
  every provider before its first paint, so the list doesn't build up row by row. After a
  restart or config change the previous items stay up meanwhile; after a day change the
  list shows "Loading…" instead, so the old day's rows never appear under the new date.
- A pending deep link gives up ("not found") once every provider has answered, counting a
  late answer after a timeout, or after 60 s.

### 3.8 Dependency policy and capability detection

The card has to keep working when other integrations change, are missing, or are
configured differently.

- **Tier 0, HA core APIs:** `hass.states`, `logbook/get_events`,
  `history/history_during_period`, `auth/sign_path`, `media_source/*`, the calendar API.
  The card must be useful with only these (entities, presence, calendars).
- **Tier 1, core integrations:** Nest, reached only through media source.
- **Tier 2, custom integrations:** the Frigate integration, LLM Vision and the companion
  Event Reel integration. Optional providers. Event Reel's services stay registered after
  its entry is removed or fails to load; its list command then answers `not_loaded`,
  which counts as missing.
  - Use only APIs present in their latest **released** version.
  - Prefer documented services over private REST endpoints.
  - Keep each in one provider file with a small parser covered by fixture tests, so a
    change upstream is a one-file fix.
- **Detection** (`core/capabilities.ts`, at startup):
  - Frigate: any camera with `attributes.client_id`.
  - LLM Vision: `hass.services.llmvision?.get_events`.
  - Event Reel: `hass.services.event_reel?.get_events`.
  - Nest: `hass.config.components` includes `nest`.
  - Optional routes (the Frigate time-range preview) are probed once per session and
    the result is cached.
- **Degrade, don't fail.** A missing provider is skipped silently when it was
  auto-enabled, with a warning chip when it was explicitly configured. A broken media
  route falls back to the next `MediaRef`: review preview → still → key frame → icon.

---

## 4. Configuration

Use **top-level provider keys** (easier for the GUI editor and for people) and normalize
them into provider configs internally. `true` means "on, with auto-discovery".

```yaml
type: custom:event-reel-card
title: Today's events          # optional; hidden when empty
density: compact               # compact | comfortable
range: 24h                     # 24h (rolling, default) | today | <hours>
preview: visible               # visible | hover | still | off   (animated thumbnails)
max_events: 200                # newest events shown after the filters; a note counts the rest
language: auto                 # auto (HA user language) | en | nb

entities:                      # core provider: state changes from the logbook
  - entity: lock.front_door
    actor_attribute: changed_by                 # optional, read from history
  - entity: binary_sensor.front_door
    name: Front door
    icon: mdi:door
    states: { "on": Opened, "off": Closed }     # optional label overrides
    only_states: ["on"]                         # optional
  - person.alex
  - person.sam
llmvision:                     # true | false | object
  non_camera: true             # false = camera events only (use entities: for the rest)
  categories: []               # optional filter
frigate:                       # true | false | object
  cameras: auto                # auto | [camera.x, …]
  severity: [alert, detection] # filtered client-side
  show_unmatched: true
  hide_unconfirmed: false      # §3.5 rule 8
  clip_padding: [10, 20]       # seconds before/after
event_reel: true               # true | false: the companion integration's AI events (§2.6)
nest: true                     # doorbell clips for AI events; full provider P2
calendars:                     # P2: any calendar entity, e.g. a Local Calendar
  - calendar.house_events
camera_aliases:
  camera.backyard_reolink: camera.backyard
cameras:                       # optional per-camera overrides
  camera.entrance: { clip: auto }   # auto | preview (skip full-quality HLS)
grouping:
  window: 120                  # seconds, for activity bursts and camera groups (§5.3)
context:                       # P2: highlight periods (§5.6)
  - entity: input_boolean.away_mode
    state: "on"
    label: Away
    color: red
merge: { before: 15, after: 30 }
```

**Running next to a producer automation:** when an automation already copies door/lock/
presence changes into LLM Vision, set `llmvision.non_camera: false` and list those
entities under `entities:`. Otherwise every change shows twice.

**GUI editor (P1):** `static getConfigForm()` with an ha-form schema covering title,
density, range, preview, on/off toggles for llmvision/frigate/nest, `entities` (an
entity selector with `multiple: true`) and `calendars`. A provider key can be a boolean
or an object. The form must not overwrite an object with a boolean, so advanced
provider options stay YAML only. Register in `window.customCards` with a preview, and
implement `getStubConfig(hass)`, which auto-detects which providers exist.

Sections view: `getGridOptions()` → `{ columns: "full", rows: "auto", min_columns: 6 }`.

### 4.1 Registering your own events (README section)

Document three ways, from easiest to most powerful:

1. **Add the entity to `entities:`.** Every state change shows up, with no automation.
2. **`logbook.log`** from any automation, with `entity_id:` set to an entity listed under
   `entities:`. Gives a custom name and message. Kept as long as the recorder keeps
   data (default 10 days).
3. **A Local Calendar plus `calendar.create_event`** (with the P2 calendar provider):
   persistent and editable in the HA UI. **`llmvision.create_event`** also works when
   `llmvision.non_camera` is true, and it can carry an image.

Include copy-paste automation examples for each.

---

## 5. UI and UX

### 5.1 Layout (top to bottom)

M1:
1. **Header:** optional title.
2. **Event list,** newest first, with sticky hour separators in compact mode.

Later:
- **Summary and filter chips (P1):** counts per category ("5 persons · 3 door ·
  1 doorbell"). Tapping one toggles a filter. A camera filter menu sits at the end.
- **Day strip (P1):** a 24 h bar about 28 px high, with one tick per event colored by
  category, faint hourly activity in the background, context bands and a "now" line.
  Tap or drag to scroll the list to that time.
- **"Mark all reviewed" (P1)** in the header when there are unreviewed Frigate items.
- **Day navigation (P2, done after 0.1.0):** a `label ‹ ›` row above the chips, not
  sticky. The label is the live range ("Last 24 hours", "Today"), "Yesterday" or a date.
  ‹ goes to the previous calendar day, local midnight to midnight (23 or 25 h on DST
  days); › goes forward and returns to the live range after yesterday; "Today" jumps back.
  It works with both range kinds. `day_navigation: false` hides it. A deep link returns to
  the live range before it resolves.

### 5.2 Rows

**Compact (default, about 44 px for camera rows, 32 px for others):**
```
14:16  [▶ 64×36 anim]  Person searching on the front steps     Entrance · 49s  ●
14:20  [ 🔒 ]          Front door: unlocked · opened · closed · locked   14:20–14:22
```
- The time column is fixed width with tabular numerals.
- Camera rows have the animated preview. Non-camera rows have a 28 px icon disc in the
  same slot, so the text lines up.
- The title is one line with an ellipsis. In compact mode the description appears only
  when the row is expanded.
- The right side shows the camera name, duration, a face/person chip, the actor when
  known, and a blue dot when unreviewed.
- A Frigate GenAI threat level of 1 or more shows as a badge ("Suspicious", "Security
  concern") before the title, or at the start of the camera/duration line on narrow
  layouts so the title stays readable. A camera group row shows its highest level.
- Context highlight (P2, done): a left edge colored by the context band covering the
  row's time (§5.6).

**Comfortable:** about 72 px, a 112×63 preview, and a two-line description.

### 5.3 Grouping (`core/grouping.ts`, pure)

Most rows on a real day are door and lock changes (§2.5), so this is the main lever for
a compact view.

- **Activity bursts:** non-camera events that each follow the previous one within
  `grouping.window` (default 120 s) collapse into one row. The row shows a chain of
  states ("Front door: unlocked · opened · closed · locked"), the time range and a
  count. A burst can mix entities (a lock and a door). Presence changes stay separate
  rows, and so do events with a description (AI events without a camera), since a
  burst step shows only a label.
- **Bounces:** the same entity flipping back and forth within 10 s collapses into its
  last state, with "×n".
- **Camera groups:** consecutive events on the same camera within the window collapse
  into "3× Backyard · 14:02–14:09", with a stacked thumbnail.
- Tap a group to expand it.
- P2: attach a burst to an overlapping camera event ("Person at the entrance · door
  unlocked · opened").

### 5.4 Expanded detail (inline accordion; one open at a time)

- **Player** (16:9, full card width):
  - While the HLS clip loads, loop the preview (or show the still) in the player area.
    With reduced motion or data saving, always the still.
  - Exact clip `[start - pad, end + pad]` over HLS, autoplay muted, controls,
    `playsinline`. For an ongoing review (`end_time: null`), end the range at now − 5 s.
  - Buttons for "−30 s / +30 s" to widen the window (sign a new VOD range) and for
    fullscreen.
  - **Codec fallback.** Don't decide up front with `MediaSource.isTypeSupported()` and a
    fixed codec string, because the sample entry (`hev1` vs `hvc1`) varies per
    recording. Fall back to the preview mp4 and show "Full quality uses H.265, which
    this device can't play. Download instead." when any of these happen:
    - hls.js reports a fatal or codec error,
    - the video element reports `MEDIA_ERR_SRC_NOT_SUPPORTED`,
    - no video frames are decoded 4 s after playback starts
      (`getVideoPlaybackQuality().totalVideoFrames === 0`), the black-video-with-audio
      case.
    - a native player (Safari's HLS, a plain MP4) times out with media buffered ahead
      (`readyState >= HAVE_FUTURE_DATA`, or 3 s or more in `buffered`; Safari can stay at
      HAVE_METADATA when it can't decode what it downloaded),
    - or a native player times out after its metadata loaded on a camera whose previous
      clip stalled the same way, with no clip of it playing in between.
    Remember the result per camera for the session. The per-camera
    `clip: preview` override skips HLS entirely.
  - **Stalls are not codec failures** (`core/playback.ts`, 2026-10-21). When nothing loads
    for the idle limit (25 s hls.js, 12 s native) or playback hasn't started after 45 s,
    and none of the codec rules above apply, show the preview with "The recording isn't
    available" and a "Try again" button (only for events with a clip or Frigate
    recording): a single network stall must not keep a camera on previews for the
    session. When the browser refuses autoplay (Low Power Mode) or the user pauses before
    the first frame, stop the start watchdog and leave the video with its controls.
  - **Clips are never a codec failure.** A Nest clip is H.264 MP4, which every browser
    plays. A missing clip answers 404 (JSON), which the video element reports as
    `MEDIA_ERR_SRC_NOT_SUPPORTED`, so every clip failure is "unavailable" with Try again,
    and nothing is blocked (verified on the reference install, 2026-10-21).
  - Clip deleted (retention) → "The recording has been deleted".
  - Destroy the hls.js instance when the detail closes or the card disconnects.
- Full title and description, plus any `extra` AI texts (with Frigate's own summary when
  the review has a threat level and another AI description joined it). Meta: camera,
  duration, objects, faces, sources ("AI + Frigate"), and the GenAI concerns when present.
- Actions: **Mark reviewed** (Frigate, P1), **Download** (signed MP4 link with
  `download`, P1), **Open camera** or **Open entity** (more-info), prev/next event.
- Accessibility: the row's disclosure button is separate from the action buttons. Never
  nest buttons.
- Keyboard: ↑/↓ move, Enter opens, Esc closes, ←/→ seek.

### 5.5 Animated thumbnails

- Use `<video muted loop playsinline preload="none">` with the review preview mp4. If it
  fails, fall back through the still list (`clips/...` thumbnail, key frame, icon).
- `preview: visible` plays only while the row is visible (IntersectionObserver), with at
  most **6 playing at once** (closest to the viewport centre wins). `hover` plays on
  hover/focus and shows the still otherwise.
- `prefers-reduced-motion` or `navigator.connection.saveData` → behave like `still`.

### 5.6 Context bands (P2, done after 0.4.1)

Fetch history for the `context` entities in the visible range. Compute the intervals
where the state matches. Shade them on the day strip, and color the left border of rows
inside them. Use cases: "someone came while we were away" and "activity at night".

- **Config:** `context:` takes at most 4 items (the strip can't tell more apart): an entity
  id (state `on`) or `{entity, state (string or list, default on), label, color}`. YAML
  only; the editor keeps it. Each entity id must pass Home Assistant's own rule
  (`domain.object_id`, lower case, no leading, trailing or double underscore): it refuses the history of all of them when one is malformed. Two bands may watch
  one entity (an alarm panel's away and night states); bands are keyed by their position.
  The label defaults to the friendly name. `color` is an HA
  color name, mapped to `var(--<name>-color, <HA default>)` (the fallback serves themes
  and the harness without HA's color variables), or any CSS color; defaults indigo, amber,
  teal, pink in order. HA's other theme names (`primary`, `accent`, `dark-grey`…) map the
  same way. A value that isn't a valid CSS color (checked with `CSS.supports`, and never
  with `;`, braces, quotes or angle brackets, since it goes into style attributes) gets the
  default color for its position instead of none.
- **Data:** one `history/history_during_period` call per full refresh (not for a single
  provider's refetch) for all context entities: `include_start_time_state`, minimal
  response, no attributes, state changes only (`significant_changes_only`, so the
  recorder skips attribute-only rows in SQL, such as `sun.sun`'s many updates). The first row is the state at the range start, so
  a band already on starts at the left edge. Time is `lc ?? lu`. A failed call keeps the
  previous bands and logs to console.debug (bands are decoration, no warning chip). A
  newer view or refresh drops a late answer (token). Live: a changed state of a context
  entity in `hass` appends a transition at once; those newer than a later answer are
  kept (`mergeTransitions`). An entity with no rows at all (unchanged for longer than the
  recorder keeps) is seeded from its current state when that held over the view. A past
  day doesn't take live changes. The live range runs on to now between refreshes
  (`_viewRange`), for the bands, the strip and strip taps, so a band that began after the
  last refresh has a place on the strip.
- **Intervals** (`core/context.ts`, pure): `unknown`/`unavailable` keep the previous state
  (a restart neither splits nor starts a band). Gaps under 5 min are bridged (someone who
  leaves, comes back for something and leaves again), closed intervals under 1 min
  inside the range are dropped. In the live range the bands run on to now, and one still
  on is open: it covers everything after its start, including live rows newer than the
  last refresh.
- **Strip:** a full-height fill at 18 % of the color, behind the histogram and ticks, and
  a 3 px edge in a lane per band (lane = config index) at the top, so overlapping bands
  stay apart.
- **Rows:** a row is inside a band when the band covers the start of one of its events
  (a group or burst that began while away counts; the same rule as the chips' counts and
  filter). It gets an inset 3 px left edge
  (box-shadow, no layout shift) in the first covering band's color (config order; a door burst that starts while away and
  ends after coming home is kept by the chip, so it gets the edge too), and a
  visually hidden " · <label>" for screen readers.
- **Chips:** with `filters`, a chip per band in view (swatch, label, row count; also at 0,
  so a shaded band always has a name) leads the chip bar;
  a picked chip shows only rows with an event inside it, OR between bands, AND with the
  other chips. A camera group narrows to the events inside the band (one left becomes a
  plain row); a burst stays whole when a step is inside. With category chips on, the band
  and the category must hold for the same event, so a group never shows an event of
  another category. A picked band that left the config is ignored, and a change to
  `context` clears the picks. Chips name the bands; without `filters` a small legend under
  the strip (or the chip bar's place, without the strip) does. A day with bands but no
  events still shows the strip, the band chips (at 0) and the legend above the empty state.

### 5.7 Deep links (P1)

Open a specific event from a URL: `…/dashboard/view#reel=<event id>` or
`?reel=<event id>`, accepting a Frigate review id, an LLM Vision uid or a merged id. The
card scrolls to the event and expands it. This lets mobile notifications link straight
to the clip.

### 5.8 Theming, i18n, a11y

- Use HA CSS variables only: `--primary-text-color`, `--secondary-text-color`,
  `--card-background-color`, `--divider-color`, `--primary-color`, `--state-*-color`,
  `--ha-card-border-radius`. Category colors go in a map and can be overridden with
  `colors:`.
- i18n: `en`, `nb`. `language: auto` picks from `hass.locale.language` (`nb`, `nn` and
  `no` map to `nb`) and falls back to `en`. Format times with `hass.locale` (12/24 h) in
  the **HA time zone** (`hass.config.time_zone`). Day boundaries use that time zone too.
  Rolling ranges are plain epoch arithmetic.
- Rows are buttons with aria labels, focus rings are visible, and players get captions
  when available.

### 5.9 Errors and empty states

- Each provider fails independently. If a provider errors, or hasn't answered within
  20 s, show a small warning chip ("Frigate unavailable") and still render the others
  (§3.7).
- A missing integration with an auto-enabled provider is silently skipped. If the
  provider was explicitly configured, show a warning.
- A media fallback is not an error. Log it once to the console.
- Empty range: "No events in the last 24 hours" (or "today"), plus the time of the last
  earlier event.
- No source at all (no entities, and no Frigate, Event Reel or LLM Vision that is installed
  and not switched off; `hasSource()` in `core/capabilities.ts`): "Nothing to show yet",
  what to add, and a link to the README's configuration section, instead of an empty range
  that would look like a quiet day (2026-10-22). Nest alone brings no events. When
  `hass.entities` or `hass.services` changes, the card detects again and fetches from a
  provider that just appeared, so a slow start never leaves the guidance up.

---

## 6. Feature backlog

| Prio | Feature |
|---|---|
| P0 (M1) | Entity provider, LLM Vision provider, Frigate reviews provider, many-to-one merge, doorbell clips by Nest token, compact rows, grouping (bursts, bounces, camera groups), animated previews with fallback chain, HLS player with codec fallback, rolling 24 h range, nb/en |
| P1 | Mark reviewed (+ mark all), download, filter chips and summary, day strip, deep links, GUI editor and stub config, HACS release |
| P2 | ~~Day navigation~~ (done), ~~context bands~~ (done), calendar provider, full Nest provider, bursts attached to camera events, time-range previews and synthesized clips once the Frigate integration releases the preview route (with a recording-coverage check), faces/sub_labels chips and "unknown person only" filter, ~~GenAI threat badge~~ (done) and `scene` fallback, search across days (a one-day version was built and dropped as too little gain over the chips; revisit when AI descriptions are reliable), presence at event time, "Summarize the day" (off by default) |
| P3 | Multi-camera sync, public provider API (`window.eventReel.registerProvider`), Reolink media-source provider, weekly heatmap |

---

## 7. Development workflow

1. **Real HA first.** From M0, deploy every build to a test view on the reference install
   and check it there. HA auth, signing, the integration proxies and the Companion apps
   can only be verified against real HA. The install-specific steps are in
   `CLAUDE.local.md`.
2. `npm run dev`: Vite dev server serving `dev/index.html`, for fast UI work. It mounts
   the card with a **mock `hass`** (`dev/mock-hass.ts`):
   - `callWS` answers `call_service llmvision.get_events`, `frigate/reviews/get` (as a
     JSON string), `logbook/get_events`, `history/history_during_period`,
     `media_source/*` and `auth/sign_path` from fixtures.
   - A **Vite proxy** maps the HA Frigate proxy paths to a Frigate instance from the env
     var `FRIGATE_URL` (gitignored `.env.local`), so real video plays locally:
     `/api/frigate/{iid}/vod/...` → `${FRIGATE_URL}/vod/...`,
     `/api/frigate/{iid}/notifications/{id}/review_preview.gif` → `${FRIGATE_URL}/api/review/{id}/preview`,
     `/api/frigate/{iid}/clips/...` → `${FRIGATE_URL}/clips/...`, and so on. This does
     not exercise HA auth or signing. The proxy only forwards requests from a page opened
     with `?live=1` (by the Referer) and answers 404 otherwise: the example data's camera
     names can match a real Frigate's, and example screenshots must never show its footage.
   - Fixtures: commit only anonymized `*.example.json`. Real snapshots go in
     `*.local.json` (gitignored).
3. `npm test`: Vitest unit tests (merge, grouping, cameras, provider parsers, time).
4. `npm run build` → `dist/event-reel-card.js`. `npm run lint` (eslint + tsc
   `--noEmit`).
5. Check: desktop Chrome, Firefox (no HEVC), mobile width 375 px, the HA Companion app
   on Android (and iOS if available), light and dark themes.

---

## 8. Release and HACS

- `hacs.json`: `{ "name": "Event Reel Card", "filename": "event-reel-card.js",
  "render_readme": true, "homeassistant": "<min>" }`. Set the minimum HA version from
  the APIs actually used (`getConfigForm`, `formatEntityState`, `getGridOptions`).
- GitHub Actions:
  - `ci.yml`: on push/PR, run `npm ci && npm run lint && npm test && npm run build`, and
    the HACS Action (`hacs/action@main`, category `plugin`, as HACS documents it).
  - `release.yml`: on tag `v*`, build and attach `dist/event-reel-card.js` to the GitHub
    release.
- Use SemVer, starting at `v0.1.0`. Keep a `CHANGELOG.md`.
- HACS default repositories (checked 2026-10-13 in HACS's "include" guide): the HACS
  Action must pass with no ignores, then a full GitHub release (not just a tag) must follow,
  then a PR to `hacs/default` adds the repository. Reviews take months. The card can be
  submitted on its own; the brands check only applies to integrations.
- Test installing the tagged release through HACS, not only a local `dist/` copy.
- The README covers features, a screenshot or GIF (from the dev harness with neutral
  footage, never private camera footage without the owner's OK), install
  (HACS custom repository and manual), the config reference, "Register your own
  events", the dependency tiers (§3.8), and troubleshooting (HEVC, retention, signed
  URLs, the Frigate notification proxy option).

---

## 9. Milestones and acceptance criteria

**Spikes (before or early in M1, about an hour each; record the results in §2)**
- S1. Playback matrix: HEVC (`hev1`) and H.264 VOD through HA on desktop Chrome, Firefox,
  the Android Companion app, and iOS (Companion or Safari) if available. Confirm the
  §5.4 fallback triggers fire.
  *Partly done (2026-10-10):* desktop Chromium plays the 4K HEVC `hev1` clip through the HA
  proxy with hls.js; the first frame takes about 4.5 s on the LAN (first segment ≈13 MB).
  Browsers hold back playback in hidden tabs, so the start timeout pauses while the page
  is hidden. The owner confirmed playback in the Companion app on their phone. Firefox
  and the other mobile platform are still open.
  *Firefox 157 on Windows (2026-10-13, headless, hls.js light, real recordings through a
  local proxy, not HA):* it reports `hev1`/`hvc1` as supported (`isTypeSupported` and
  `canPlayType` "probably"). H.264 2880×1616 played (848 frames in 28 s). The 4K HEVC clip
  failed with a decode error (`RemoteMediaManager is not available`), and hls.js raised a
  fatal media error, which is what the card's codec fallback reacts to. Headless Firefox
  has no remote decoder process, so HEVC in a normal Firefox window is still open.
  *Firefox 158 on Windows 11 (2026-10-17, a normal window driven over WebDriver BiDi, the
  card in the dev harness with real recordings through the dev proxy, not HA):* the 4K HEVC
  `hev1` clip played in the card's player at 3840×2160 with no error and no fallback (666
  frames in 27 s, about 24 fps, first frame within 5 s). The H.264 2880×1616 clip played
  too (859 frames in 29 s). That machine has Microsoft's HEVC Video Extensions installed;
  Firefox without them, Firefox on macOS and Linux, and iOS are still open.
- S2. `frigate/reviews/subscribe` payload shape and behaviour after a reconnect. *From
  source:* the payload is the raw MQTT JSON string; the subscription registers in
  `connection.subscriptions`, so HA's generic unsubscribe works. The card only refetches on
  a message, so the shape doesn't matter.
- S3. The review still through `clips/review/...` via HA. *Done:* loads through HA.
- S4. VOD for an ongoing review (`end_time: null`) and for a review past retention.
  *Done on Frigate directly (2026-10-13):* an end in the future is harmless, and past
  retention is a 404 (§2.2).
- S5. A lock's `changed_by` through `history/history_during_period` with attributes.
  *Done:* all lock changes on the reference install got an actor.
- S6. Whether the LLM Vision calendar entity changes state right after a new event.

**M0. Scaffold**
- package.json, tsconfig, vite config, eslint/prettier, vitest, hacs.json, CI workflow,
  dev harness skeleton.
- Done when: `npm run build` produces a single file, the card renders "Event Reel" in the
  dev harness **and on a test view of the reference install**, and CI is green.

**M1. Replace the 24 h timeline (MVP, all P0 items)**
- Done when, on a test view of the reference install:
  1. The camera AI events for the last 24 h match the existing `llmvision-card`
     (same count and titles).
  2. Door, lock and presence come from `entities:`, with no duplicates
     (`llmvision.non_camera: false`).
  3. An entry sequence (unlock, open, close, lock) shows as one row.
  4. AI events on Frigate cameras attach to their review (reference: at least 65 of 67),
     and a second AI event on the same review attaches to it. The AI event at 14:16:26
     merges with the review 14:15:43–14:16:32 on the same camera (unit test).
  5. Reviews from a camera without AI show as their own rows.
  6. A doorbell AI event plays its Nest clip.
  7. Previews animate. The exact clip plays through the HA proxy on desktop Chrome.
     Where HEVC can't play (Firefox, possibly iOS), the preview plays with a clear
     message and a download option. Tested in the Android Companion app.
  8. A full day is readable at 375 px width. Reduced motion stops the animation. Rows
     open and close by touch and keyboard.
  9. It runs a full day next to the old card without errors.
- Then, **with the owner's approval:** replace the old card in the existing view (keeping
  its header, badges and shortcuts) and turn off the automation that copies door/lock/
  presence into LLM Vision.

**M2. Polish (P1)**
- Mark reviewed, download, filter chips, day strip, deep links, GUI editor.
- Done when: the GUI editor covers the common options without breaking YAML-only
  options, and a deep link from a mobile notification opens the clip.
- *Status (2026-10-10):* implemented.
  - Mark reviewed per event and "mark all" (for the visible rows) via
    `frigate/reviews/viewed`, shown optimistically until Frigate reports it.
  - Category chips (rows per category; a burst matches any category it contains) and a
    camera menu.
  - The day strip with ticks, an hourly histogram and 6-hour marks; tap or drag scrolls to
    the nearest row and highlights it.
  - Deep links `?reel=` / `#reel=` with a review id, an LLM Vision uid or our id; a notice
    when the event isn't in range.
  - The GUI editor is a custom element over `ha-form`, mapped through `editor-model.ts`, so
    per-entity options and other YAML-only keys survive. Providers can be switched off
    with `enabled: false` inside their object, which keeps their options.
  - `getStubConfig` suggests locks, door sensors and people.
  - The empty state shows the time of the last earlier event.
  - In HA 2026.10 the entity pickers read `hass` from a Lit context, so the editor only
    works inside HA's own app tree (the real card editor dialog), not when mounted
    elsewhere.

**M3. Release `v0.1.0`**
- README, CHANGELOG, a11y pass, release workflow, install through a HACS custom
  repository on the reference install from the tagged release.
- *Status (2026-10-10):* local work done. That covers the README (features, dependency
  tiers, install, options, own events, deep links, troubleshooting) with a screenshot of
  generated data, the CHANGELOG, version 0.1.0, an a11y pass, and a release workflow
  that checks the tag against the package version.
- *Released 2026-10-10:* `v0.1.0` is public on GitHub, published as one clean commit.
  CI and the release workflow passed, and the release carries `event-reel-card.js`. It is
  installed through HACS (custom repository) on the reference install, and the HACS file
  matches the release byte for byte. The card replaced the old timeline card in the
  reference install's day view, and the automation that copied door/lock/presence changes
  into LLM Vision is switched off.

**M4+. P2 items.**
- *After 0.1.0 (2026-10-11):* independent provider loading with a deadline (§3.7; the
  top suggestion from a GPT-6-astra review, whose two defects were confirmed in the code)
  and day navigation (§5.1).

---

## 10. Privacy rules (public repository)

- Never commit entity ids, names, hostnames, IPs, tokens, camera footage or fixtures
  from a real home. Use neutral examples (`camera.entrance`, `person.alex`).
- Real-install notes go in `CLAUDE.local.md` (or `AGENTS.local.md`) and real fixtures in
  `*.local.json`. All are gitignored.
- Contributions, including AI-assisted ones, follow `CONTRIBUTING.md`; agents follow
  `AGENTS.md`.
- Check `git diff --cached` for private data before every commit.

## 11. Open questions

1. Name: "Event Reel Card" (`custom:event-reel-card`). Rename before v0.1.0 if a better
   one comes up.
2. Should the card have a "timeline only" mode (no list, just the day strip plus a
   player) for wall tablets?
3. When the Frigate integration releases the time-range preview route, enable previews
   and synthesized clips for unmatched AI events (P2).

## 12. Review log

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
