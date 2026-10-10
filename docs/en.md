# STM Montréal

This integration brings Montréal's **next STM bus departures**, the **metro
line status** and the **availability of BIXI stations** into Gladys.

It is not affiliated with the Société de transport de Montréal (STM) nor with
BIXI Montréal. The data comes from the STM open data (CC BY 4.0 licence,
source: Société de transport de Montréal) and from the public BIXI GBFS feed.

## Requirements

- Gladys Assistant **5.1.0** or later.
- For buses and the metro: a free, personal **STM API key**.
- For BIXI: nothing, the feed is open.

## Getting an STM API key

1. Create an account on the
   [STM developer portal](https://portail.developpeurs.stm.info/apihub).
2. Add an application.
3. Subscribe it to the **GTFS-realtime** API (bus departures) and the **i3**
   API (service status).
4. Create a key, then publish it.
5. Paste the key in the "STM API key" field of the integration configuration.
   The "shared secret" is not needed.

The **Test the STM API key** button checks both APIs separately, so it tells
you which API your application is not subscribed to.

### Quota

The STM grants **10,000 requests a day per account**, across all your
applications. The integration reads the bus feed **once per interval, whatever
the number of stops**. With the default settings it uses about:

- 1,440 requests a day for buses (one read a minute);
- 720 requests a day for the metro (one read every 2 minutes).

The connection status shown in Gladys gives the estimate for your
configuration. Dashboard widgets reuse the latest reads, so they cost no extra
quota.

## What to watch

### Bus stops

The **stop code** is the five-digit number written on every STM bus stop sign.
You can also find it in the STM app and on stm.info.

Syntax of the "Bus stops" field: `<code>[@<route>|<route>][:<name>]`. Separate
stops with commas.

| Entry                  | Meaning                              |
| ---------------------- | ------------------------------------ |
| `52743`                | every bus calling at stop 52743      |
| `51003@24`             | route 24 only                        |
| `61503@69\|469`        | routes 69 and 469                    |
| `51003@24:Bus to work` | route 24, displayed as "Bus to work" |

A stop serves only one direction: pick the stop on the side of the street where
you board.

Each stop becomes a device with:

- **Next departure**, **Departure 2**…: the minutes to wait. The value 999
  means no departure is scheduled.
- **Next departure route**…: the route number.
- **Next departures**: a summary, e.g. `24 3 min · 24 11 min · 747 14 min`.

Set how many departures are exposed with "Departures per stop" (1 to 5).

### Metro

The **Watch the metro** option (on by default) creates an "STM metro" device.
For each of the green, orange, yellow and blue lines, it exposes:

- **status**: `Normal`, `Disrupted`, `Notice` or `Unknown`;
- **message**: the STM message, e.g. "Normal métro service" or the text of the
  disruption.

The metro has no real-time predictions in the STM open data. The integration
therefore gives the line status only, not train times.

### BIXI stations

Enter the station ids, with an optional name after `:`, e.g.
`1, 42:Station at home`. The **Find a BIXI station** button looks up an id from
the station name.

Each station becomes a device with:

- **Bikes**: the number of bikes available, e-bikes included;
- **Electric bikes**;
- **Free docks**;
- **Status**.

## Dashboard

Three widgets are available:

| Widget             | Content                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| STM bus departures | the next departure and the list of the following ones                  |
| STM metro status   | the 4 lines in color, and the message of any line not running normally |
| BIXI station       | bikes, e-bikes, docks, fill gauge, 24-hour curve                       |

## Scenes

**Triggers:**

- **STM bus approaching**: a bus goes under a threshold of 1, 2, 3, 5, 10 or 15
  minutes. A route filter is available. Each bus is followed from one read to
  the next, so the next bus taking its place in the list does not fire the
  scene by mistake.
- **STM metro status changed**: a line is disrupted, gets back to normal, or
  receives a notice.
- **BIXI station changed**: the station runs out of bikes or docks, gets some
  back, or changes service.

Nothing fires on the first read after the integration starts.

**Actions:**

- **Read the next STM buses**: returns the route, the minutes, the following
  departure and the summary. For example: "Your 24 comes in {{minutes}}
  minutes".
- **Read an STM metro line status**: returns the status, the message and
  `normal` (true or false).

## Troubleshooting

- **Nothing in the Discovery screen**: check the "Bus stops" and "BIXI
  stations" fields. The connection status lists what is being watched.
- **"The STM refused the API key"**: check the key, then check that the
  application is subscribed to both APIs on the portal.
- **"Quota used up"**: raise the refresh intervals, or check that no other
  application uses the same account.
- **A stop stays at 999**: either no bus is scheduled (at night), or the stop
  code or the route filter is wrong.

## Data and licences

- STM data:
  [CC BY 4.0](https://www.stm.info/en/about/developers) licence, source:
  Société de transport de Montréal.
- BIXI data: public GBFS feed of BIXI Montréal.
- Integration code: Apache 2.0 licence.
