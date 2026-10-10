# CLAUDE.md

Guidance for Claude Code (and any other contributor) working in this repository.

## What this project is

An **external Gladys Assistant integration** for Montréal public transit. It
runs as a Docker container next to a Gladys instance, talks to Gladys through
the official SDK (`@gladysassistant/integration-sdk`), and publishes
**read-only** devices: one per watched STM bus stop, one for the metro status,
one per watched BIXI station.

Not affiliated with the STM nor with BIXI. Data: STM open data API (personal
key, `apiKey` header, 10,000 requests a day per account), the open BIXI GBFS
feed, and Transitous (keyless: stops near the house, stop search, names,
scheduled times when there is no STM key).

**Design goal: usable by somebody who is not technical.** Nothing to type to
start: the house location (`location: true`) gives the suggested stops and
stations, the STM key is optional, and the connection status line
(`src/status.js`) always says what to do next. Keep it that way: every new
setting needs a default that works, and every failure a message that says what
to do.

## Commands

```bash
npm ci
npm test               # node --test, no framework, no network access
npm run lint           # eslint
npm run format         # prettier --write .
npm run format:check   # what CI checks
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `npm test`, `npm run lint` and `npm run format:check` before every commit:
CI (`.github/workflows/ci.yml`) runs the three. The CI minutes are counted:
batch the pushes (one push a day at most, unless asked otherwise).

## Layout

```
index.js                      SDK wiring only: handlers, connect, status
src/config.js                 defaults, type coercion, watch-list mini-syntax, quota estimate
src/api/http.js               fetch with timeout and User-Agent
src/api/gtfsRealtime.js       minimal GTFS-Realtime decoder (watched stops only)
src/api/stm.js                STM API client: bus departures, per-interval feed cache, errors
src/api/metro.js              STM i3 "état du service": metro line statuses
src/api/bixi.js               BIXI GBFS client, per-cycle cache, station search
src/api/transitous.js         Transitous: stops near a point, stop search, descriptions, timetable
src/status.js                 the connection status line: what the user must do next
src/devices/index.js          device registry (typed + suggested + created) + manifest actions
src/devices/suggestions.js    the bus stops and BIXI stations closest to the house
src/devices/busStop.js        one device per watched bus stop
src/devices/metroStatus.js    the metro status device
src/devices/bixiStation.js    one device per watched BIXI station
src/devices/pollSchedule.js   drops the poll ticks inside the configured interval
src/devices/stateCache.js     drops the states that did not move since the last read
src/devices/publish.js        publishes only to the features the created device has
src/devices/readings.js       last reading per device, shared with the widgets
src/devices/refreshLoop.js    the container's own ticker over the created devices
src/scenes/triggers.js        scene events, computed between two polls of a device
src/scenes/actions.js         scene actions: a fresh read handed to the scene
src/widgets/index.js          dashboard widgets
test/                         node:test suites; helpers: fake SDK, fetch stub, GTFS-RT encoder, fixtures
docs/en.md, docs/fr.md        user documentation (re-hosted by Gladys)
gladys-assistant-integration.json   the store manifest
```

Keep the separation: `index.js` holds no transit logic, `src/api/` only reads
the sources, `src/devices/` only turns a reading into features, `src/scenes/`
and `src/widgets/` only turn a blueprint's `read` into events, outputs and
cards.

## Data sources: what is known and how

- **Bus stops**: an STM bus stop's `stop_id` equals its `stop_code`, the
  five-digit number on the sign (checked on the static GTFS of 2026-08: all
  8,606 bus stops; only the 72 metro platforms differ). The GTFS-Realtime
  TripUpdates carry `stop_id`, `trip.route_id` (= route short name) and
  absolute `arrival.time` / `departure.time`.
- **The decoder** (`src/api/gtfsRealtime.js`) was cross-checked by hand against
  the official `gtfs-realtime-bindings` 2.2.0 in both directions (decode their
  encoding, encode for their decoder), negative delays included. It decodes a
  5.7 MB feed in ~40 ms with ~16 MB of heap. Re-run such a check if you touch
  the wire-format code.
- **Metro (i3)**: undocumented in the open. The shape and the "Service normal
  du métro" convention come from open-source readers of the API: MTransit
  (`mtransitapps/commons-android`, `EtatServiceResponse.kt` and
  `ca-montreal-stm-subway-android` `stm_info_api_values.xml`) and
  `darcymccoy/metro-rem-status` (`lib/stm.ts`). The parser is defensive; a
  real payload captured with a key should replace the fixtures in
  `test/helpers/fixtures.js` when available.
- **API hub errors**: a bad key AND an exhausted personal quota both answer
  HTTP 400 (`Invalid API Key` / `Rate limit and/or quota exceeded`); the global
  limit is a 429. Tell them apart by the body (`stmErrorFor`).
- **BIXI**: GBFS 2.2, `station_id` is a string of digits, `is_installed` /
  `is_renting` / `is_returning` are 0/1 integers, `num_bikes_available`
  includes the e-bikes.

## Conventions

- ES modules, Node >= 22, no runtime dependency besides the SDK. Do not add
  one without a strong reason (the 256 MB sandbox is why the GTFS-RT decoder is
  hand-written).
- Prettier decides formatting; ESLint decides the rest.
- Comments explain **why**, in full sentences, in English.
- Every user-visible string in the manifest, actions and widgets is bilingual
  (`{ en, fr }`); text features follow the `language` setting.
- **External ids, feature keys, manifest keys are forever**: Gladys keys the
  devices, their history, the scenes and the dashboards on them.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json` / the manifest, nor the `docker_image` tag, by hand.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Never commit an API key**, nor a personal stop: use network landmarks in
  examples and tests (e.g. stop 52743, ÉTS; BIXI station 1).
- Tests never touch the network: `test/helpers/stubFetch.js` routes `fetch`.

- **Transitous**: ids are `ca-qc-STM_<stop_id>`; bus stops are the 5-digit
  codes (metro stations are `STATION_Mxxx`, platforms `9999xxx` or 1–68).
  `/v1/map/stops?min=&max=` (bounding box), `/v1/geocode?text=&type=STOP`,
  `/v5/stoptimes?stopId=&n=` (scheduled; `realTime` false for the STM when
  checked). Usage policy: open-source non-commercial, User-Agent with a
  contact, stay light — keep the caches and the 120 s floor
  (`MIN_SCHEDULE_POLL_FREQUENCY`).
- **Created devices** are rebuilt from their params (`stop_code`, `routes`,
  `station_id`): never rename those params.

## Roadmap ideas

- Ask the Transitous team for an explicit OK before the integration gets many
  users (their policy asks to be contacted for heavy use).
- Screenshots in the user documentation (the STM portal needs a login).
- Other Québec networks reachable with the same decoder: exo and RTL (Chrono
  API), STO Gatineau, Saguenay.
