# DA/RAW — Track Air Density Reader

A static, no-build website that pulls current weather from six independent
free sources — NWS station observations plus five Open-Meteo forecast
models (Best Match, NOAA GFS, DWD ICON, ECMWF IFS, ECCC GEM) — averages
them, and computes density altitude and air density ratio for a track or
any location.

No API keys, no backend, no signup. It's three files: `index.html`,
`style.css`, `app.js`.

## Run it locally

Any static file server works, e.g.:

```bash
cd da-tracker
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` directly by
double-clicking will also mostly work, but some browsers restrict
fetch() from `file://` pages — a local server avoids that.)

## Deploy it for real

Pick whichever is easiest for you:

**Netlify (drag and drop, fastest)**
1. Go to https://app.netlify.com/drop
2. Drag the `da-tracker` folder onto the page
3. Done — you get a live URL immediately, no account required for the drop itself (an account lets you keep/rename it)

**GitHub Pages**
1. Create a new repo and push these three files to it
2. Repo Settings → Pages → Deploy from branch → `main` / root
3. Your site is live at `https://<you>.github.io/<repo>/`

**Vercel**
1. `npm i -g vercel` (one-time)
2. From inside `da-tracker/`, run `vercel --prod`

Any of these gives you a URL you can bookmark on your phone and use
trackside.

## How the numbers work

- **Pressure altitude**: computed from each source's actual *station-level*
  pressure (not sea-level-adjusted), using the standard barometric formula:
  `PA(ft) = 145366.45 * (1 - (P_station_hPa / 1013.25)^0.190284)`
- **Density altitude**: the FAA/aviation approximation, `PA + 120 * (OAT −
  ISA temp at PA)`, using a 1.98°C/1,000 ft lapse rate. This is the same
  approximation used by most trackside DA calculators.
- **Air density ratio**: computed directly from the ideal gas law using
  actual station pressure, temperature, and relative humidity (via the
  Buck equation for saturation vapor pressure), rather than the FAA
  approximation. This is the more precise number if you want to compare
  it against your own SAE/NHRA correction-factor sheet.
- **Power correction (≈ρ/ρ₀)**: the raw density ratio, shown as a
  simplified stand-in for a true SAE J1349-style correction factor. It is
  *not* a substitute for your NHRA/SAE calculator — treat it as a sanity
  check, not the number you tune off.
- All per-metric values are simple arithmetic means across whichever
  sources returned data for that field, except wind direction, which
  uses a circular (vector) mean so a mix of e.g. 350° and 10° averages
  to 0°, not 180°.

## Notes / limitations

- NWS station data only covers the US. Outside the US that bulb will
  read red/unavailable and the average will lean on the five Open-Meteo
  models.
- Open-Meteo models occasionally lack `surface_pressure` for a given
  run; that source's card will show `—` for pressure and it's excluded
  from the pressure average only (not the whole source).
- Saved tracks are stored in your browser's `localStorage` — they're
  per-browser/per-device, not synced anywhere.
- All requests are plain client-side `fetch()` calls to public,
  CORS-enabled APIs (`api.weather.gov`, `api.open-meteo.com`,
  `geocoding-api.open-meteo.com`). There's no server component and
  nothing to configure.
