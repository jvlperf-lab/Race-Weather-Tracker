# DA/RAW — Track Air Density Reader

A static, no-build website that averages current weather across up to
nine independent free sources worldwide, then derives density altitude,
air density ratio, an SAE J1349 correction factor, and vapor pressure —
plus wind relative to your starting line, a rolling 24-hour history, a
15-minute-step forecast, short-range radar, and optional email/text
alerts.

No API keys required for the weather data itself, no backend, no
signup for the core reader. Four files: `index.html`, `style.css`,
`app.js`, `README.md`.

## Run it locally

```bash
cd da-tracker
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Deploy it (free, no domain purchase needed)

**Netlify (drag and drop)** — https://app.netlify.com/drop
**GitHub Pages** — upload the four files to the repo root → Settings →
Pages → Deploy from branch `main` / root.
**Vercel** — `vercel --prod` from inside `da-tracker/`.

## What's on the page

Sections run weather-first: hero numbers, averaged conditions, source
breakdown, *then* wind/track.

- **Density altitude**, **air density ratio**, **correction factor**
  (ρ₀/ρ — see below), **vapor pressure**, **station baro**, and
  **humidity**, up top.
- **Averaged conditions** and a full **source breakdown**, labeled
  generically as Station 1–9 rather than by name. Each station has an
  "include in average" checkbox — untick one and the whole page
  recomputes instantly from the same data, no refetch. A source's
  pressure is also automatically dropped from the average (just the
  average — the rest of its readings still count) if it's a clear
  outlier vs. the others, which is exactly what happens when one
  source reports corrected/sea-level pressure instead of actual
  station pressure.
- **Wind vs. track**: set a starting-line heading and get headwind/
  tailwind and crosswind, plus a compass diagram marking START/FINISH.
  If you pick a track from search that OpenStreetMap has mapped as a
  line (many are), the app tries to auto-suggest a heading from that
  geometry — it's flagged as a guess and may be pointing the wrong way
  (OSM doesn't encode which end is the starting line), so verify it,
  flip it if needed, and click Set to lock it in. Once set, it's
  remembered automatically for that location.
- **Last 24 hours**: for US locations, the dashed line is **real NWS
  station observation history** — actual archived instrument readings,
  not a model guess. Outside the US (or if a station has no history
  endpoint), it falls back to the forecast model's reconstruction of
  the last 24h, clearly labeled as such. The solid line is recorded
  live, every 5 minutes, while the page is open.
- **Next two hours**: 15-minute-step forecast table.
- **Track/venue search + quick picks**: search covers the whole world
  (OpenStreetMap Nominatim for venues, Open-Meteo's geocoder for
  places). "Quick picks" has one-click buttons for ten well-known US
  strips and eight international ones (UK, Sweden, Finland, Australia,
  New Zealand) — each is resolved live through the same search, not
  hardcoded coordinates, so it's never silently wrong.
- **Radar**: an embedded Windy.com panel centered on your location,
  showing recent + near-term precipitation radar.
- **Email/text alerts and routine updates**: optional, off by default.
  The in-page panel only runs while the tab is open; the GitHub Actions
  workflow below runs regardless.

## Always-on alerts (recommended) — runs even with the browser closed

The in-page "Email / Text Alerts" panel below only works while the site
is open in a tab, because a static site has nothing running in the
background. To get real always-on alerts, this repo also includes a
scheduled **GitHub Actions** workflow — three extra files
(`.github/workflows/alert-check.yml`, `scripts/check-alert.mjs`,
`alert-config.json`) that check the weather and email/text you on a
timer, whether your laptop is on or not. It's free (GitHub Actions is
unlimited for public repos on standard runners) and uses the GitHub
repo you already have — no new hosting account needed.

**Setup:**

1. **Edit `alert-config.json`** in your repo (click it → pencil icon)
   with your track's coordinates and thresholds:
   ```json
   {
     "trackName": "My Track",
     "lat": 39.6206,
     "lon": -75.5991,
     "highFt": 4000,
     "lowFt": 500,
     "cooldownMinutes": 30,
     "updateMinutes": 0,
     "excludedSources": []
   }
   ```
   `updateMinutes` sends a routine "here's the current weather" text on
   that interval regardless of thresholds — set to `0` to disable, or
   e.g. `60` for an update once an hour. `excludedSources` lets you
   permanently drop a misbehaving source from this server-side check
   (ids: `nws`, `best_match`, `gfs_seamless`, `icon_seamless`,
   `ecmwf_ifs025`, `gem_seamless`, `ukmo_seamless`,
   `meteofrance_seamless`, `jma_seamless`) — the site already does this
   automatically for pressure outliers, but this config only applies to
   the background script, not the browser.
2. **Create a Gmail App Password** (requires 2-Step Verification turned
   on for your Google account): go to
   https://myaccount.google.com/apppasswords, create one for "Mail",
   and copy the 16-character password it gives you.
3. **Add three repo secrets**: Settings → Secrets and variables →
   Actions → New repository secret:
   - `EMAIL_USER` — your Gmail address
   - `EMAIL_APP_PASSWORD` — the 16-character app password from step 2
   - `EMAIL_TO` — where to send it. Use your email, or a carrier
     email-to-SMS gateway for a text (see below).
4. That's it. The workflow runs automatically every 15 minutes. To
   check it's working: repo → **Actions** tab → "DA/RAW Alert Check" →
   you should see runs appearing. You can also click **Run workflow**
   there to trigger one immediately instead of waiting.

**For a text instead of an email**, set `EMAIL_TO` to your phone
number at your carrier's email-to-SMS gateway, e.g.
`5551234567@vtext.com` (Verizon), `5551234567@txt.att.net` (AT&T),
`5551234567@tmomail.net` (T-Mobile).

**How it avoids spamming you**: after sending, it writes a timestamp
to `alert-state.json` and won't send again until `cooldownMinutes` has
passed, even if the threshold is still crossed on the next run.

**Limitations**: GitHub Actions' schedule isn't to-the-second — it can
run a few minutes late during high load, and 15 minutes is close to
the practical floor for reliability (you can try `*/5 * * * *` in the
workflow file, but expect more slippage). If your Google account
doesn't support App Passwords (e.g. it's a managed Workspace account
with restrictions), swap Gmail for any other SMTP provider by editing
the `nodemailer.createTransport(...)` call in
`scripts/check-alert.mjs`.

## Setting up the in-page alert panel (optional, quick testing)

This is a static site with no server, so it can't send anything on its
own — it uses [EmailJS](https://www.emailjs.com/), a service built
exactly for triggering email from client-side JavaScript with a public
key (safe to expose; it's rate-limited and domain-restricted, not a
secret like an SMTP password).

1. Create a free EmailJS account (free tier: ~200 emails/month).
2. **Email → Add Service**, connect your Gmail/Outlook/etc. Note the
   **Service ID**.
3. **Email Templates → Create Template**. Use these three variables
   somewhere in the template: `{{to_email}}` (recipient), `{{subject}}`,
   `{{message}}`. Note the **Template ID**.
4. **Account → API Keys**. Note your **Public Key**.
5. On the site, open the "Email / Text Alerts" panel → Configure, and
   paste in the Public Key, Service ID, Template ID, and a notify
   address, plus a high and/or low density-altitude threshold. Check
   "Enable alerts," click **Save settings**, then **Send test** to
   confirm it works.

**For a text instead of an email**, put your phone number at your
carrier's email-to-SMS gateway in the "Notify address" field instead of
an email — e.g. `5551234567@vtext.com` (Verizon), `5551234567@txt.att.net`
(AT&T), `5551234567@tmomail.net` (T-Mobile), `5551234567@messaging.sprintpcs.com`
(Sprint/T-Mobile legacy). EmailJS sends it as a normal email; the
carrier turns it into a text on your phone.

**Important limitation**: alerts only fire while this page is open in a
browser tab and auto-refreshing (every 5 minutes) — there's no server
to run checks while the site is closed. There's also a 30-minute
cooldown per location so a sustained threshold breach doesn't spam you
every 5 minutes.

## How the numbers work

- **Pressure altitude**: `PA(ft) = 145366.45 * (1 - (P_station_hPa /
  1013.25)^0.190284)`, from each source's actual station-level pressure.
- **Density altitude**: `PA + 120 * (OAT − ISA temp at PA)`, 1.98°C/
  1,000 ft lapse rate — the standard trackside DA approximation.
- **Vapor pressure**: actual (not saturation) vapor pressure, Buck
  equation × relative humidity.
- **Air density ratio**: ideal gas law using actual station pressure,
  temperature, and vapor pressure.
- **Correction factor**: `CF = 1 / air density ratio` (ρ₀/ρ) — the
  convention most trackside racing calculators use. (An earlier version
  of this site used the SAE J1349 dyno-correction formula instead,
  which is a different, automotive-specific standard — that was wrong
  for this context and has been replaced. Verified against a
  known-good reference calculation: 78.4°F / 80% RH / 29.15" uncorrected
  baro gives CF ≈ 1.076 either way, within rounding.)
- **Averaging**: arithmetic mean per field across whichever sources
  answered, except wind direction (circular mean) and pressure, which
  gets outlier rejection first — any source whose pressure differs from
  the group median by more than ~0.15 inHg is dropped from the pressure
  average only (that source's temp/humidity/wind still count). This is
  what catches a source reporting corrected/sea-level pressure instead
  of station pressure. You can also manually exclude any source via the
  checkbox on its card.
- **Head/tailwind & crosswind**: resolved from the averaged wind vector
  against your saved starting-line heading.

## Notes / limitations

- **NWS station data is US-only**; elsewhere that source shows red and
  the average leans on the eight Open-Meteo models — which is exactly
  why "as many sources as possible" matters more outside the US.
- **True 5-minute historical data doesn't exist for free, retroactively,
  even from the real NWS station history** — stations report at their
  own native interval (often hourly, sometimes better). From load
  onward the page itself records a point every 5 minutes into local
  storage, so history genuinely deepens the longer you leave it open.
- **The forecast table uses a single model** (best-match), not the
  full multi-source average — running nine sources at 15-minute
  resolution would multiply requests substantially for a number
  that's a trend indicator, not a tuning input.
- **Heading auto-detection is best-effort.** It only works when
  OpenStreetMap has the track mapped as a line, and it can't know
  which end is actually the starting line — always verify it before
  trusting the wind numbers.
- **Radar embed depends on Windy.com's public widget**, a third-party
  service — if their embed policy changes, this panel may need a new
  URL format.
- **Alerts require a free EmailJS account and only run while the tab
  is open** — see above.
- **Saved tracks, headings, and alert settings live in `localStorage`**
  — per browser/device, not synced anywhere.
- Please don't hammer Nominatim — the search box already debounces
  requests. Attribution: © OpenStreetMap contributors.
