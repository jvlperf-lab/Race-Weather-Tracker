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

- **Density altitude**, **air density ratio**, **correction factor**
  (SAE J1349), **vapor pressure**, **station baro**, and **humidity**.
- **Wind vs. track**: set a starting-line heading and get headwind/
  tailwind and crosswind, plus a compass diagram marking START/FINISH.
  If you pick a track from search that OpenStreetMap has mapped as a
  line (many are), the app tries to auto-suggest a heading from that
  geometry — it's flagged as a guess and may be pointing the wrong way
  (OSM doesn't encode which end is the starting line), so verify it,
  flip it if needed, and click Set to lock it in. Once set, it's
  remembered automatically for that location.
- **Averaged conditions** and full **source breakdown**.
- **Last 24 hours**: hourly backfill (dashed) + a live line recorded
  every 5 minutes while the page is open (solid).
- **Next two hours**: 15-minute-step forecast table.
- **Track/venue search + quick picks**: search covers the whole world
  (OpenStreetMap Nominatim for venues, Open-Meteo's geocoder for
  places). "Quick picks" has one-click buttons for ten well-known US
  strips and eight international ones (UK, Sweden, Finland, Australia,
  New Zealand) — each is resolved live through the same search, not
  hardcoded coordinates, so it's never silently wrong.
- **Radar**: an embedded Windy.com panel centered on your location,
  showing recent + near-term precipitation radar.
- **Email/text alerts**: optional, off by default, set up per browser.

## Setting up alerts (optional)

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
- **Correction factor**: SAE J1349, `CF = (99 / Pd_kPa) * sqrt(T_K /
  298)`, `Pd` = dry-air pressure. A dyno-style automotive standard,
  shown for cross-reference — not an NHRA index, not a substitute for
  your own SAE/NHRA calculator.
- **Averaging**: arithmetic mean per field across whichever sources
  answered, except wind direction, which uses a circular mean.
- **Head/tailwind & crosswind**: resolved from the averaged wind vector
  against your saved starting-line heading.

## Notes / limitations

- **NWS station data is US-only**; elsewhere that source shows red and
  the average leans on the eight Open-Meteo models — which is exactly
  why "as many sources as possible" matters more outside the US.
- **True 5-minute historical data doesn't exist for free, retroactively.**
  On load you get an hourly backfill for the trailing 24h; from then
  on the page itself records a point every 5 minutes into local
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
