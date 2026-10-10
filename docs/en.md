# STM Montréal

The **next STM buses**, the **metro status** and the **BIXI bikes** near your
home, in Gladys.

This integration is not affiliated with the Société de transport de Montréal
(STM) nor with BIXI Montréal.

## Get started in 3 steps

No technical knowledge is needed, and no account to begin with.

1. **Check the address of your house in Gladys**: _Settings → Houses_. The
   house must have a position on the map. The integration uses it to find the
   stops near you. The position stays in your Gladys.
2. **Install the integration** from the integration catalog, and accept the
   access to the house location. Open its configuration page and press
   **Save**, without filling anything in.
3. Open the **Discover** tab of the integration. The 3 bus stops and 2 BIXI
   stations closest to your home are offered there, with their name and the
   direction of their routes, e.g. "Bus – Notre-Dame / Peel (36 → Ouest)". Press
   **Add** on each one you want.

That's it. You now get the **scheduled times** of the next buses at each stop,
and the bikes and free docks of each BIXI station.

The message at the top of the configuration page always tells you what to do
next. For example: "Ready: 3 bus stops and 2 BIXI stations to add. Open the
Discover tab…".

Device names start with **Bus –** or **BIXI –**, so they are easy to tell
apart in the device list of Gladys. You can rename them freely in Gladys.

### Showing the departures on the dashboard

1. Open the dashboard, then press **Edit**.
2. Add a widget and choose **STM bus departures**.
3. Choose the stop, then save.

The **BIXI station** widget is added the same way. The **STM metro status**
widget needs an STM key (see below).

Scheduled times carry a **~**, as on the STM signs: "~12 min" means "scheduled
in 12 minutes".

## Going real time and adding the metro (optional)

With a free, personal **STM API key**:

- the scheduled times become **real-time predictions** (where the buses
  actually are);
- the **STM metro** device appears, with the status of the green, orange,
  yellow and blue lines.

### Getting the STM API key (5 minutes)

1. Go to the
   [STM developer portal](https://portail.developpeurs.stm.info/apihub) and
   **create an account** (email and password). Confirm the email you receive.
2. Once logged in, **add an application**. The name does not matter, e.g.
   "Gladys home".
3. In that application, **subscribe to both APIs**:
   - **GTFS-realtime**: the real-time bus departures;
   - **i3**: the metro service status.
4. **Create a key**, then **publish it**. The portal shows an "API key" and a
   "shared secret". Only the API key is needed.
5. In Gladys, open the configuration of the integration. Paste the key in
   **STM API key**, then press **Save**.
6. Press **Test the STM API key**. Both lines must show ✔. A ✖ line tells you
   which API your application is missing.
7. Go back to the **Discover** tab and add the **STM metro** device.

The labels of the STM portal may differ slightly: when in doubt, the
[portal FAQ](https://www.stm.info/en/about/developers) describes the same
steps.

**Quota.** The STM grants 10,000 requests a day per account. With the default
settings the integration uses about 2,200, **whatever the number of stops**:
one read of the STM data serves all your stops. The message of the
configuration page shows the estimate for your setup.

## Watching other stops (work, school…)

For a stop far from home:

1. At the bottom of the configuration page, press **Find a bus stop**. Type a
   street corner, e.g. "Sherbrooke Papineau".
2. The answer lists the stops with their code and the direction of their
   routes, e.g. `52682 — Papineau / Sherbrooke (24 → Est, 45 → Sud)`.
3. Copy the code (`52682`) in **Bus stops**, save, then add the stop in the
   **Discover** tab.

The code is also the five-digit number written on every STM bus stop sign.

For BIXI stations, the **Find a BIXI station** button works the same way.

### Going further

The **Bus stops** field accepts several codes separated by commas, a route
filter after `@` and a name after `:`.

| Entry                  | Meaning                              |
| ---------------------- | ------------------------------------ |
| `52743`                | every bus calling at stop 52743      |
| `51003@24`             | route 24 only                        |
| `61503@69\|469`        | routes 69 and 469                    |
| `51003@24:Bus to work` | route 24, displayed as "Bus to work" |

## What each device holds

**Bus stop:**

- **Next departure**, **Departure 2**…: the minutes to wait. 999 means no
  departure is scheduled.
- **Next departure route**…: the route number.
- **Next departures**: a summary, e.g. `24 3 min · 747 14 min`.

**STM metro** (with a key): for each line, a **status** (`Normal`,
`Disrupted`, `Notice` or `Unknown`) and the STM **message**. The STM publishes
no real-time train times: only the line status is available.

**BIXI station:** the bikes (e-bikes included), the e-bikes, the free docks
and the state of the station.

## Scenes

**Triggers:**

- **STM bus approaching**: a bus gets under 1, 2, 3, 5, 10 or 15 minutes.
  Example: "when the 24 is 5 minutes away, turn the hall light on".
- **STM metro status changed**: a line is disrupted, gets back to normal, or
  receives a notice. Example: "if the orange line is disrupted, send me a
  message".
- **BIXI station changed**: the station runs out of bikes or docks, or gets
  some back.

**Actions:**

- **Read the next STM buses**: e.g. a message every morning "Your 24 comes in
  {{minutes}} minutes".
- **Read an STM metro line status**: returns the status, the STM message and
  `normal` (true or false).

## Troubleshooting

| Message or symptom                                | What to do                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "set the address of your house"                   | _Settings → Houses_: place the house on the map, then save the configuration of the integration again. |
| "Gladys did not share the location of your house" | Reinstall the integration and accept the location access, or type stop codes.                          |
| Nothing in the Discover tab                       | Read the message of the configuration page: it says what is missing.                                   |
| "The STM refused the API key"                     | Check the key, and that the application is subscribed to both APIs (GTFS-realtime and i3).             |
| "Quota used up"                                   | Raise the intervals (Advanced section), or check no other application uses the same STM account.       |
| A stop stays at 999                               | No bus scheduled (at night), or a route filter matching no route of the stop.                          |

## Privacy, data and licences

- The house location is only used to look the nearby stops up. Only a box of
  a few hundred meters around the house is sent to Transitous. Nothing is sent
  anywhere else.
- Scheduled times, stop names and search:
  [Transitous](https://transitous.org/sources/), a free community service,
  from the STM data.
- Real time and metro status: STM open data,
  [CC BY 4.0](https://www.stm.info/en/about/developers) licence, source:
  Société de transport de Montréal.
- Bikes: public GBFS feed of BIXI Montréal.
- Integration code: Apache 2.0 licence.
