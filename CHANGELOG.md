# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Next STM bus departures for the watched stops, from the STM GTFS-Realtime
  feed, read once per interval for all the stops.
- Status of the four metro lines, from the STM i3 service-status API.
- BIXI stations: bikes, e-bikes and free docks, from the open GBFS feed.
- Dashboard widgets: bus departures, metro status, BIXI station.
- Scene triggers: bus approaching, metro status changed, BIXI station changed.
- Scene actions: read the next buses of a stop, read a metro line status.
- Configuration actions: test the STM API key, find a BIXI station.
