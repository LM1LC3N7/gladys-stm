# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Shared tooling of the LM1LC3N7 Gladys integrations: CI on Node 22 and 24 with `npm audit`, Release workflow driven by this changelog, GitHub Releases from its sections, grouped Dependabot updates.
- Gladys integration SDK 0.15: poll-frequency and batch validation of the discovered devices, state heartbeat, the SDK fake Gladys for the tests.

## [0.2.2] - 2026-10-11

### Fixed

- With an STM key, the bus stops added from the Discover tab (suggested near
  the house) showed no departure: the real-time feed was only decoded for the
  stops typed in the configuration. Every stop is decoded now.

## [0.2.1] - 2026-10-10

### Changed

- Bus stop and BIXI station devices are named "Bus – …" and "BIXI – …", so
  the two kinds are easy to tell apart in the Discover tab and the device
  list. Devices already added keep their name: rename them in Gladys, or
  delete and add them again.
- A BIXI station missing from the network feed (removed for the winter) is
  shown as removed: 0 bikes, 0 docks, a "Removed from the BIXI network" state,
  an orange dot on the device, one "out of service" scene event (one "back in
  service" when it returns), and a read every 15 minutes instead of an error
  every minute. It used to keep its last values all winter.
- GitHub Actions updated (checkout 7, setup-node 7, Docker actions), and
  Dependabot now groups the action updates in a single pull request.

## [0.2.0] - 2026-10-10

### Added

- Next STM bus departures for the watched stops, from the STM GTFS-Realtime
  feed, read once per interval for all the stops.
- Status of the four metro lines, from the STM i3 service-status API.
- BIXI stations: bikes, e-bikes and free docks, from the open GBFS feed.
- Dashboard widgets: bus departures, metro status, BIXI station.
- Scene triggers: bus approaching, metro status changed, BIXI station changed.
- Scene actions: read the next buses of a stop, read a metro line status.
- Configuration actions: test the STM API key, find a bus stop, find a BIXI
  station.
- Works without any account: the bus stops and BIXI stations closest to the
  house (Gladys house location) are offered in the Discover tab, named with
  their street corner and the direction of their routes.
- Without an STM key, the scheduled bus times from Transitous, marked "~"; the
  key adds real time and the metro status.
- The connection status line tells what to do next (locate the house, add the
  devices, what a key would add).
- A step-by-step guide to get the STM key in the user documentation.

[Unreleased]: https://github.com/LM1LC3N7/gladys-stm/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/LM1LC3N7/gladys-stm/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/LM1LC3N7/gladys-stm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LM1LC3N7/gladys-stm/releases/tag/v0.2.0
