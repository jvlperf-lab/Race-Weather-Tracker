# DA/RAW — Track Air Density Reader

A static, no-build website that averages current weather across up to
nine independent free sources, then derives the numbers that actually
matter trackside: density altitude, air density ratio, an SAE J1349
correction factor, and vapor pressure — plus wind relative to your
starting line, a rolling 24-hour history, and a 15-minute-step forecast
for the next two hours.

No API keys, no backend, no signup. Four files: `index.html`,
`style.css`, `app.js`, `README.md`.

## Run it locally

```bash
cd da-tracker
python3 -m http.server 8000
```

Open `http://localhost:8000`. A local server avoids the fetch()
restrictions some browsers apply to `file://` pages.

## Deploy it (all free, no domain purchase needed)

**Netlify (drag and drop, fastest)** — https://app.netlify.com/drop —
drag the `da-tracker` folder in, get a live `*.netlify.app` URL in
seconds, no account required for a one-off drop.

**GitHub Pages** — new repo → upload the four files to the repo root
(not a subfolder) → Settings → Pages → Deploy from branch `main` / root
→ live at `https://<you>.github.io/<repo>/`.

**Vercel** — `npm i -g vercel`, then `vercel --prod` from inside
`da-tracker/`.

## What's on the page

- **Density altitude** (hero number), **air density ratio**,
  **correction factor**, **vapor pressure**, **station baro**, and
  **humidity** — the core trackside readout.
- **Wind vs. track**: set a starting-line heading (compass degrees,
  direction of travel from start to finish) and the panel computes
  headwind/tailwind and crosswind components, with a compass diagram
  marking START and FINISH. Heading is saved per location automatically
  (keyed to rounded lat/lon), independent of whether you've bookmarked
  the track.
- **Averaged conditions** and a full **source breakdown** — every
  source that answered, with its raw numbers, so you can see the spread
  behind the average.
- **Last 24 hours**: a chart with a dashed hourly backfill (pulled from
  Open-Meteo's recent-history archive on load) and a solid live-recorded
  line, sampled every 5 minutes while the page stays open in your
  browser. Switch the metric with the dropdown.
- **Next two hours**: a 15-minute-step table from Open-Meteo's
  high-resolution short-range forecast (best-match model only — see
  note below).
- **Track/venue search**: queries OpenStreetMap Nominatim (good for
  named tracks and venues) and Open-Meteo's geocoder (good for cities)
  together, tagging each result "Track" or "Place."

## How the numbers work

- **Pressure altitude**: from each source's actual *station-level*
  pressure (not sea-level-adjusted): `PA(ft) = 145366.45 * (1 -
  (P_station_hPa / 1013.25)^0.190284)`.
- **Density altitude**: the FAA/aviation approximation, `PA + 120 *
  (OAT − ISA temp at PA)`, 1.98°C/1,000 ft lapse rate — the same
  approximation most trackside DA calculators use.
- **Vapor pressure**: actual (not saturation) vapor pressure, from the
  Buck equation and relative humidity.
- **Air density ratio**: computed directly from the ideal gas law using
  actual station pressure, temperature, and vapor pressure — more
  precise than the FAA approximation, useful to sanity-check against.
- **Correction factor**: SAE J1349, `CF = (99 / Pd_kPa) *
  sqrt(T_K / 298)`, where `Pd` is dry-air pressure (station pressure
  minus vapor pressure) and `T` is ambient temp in Kelvin. This is a
  dyno-style automotive standard, shown for cross-reference — it is
  *not* an NHRA index and isn't a substitute for your own SAE/NHRA
  calculator.
- **Averaging**: simple arithmetic mean per field across whichever
  sources returned that field, except wind direction, which uses a
  circular (vector) mean.
- **Head/tailwind and crosswind**: resolved from the averaged wind
  vector against your saved starting-line heading. Positive
  head/tailwind reads as tailwind; positive crosswind reads left-to-right
  facing down the track.

## Notes / limitations

- **NWS station data is US-only.** Outside the US that source shows red
  and the average leans on the Open-Meteo models.
- **True 5-minute historical data doesn't exist for free, retroactively.**
  No free source publishes sub-hourly history. On load you get an
  hourly backfill for the trailing 24h; from that point forward, the
  page itself records a real data point every 5 minutes into your
  browser's local storage, so the history genuinely deepens the more
  you leave it open. Closing the tab pauses recording; reopening it
  resumes and the hourly backfill fills the gap.
- **The forecast table uses a single model** (Open-Meteo best-match),
  not the full multi-source average — averaging nine sources at
  15-minute resolution two hours out isn't something any of them
  reliably support, and it would multiply the number of requests
  substantially. Treat it as a trend indicator, not a precision reading.
- **Some Open-Meteo models occasionally omit `surface_pressure`** for a
  given run; that source's card shows `—` for pressure and is excluded
  from the pressure average only, not the whole source.
- **Nominatim (OSM) usage policy**: please don't hammer it — the search
  box already debounces requests. Attribution: © OpenStreetMap
  contributors.
- **Saved tracks and headings live in `localStorage`** — per
  browser/device, not synced anywhere.
- Everything is a plain client-side `fetch()` to public, CORS-enabled
  APIs (`api.weather.gov`, `api.open-meteo.com`,
  `geocoding-api.open-meteo.com`, `nominatim.openstreetmap.org`) plus
  Chart.js from a CDN for the history graph. No server, nothing to
  configure.
