# Gladys STM Montréal

External integration for [Gladys Assistant](https://gladysassistant.com) that
brings Montréal public transit into your smart home:

- **next STM bus departures** at the stops you choose (real time, GTFS-Realtime);
- **status of the four metro lines** (green, orange, yellow, blue), with the
  STM service messages;
- **BIXI stations**: bikes, e-bikes and free docks (open GBFS feed, no key).

Unofficial: not affiliated with the Société de transport de Montréal nor with
BIXI Montréal.

User documentation: [français](docs/fr.md) · [English](docs/en.md).

## What you get in Gladys

| Kind                  | Content                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Devices               | one per bus stop (minutes to wait, route, summary), one for the metro (status + message per line), one per BIXI station |
| Dashboard widgets     | bus departures board, metro status, BIXI station                                                                        |
| Scene triggers        | bus approaching (1–15 min), metro line disrupted / restored / notice, BIXI station empty / full                         |
| Scene actions         | read the next buses of a stop, read the status of a metro line                                                          |
| Configuration buttons | test the STM API key, find a BIXI station by name                                                                       |

Requires Gladys **5.1.0** or later. Bus departures and the metro status need a
free personal key from the
[STM developer portal](https://portail.developpeurs.stm.info/apihub) (quota:
10,000 requests a day per account; the integration uses about 2,200 with the
default settings, whatever the number of stops).

## Development

```bash
npm install
npm test               # node --test, no network access
npm run lint           # ESLint
npm run format:check   # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store .   # store admission checks
```

The project follows the official
[integration template](https://github.com/GladysAssistant/integration-template-js):
Node 22+, ES modules, the Gladys SDK as the only runtime dependency, a Docker
image published to GHCR by the Release workflow. See [CLAUDE.md](CLAUDE.md) for
the architecture and the conventions.

### Publishing a version

1. In GitHub: **Actions → Release → Run workflow** (patch / minor / major). It
   bumps the version everywhere, rolls the changelog, tags, builds the
   multi-arch image (`linux/amd64`, `linux/arm64`) and creates the GitHub
   Release.
2. The first time only: make the GHCR package **public**
   (`github.com/LM1LC3N7/gladys-stm/pkgs/container/gladys-stm` → Package
   settings → Change visibility). The store refuses an image it cannot pull.
3. Add the topic `gladys-assistant-integration` to the repository: the store
   indexer picks the integration up within the hour.

## Data and licences

- STM data: [CC BY 4.0](https://www.stm.info/fr/a-propos/developpeurs/condition-dutilisation),
  source: Société de transport de Montréal.
- BIXI data: public GBFS feed of BIXI Montréal.
- Code: Apache License 2.0. Parts of `src/devices/` are adapted from
  [prohand/gladys-transport-commun-lyonnais](https://github.com/prohand/gladys-transport-commun-lyonnais)
  (Apache-2.0), see [NOTICE](NOTICE).
