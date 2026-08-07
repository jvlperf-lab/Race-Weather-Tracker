// ============================================================
// DA/RAW — averages weather data across NWS + several forecast
// models, derives density altitude / air density ratio / SAE
// correction factor / vapor pressure, tracks wind relative to
// a starting-line heading, records a rolling 24h history, and
// pulls a 15-minute-step short-range forecast.
// No API keys required. All sources are free/public.
// ============================================================

const OPEN_METEO_MODELS = [
  { id: 'best_match', label: 'Open-Meteo · Best Match' },
  { id: 'gfs_seamless', label: 'NOAA GFS' },
  { id: 'icon_seamless', label: 'DWD ICON' },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS' },
  { id: 'gem_seamless', label: 'ECCC GEM' },
  { id: 'ukmo_seamless', label: 'UK Met Office' },
  { id: 'meteofrance_seamless', label: 'Météo-France' },
  { id: 'jma_seamless', label: 'JMA (Japan)' },
];

const CURRENT_VARS = 'temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,wind_direction_10m';
const HISTORY_PREFIX = 'da_raw_history_';
const HEADING_PREFIX = 'da_raw_heading_';
const SAVED_KEY = 'da_raw_saved_tracks';
const RECORD_INTERVAL_MS = 5 * 60 * 1000;
const RECORD_MIN_GAP_MS = 4 * 60 * 1000;

const METRIC_CONFIG = {
  da: { label: 'Density Altitude (ft)', get: (p) => p.da },
  ratio: { label: 'Air Density Ratio (%)', get: (p) => (p.ratio != null ? p.ratio * 100 : null) },
  tempF: { label: 'Temp (°F)', get: (p) => (p.tempC != null ? c2f(p.tempC) : null) },
  baro: { label: 'Baro (inHg)', get: (p) => (p.pressureHpa != null ? hpa2inHg(p.pressureHpa) : null) },
  rh: { label: 'Humidity (%)', get: (p) => p.rh },
  vapor: { label: 'Vapor Pressure (inHg)', get: (p) => (p.vaporHpa != null ? hpa2inHg(p.vaporHpa) : null) },
};

const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

// ------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const searchInput = $('searchInput');
const searchBtn = $('searchBtn');
const searchResults = $('searchResults');
const geoBtn = $('geoBtn');
const savedPillsEl = $('savedPills');
const bulbsEl = $('bulbs');
const statusCount = $('statusCount');
const statusTime = $('statusTime');
const refreshBtn = $('refreshBtn');
const saveBtn = $('saveBtn');
const emptyState = $('emptyState');
const readout = $('readout');
const locationName = $('locationName');
const locationMeta = $('locationMeta');
const daValue = $('daValue');
const daNote = $('daNote');
const densityRatioEl = $('densityRatio');
const correctionFactorEl = $('correctionFactor');
const vaporPressureEl = $('vaporPressure');
const baroValueEl = $('baroValue');
const humidityValueEl = $('humidityValue');
const pressureAltEl = $('pressureAlt');
const avgGrid = $('avgGrid');
const avgSourceCount = $('avgSourceCount');
const sourcesGrid = $('sourcesGrid');
const windDiagramEl = $('windDiagram');
const windGridEl = $('windGrid');
const headingInput = $('headingInput');
const headingSaveBtn = $('headingSaveBtn');
const headingPresetsEl = $('headingPresets');
const historyMetricEl = $('historyMetric');
const forecastBody = $('forecastBody');

let currentLocation = null; // { name, admin, country, lat, lon, elevationM, heading }
let lastAveraged = null;
let lastBackfill = [];
let autoRefreshTimer = null;
let historyChartInstance = null;

// ------------------------------------------------------------
// Unit helpers
// ------------------------------------------------------------
const c2f = (c) => (c * 9) / 5 + 32;
const hpa2inHg = (h) => h * 0.0295299831;
const kmh2mph = (k) => k * 0.621371;
const m2ft = (m) => m * 3.28084;

function fmt(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function locKey(loc) {
  return `${loc.lat.toFixed(3)}_${loc.lon.toFixed(3)}`;
}

function compassLabel(deg) {
  if (deg === null || deg === undefined) return '';
  const idx = Math.round(deg / 22.5) % 16;
  return COMPASS_16[idx];
}

// ------------------------------------------------------------
// Density altitude / air density / correction factor math
// ------------------------------------------------------------

// Pressure altitude from actual station pressure (hPa), standard atmosphere.
function pressureAltitudeFt(stationHpa) {
  if (stationHpa === null || stationHpa === undefined) return null;
  return 145366.45 * (1 - Math.pow(stationHpa / 1013.25, 0.190284));
}

// FAA-style density altitude approximation: PA + 120 * (OAT - ISA temp at PA)
function densityAltitudeFt(stationHpa, tempC) {
  const pa = pressureAltitudeFt(stationHpa);
  if (pa === null || tempC === null || tempC === undefined) return null;
  const isaTempC = 15 - 1.98 * (pa / 1000);
  return pa + 120 * (tempC - isaTempC);
}

// Saturation vapor pressure (Buck equation, hPa) and actual vapor pressure from RH.
function vaporPressureHpa(tempC, rh) {
  if (tempC === null || tempC === undefined || rh === null || rh === undefined) return null;
  const es = 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
  return es * (rh / 100);
}

// Actual (moist) air density ratio vs. standard sea-level density, via ideal gas law.
function airDensityRatio(stationHpa, tempC, rh) {
  if ([stationHpa, tempC, rh].some((v) => v === null || v === undefined)) return null;
  const tK = tempC + 273.15;
  const e = vaporPressureHpa(tempC, rh);
  const pd = stationHpa - e;
  const Rd = 287.05;
  const Rv = 461.495;
  const rho = (pd * 100) / (Rd * tK) + (e * 100) / (Rv * tK);
  const rho0 = 1.225;
  return rho / rho0;
}

// SAE J1349 correction factor: CF = (99 / Pd_kPa) * sqrt(T_K / 298)
function correctionFactorSAE(stationHpa, tempC, rh) {
  if ([stationHpa, tempC, rh].some((v) => v === null || v === undefined)) return null;
  const e = vaporPressureHpa(tempC, rh);
  const pdKpa = (stationHpa - e) / 10;
  const tK = tempC + 273.15;
  if (pdKpa <= 0) return null;
  return (99 / pdKpa) * Math.sqrt(tK / 298);
}

function circularMeanDeg(degs) {
  const vals = degs.filter((d) => d !== null && d !== undefined);
  if (!vals.length) return null;
  let sinSum = 0, cosSum = 0;
  vals.forEach((d) => {
    const r = (d * Math.PI) / 180;
    sinSum += Math.sin(r);
    cosSum += Math.cos(r);
  });
  let mean = (Math.atan2(sinSum / vals.length, cosSum / vals.length) * 180) / Math.PI;
  if (mean < 0) mean += 360;
  return mean;
}

function average(vals) {
  const v = vals.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// Headwind/tailwind/crosswind relative to a starting-line heading (direction of travel).
// windFromDeg is meteorological "coming from" convention, as reported by every source here.
function windRelative(trackHeadingDeg, windFromDeg, windSpeedMph) {
  if ([trackHeadingDeg, windFromDeg, windSpeedMph].some((v) => v === null || v === undefined)) return null;
  const blowingToward = (windFromDeg + 180) % 360;
  let rel = blowingToward - trackHeadingDeg;
  rel = ((rel + 180) % 360 + 360) % 360 - 180; // normalize to [-180, 180]
  const rad = (rel * Math.PI) / 180;
  return {
    rel,
    headTail: windSpeedMph * Math.cos(rad), // positive = tailwind, negative = headwind
    cross: windSpeedMph * Math.sin(rad), // positive = pushing right of travel direction
  };
}

// ------------------------------------------------------------
// Fetchers — current conditions (never reject; ok:false on failure)
// ------------------------------------------------------------

async function fetchNWS(lat, lon) {
  const base = { id: 'nws', label: 'NWS station obs', ok: false };
  try {
    const pointRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (!pointRes.ok) throw new Error('outside NWS coverage (US only)');
    const point = await pointRes.json();
    const stationsRes = await fetch(point.properties.observationStations);
    if (!stationsRes.ok) throw new Error('no stations found');
    const stations = await stationsRes.json();
    const stationId = stations.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) throw new Error('no nearby station');
    const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`);
    if (!obsRes.ok) throw new Error('station has no recent observation');
    const obs = await obsRes.json();
    const p = obs.properties;
    return {
      id: 'nws',
      label: `NWS · ${stationId}`,
      ok: true,
      tempC: p.temperature?.value ?? null,
      rh: p.relativeHumidity?.value ?? null,
      dewC: p.dewpoint?.value ?? null,
      pressureHpa: p.barometricPressure?.value != null ? p.barometricPressure.value / 100 : null,
      windKmh: p.windSpeed?.value ?? null,
      windDeg: p.windDirection?.value ?? null,
      time: p.timestamp ?? null,
    };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

async function fetchOpenMeteoModel(lat, lon, model) {
  const base = { id: model.id, label: model.label, ok: false };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${CURRENT_VARS}&models=${model.id}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('model unavailable for this location');
    const data = await res.json();
    const c = data.current;
    if (!c) throw new Error('no current data returned');
    return {
      id: model.id,
      label: model.label,
      ok: true,
      tempC: c.temperature_2m ?? null,
      rh: c.relative_humidity_2m ?? null,
      dewC: c.dew_point_2m ?? null,
      pressureHpa: c.surface_pressure ?? null,
      windKmh: c.wind_speed_10m ?? null,
      windDeg: c.wind_direction_10m ?? null,
      time: c.time ?? null,
    };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

// Hourly backfill for the last 24h (seamless recent-history via past_days).
async function fetchBackfillHourly(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure&past_days=1&forecast_days=1&models=best_match`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('backfill unavailable');
    const data = await res.json();
    const h = data.hourly;
    if (!h || !h.time) throw new Error('no hourly data');
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const points = [];
    for (let i = 0; i < h.time.length; i++) {
      const t = new Date(h.time[i]).getTime();
      if (t < cutoff || t > now) continue;
      const tempC = h.temperature_2m?.[i] ?? null;
      const rh = h.relative_humidity_2m?.[i] ?? null;
      const pressureHpa = h.surface_pressure?.[i] ?? null;
      points.push({
        t: h.time[i],
        tempC, rh, pressureHpa,
        da: densityAltitudeFt(pressureHpa, tempC),
        ratio: airDensityRatio(pressureHpa, tempC, rh),
        vaporHpa: vaporPressureHpa(tempC, rh),
      });
    }
    return points;
  } catch (e) {
    return [];
  }
}

// 15-minute-step short-range forecast (single model — best match — for the next ~2h).
async function fetchForecast15(lat, lon) {
  try {
    const vars = 'temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,wind_direction_10m';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&minutely_15=${vars}&models=best_match`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('forecast unavailable');
    const data = await res.json();
    const m = data.minutely_15;
    if (!m || !m.time) throw new Error('no minutely data');
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < m.time.length && rows.length < 8; i++) {
      const t = new Date(m.time[i]).getTime();
      if (t < now - 10 * 60 * 1000) continue; // skip anything already in the past
      const tempC = m.temperature_2m?.[i] ?? null;
      const rh = m.relative_humidity_2m?.[i] ?? null;
      const pressureHpa = m.surface_pressure?.[i] ?? null;
      const windKmh = m.wind_speed_10m?.[i] ?? null;
      const windDeg = m.wind_direction_10m?.[i] ?? null;
      rows.push({
        t: m.time[i],
        tempC, rh, pressureHpa, windKmh, windDeg,
        da: densityAltitudeFt(pressureHpa, tempC),
        ratio: airDensityRatio(pressureHpa, tempC, rh),
        vaporHpa: vaporPressureHpa(tempC, rh),
      });
    }
    return rows;
  } catch (e) {
    return [];
  }
}

// ------------------------------------------------------------
// Bulbs (staging-light source status)
// ------------------------------------------------------------

function buildBulbs(count) {
  bulbsEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const b = document.createElement('span');
    b.className = 'bulb pending';
    b.id = `bulb-${i}`;
    bulbsEl.appendChild(b);
  }
}
function setBulb(i, state) {
  const b = $(`bulb-${i}`);
  if (b) b.className = `bulb ${state}`;
}

// ------------------------------------------------------------
// History storage (localStorage, per rounded lat/lon)
// ------------------------------------------------------------

function getRecordedHistory(loc) {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_PREFIX + locKey(loc))) || [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return arr.filter((p) => new Date(p.t).getTime() >= cutoff);
  } catch {
    return [];
  }
}

function maybeRecordHistory(loc, avg) {
  const key = HISTORY_PREFIX + locKey(loc);
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(key)) || []; } catch { arr = []; }
  const now = Date.now();
  const last = arr[arr.length - 1];
  if (last && now - new Date(last.t).getTime() < RECORD_MIN_GAP_MS) return;
  arr.push({
    t: new Date(now).toISOString(),
    tempC: avg.tempC, rh: avg.rh, pressureHpa: avg.pressureHpa,
    da: avg.da, ratio: avg.ratio, vaporHpa: avg.vaporHpa,
  });
  const cutoff = now - 24 * 60 * 60 * 1000;
  arr = arr.filter((p) => new Date(p.t).getTime() >= cutoff);
  localStorage.setItem(key, JSON.stringify(arr));
}

// ------------------------------------------------------------
// Heading storage
// ------------------------------------------------------------

function getHeading(loc) {
  const stored = localStorage.getItem(HEADING_PREFIX + locKey(loc));
  if (stored !== null && stored !== '') return Number(stored);
  return loc.heading ?? null;
}
function setHeading(loc, deg) {
  localStorage.setItem(HEADING_PREFIX + locKey(loc), String(deg));
  loc.heading = deg;
}

// ------------------------------------------------------------
// Main load flow
// ------------------------------------------------------------

async function loadLocation(loc) {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  currentLocation = loc;
  currentLocation.heading = getHeading(loc);

  emptyState.classList.add('hidden');
  readout.classList.remove('hidden');
  refreshBtn.disabled = false;
  saveBtn.disabled = false;
  headingInput.value = currentLocation.heading ?? '';

  locationName.textContent = loc.name;
  const metaParts = [];
  if (loc.admin) metaParts.push(loc.admin);
  if (loc.country) metaParts.push(loc.country);
  if (loc.elevationM !== null && loc.elevationM !== undefined) {
    metaParts.push(`elev ${Math.round(m2ft(loc.elevationM)).toLocaleString()} ft`);
  }
  metaParts.push(`${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`);
  locationMeta.textContent = metaParts.join(' · ');

  const jobs = [fetchNWS(loc.lat, loc.lon), ...OPEN_METEO_MODELS.map((m) => fetchOpenMeteoModel(loc.lat, loc.lon, m))];
  buildBulbs(jobs.length);
  statusCount.textContent = 'Loading sources…';
  statusTime.textContent = '—';
  forecastBody.innerHTML = `<tr><td colspan="8" class="source-card-error">Loading…</td></tr>`;

  const results = new Array(jobs.length);
  const currentPromise = Promise.all(
    jobs.map((p, i) => p.then((res) => { results[i] = res; setBulb(i, res.ok ? 'ok' : 'fail'); }))
  );

  const [, backfill, forecast] = await Promise.all([
    currentPromise,
    fetchBackfillHourly(loc.lat, loc.lon),
    fetchForecast15(loc.lat, loc.lon),
  ]);

  lastBackfill = backfill;
  renderResults(results);
  renderForecastTable(forecast);
  renderHistoryChart();

  autoRefreshTimer = setInterval(() => loadLocation(currentLocation), RECORD_INTERVAL_MS);
}

function renderResults(results) {
  const okResults = results.filter((r) => r.ok);
  statusCount.textContent = `${okResults.length} of ${results.length} sources reporting`;
  statusTime.textContent = `updated ${new Date().toLocaleTimeString()}`;

  const avgTempC = average(okResults.map((r) => r.tempC));
  const avgRh = average(okResults.map((r) => r.rh));
  const avgDewC = average(okResults.map((r) => r.dewC));
  const avgPressureHpa = average(okResults.map((r) => r.pressureHpa));
  const avgWindKmh = average(okResults.map((r) => r.windKmh));
  const avgWindDeg = circularMeanDeg(okResults.map((r) => r.windDeg));

  const da = densityAltitudeFt(avgPressureHpa, avgTempC);
  const pa = pressureAltitudeFt(avgPressureHpa);
  const ratio = airDensityRatio(avgPressureHpa, avgTempC, avgRh);
  const cf = correctionFactorSAE(avgPressureHpa, avgTempC, avgRh);
  const vaporHpa = vaporPressureHpa(avgTempC, avgRh);

  lastAveraged = {
    tempC: avgTempC, rh: avgRh, dewC: avgDewC, pressureHpa: avgPressureHpa,
    windKmh: avgWindKmh, windDeg: avgWindDeg, da, pa, ratio, cf, vaporHpa,
    sourceCount: okResults.length,
  };

  // ---- key metrics ----
  daValue.textContent = da !== null ? Math.round(da).toLocaleString() : '—';
  daNote.textContent = da !== null
    ? `From averaged station pressure and temperature across ${okResults.length} source${okResults.length === 1 ? '' : 's'}.`
    : 'Not enough source data to compute a reading.';
  densityRatioEl.textContent = ratio !== null ? `${fmt(ratio * 100, 1)}%` : '—';
  correctionFactorEl.textContent = cf !== null ? fmt(cf, 3) : '—';
  vaporPressureEl.textContent = vaporHpa !== null ? `${fmt(hpa2inHg(vaporHpa), 3)} inHg` : '—';
  baroValueEl.textContent = avgPressureHpa !== null ? `${fmt(hpa2inHg(avgPressureHpa), 2)} inHg` : '—';
  humidityValueEl.textContent = avgRh !== null ? `${fmt(avgRh, 0)}%` : '—';
  pressureAltEl.textContent = pa !== null ? `${Math.round(pa).toLocaleString()} ft` : '—';

  // ---- averaged conditions row ----
  avgSourceCount.textContent = `· averaged across ${okResults.length} source${okResults.length === 1 ? '' : 's'}`;
  avgGrid.innerHTML = '';
  const avgItems = [
    ['Temp', avgTempC !== null ? `${fmt(c2f(avgTempC))}°F` : '—'],
    ['Dewpoint', avgDewC !== null ? `${fmt(c2f(avgDewC))}°F` : '—'],
    ['Humidity', avgRh !== null ? `${fmt(avgRh, 0)}%` : '—'],
    ['Pressure', avgPressureHpa !== null ? `${fmt(hpa2inHg(avgPressureHpa), 2)} inHg` : '—'],
    ['Wind', avgWindKmh !== null ? `${fmt(kmh2mph(avgWindKmh), 0)} mph${avgWindDeg !== null ? ' @ ' + Math.round(avgWindDeg) + '°' : ''}` : '—'],
  ];
  avgItems.forEach(([label, value]) => {
    const div = document.createElement('div');
    div.innerHTML = `<span class="avg-item-label">${label}</span><span class="avg-item-value">${value}</span>`;
    avgGrid.appendChild(div);
  });

  // ---- source cards ----
  sourcesGrid.innerHTML = '';
  results.forEach((r) => {
    const card = document.createElement('div');
    card.className = `source-card ${r.ok ? '' : 'fail'}`;
    if (!r.ok) {
      card.innerHTML = `
        <div class="source-card-header">
          <span class="source-card-name">${r.label}</span>
          <span class="source-card-dot fail"></span>
        </div>
        <div class="source-card-error">${r.error || 'unavailable'}</div>`;
      sourcesGrid.appendChild(card);
      return;
    }
    const rows = [
      ['Temp', `${fmt(c2f(r.tempC))}°F`],
      ['Dewpoint', r.dewC !== null ? `${fmt(c2f(r.dewC))}°F` : '—'],
      ['Humidity', r.rh !== null ? `${fmt(r.rh, 0)}%` : '—'],
      ['Pressure', r.pressureHpa !== null ? `${fmt(hpa2inHg(r.pressureHpa), 2)} inHg` : '—'],
      ['Wind', r.windKmh !== null ? `${fmt(kmh2mph(r.windKmh), 0)} mph${r.windDeg !== null ? ' @ ' + Math.round(r.windDeg) + '°' : ''}` : '—'],
    ];
    card.innerHTML = `
      <div class="source-card-header">
        <span class="source-card-name">${r.label}</span>
        <span class="source-card-dot ok"></span>
      </div>
      <div class="source-card-rows">
        ${rows.map(([l, v]) => `<div class="source-card-row"><span class="source-card-row-label">${l}</span><span class="source-card-row-value">${v}</span></div>`).join('')}
      </div>`;
    sourcesGrid.appendChild(card);
  });

  renderWindPanel();

  if (currentLocation) maybeRecordHistory(currentLocation, lastAveraged);
}

// ------------------------------------------------------------
// Wind vs. track panel
// ------------------------------------------------------------

function polar(cx, cy, r, bearingDeg) {
  const rad = ((bearingDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function buildWindDiagramSVG(trackHeading, windFromDeg, windSpeedMph) {
  const cx = 100, cy = 100, R = 78;
  let svg = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <marker id="arrAmber" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--amber)"/></marker>
    <marker id="arrBlue" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="var(--blue)"/></marker>
  </defs>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--hairline)" stroke-width="1.5"/>`;
  // compass ticks
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([label, deg]) => {
    const [tx, ty] = polar(cx, cy, R + 14, deg);
    svg += `<text x="${tx}" y="${ty}" fill="var(--text-faint)" font-size="10" font-family="JetBrains Mono, monospace" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  });

  if (windFromDeg !== null && windFromDeg !== undefined) {
    const [wx1, wy1] = polar(cx, cy, R - 6, windFromDeg);
    const [wx2, wy2] = polar(cx, cy, R - 6, (windFromDeg + 180) % 360);
    svg += `<line x1="${wx1}" y1="${wy1}" x2="${wx2}" y2="${wy2}" stroke="var(--blue)" stroke-width="2.5" stroke-dasharray="1,4" stroke-linecap="round" marker-end="url(#arrBlue)"/>`;
  }

  if (trackHeading !== null && trackHeading !== undefined) {
    const [tx1, ty1] = polar(cx, cy, R - 2, (trackHeading + 180) % 360);
    const [tx2, ty2] = polar(cx, cy, R - 2, trackHeading);
    svg += `<line x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="var(--amber)" stroke-width="4.5" stroke-linecap="round" marker-end="url(#arrAmber)"/>`;
    const [sx, sy] = polar(cx, cy, R + 22, (trackHeading + 180) % 360);
    svg += `<text x="${sx}" y="${sy}" fill="var(--amber)" font-size="10.5" font-weight="700" font-family="JetBrains Mono, monospace" text-anchor="middle" dominant-baseline="middle">START</text>`;
    const [fx, fy] = polar(cx, cy, R + 22, trackHeading);
    svg += `<text x="${fx}" y="${fy}" fill="var(--text-dim)" font-size="9.5" font-family="JetBrains Mono, monospace" text-anchor="middle" dominant-baseline="middle">FINISH</text>`;
  }

  svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--text)"/>`;
  svg += `</svg>`;
  return svg;
}

function renderWindPanel() {
  if (!lastAveraged || !currentLocation) return;
  const heading = currentLocation.heading;
  const windMph = lastAveraged.windKmh !== null ? kmh2mph(lastAveraged.windKmh) : null;
  const windDeg = lastAveraged.windDeg;

  windDiagramEl.innerHTML = buildWindDiagramSVG(heading, windDeg, windMph);

  const rel = windRelative(heading, windDeg, windMph);
  windGridEl.innerHTML = '';
  const items = [
    ['Track Heading', heading !== null && heading !== undefined ? `${Math.round(heading)}° (${compassLabel(heading)})` : 'Not set'],
    ['Wind (avg)', windMph !== null ? `${fmt(windMph, 0)} mph @ ${windDeg !== null ? Math.round(windDeg) + '°' : '—'}` : '—'],
    ['Head / Tailwind', rel ? `${fmt(Math.abs(rel.headTail), 1)} mph ${rel.headTail >= 0 ? 'tailwind' : 'headwind'}` : '—'],
    ['Crosswind', rel ? `${fmt(Math.abs(rel.cross), 1)} mph ${rel.cross >= 0 ? '(L→R)' : '(R→L)'}` : '—'],
  ];
  items.forEach(([label, value]) => {
    const div = document.createElement('div');
    div.innerHTML = `<span class="avg-item-label">${label}</span><span class="avg-item-value">${value}</span>`;
    windGridEl.appendChild(div);
  });
}

headingSaveBtn.addEventListener('click', () => {
  if (!currentLocation) return;
  const val = Number(headingInput.value);
  if (Number.isNaN(val) || val < 0 || val > 359) {
    alert('Enter a heading between 0 and 359 degrees.');
    return;
  }
  setHeading(currentLocation, val);
  renderWindPanel();
});

(function buildHeadingPresets() {
  const presets = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
  headingPresetsEl.innerHTML = presets
    .map(([label, deg]) => `<button type="button" class="heading-preset-btn" data-deg="${deg}">${label}</button>`)
    .join('');
  headingPresetsEl.querySelectorAll('.heading-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => { headingInput.value = btn.dataset.deg; });
  });
})();

// ------------------------------------------------------------
// History chart
// ------------------------------------------------------------

function renderHistoryChart() {
  if (!currentLocation || typeof Chart === 'undefined') return;
  const metricKey = historyMetricEl.value;
  const cfg = METRIC_CONFIG[metricKey];
  const recorded = getRecordedHistory(currentLocation);

  const timeMap = new Map();
  lastBackfill.forEach((p) => {
    if (!timeMap.has(p.t)) timeMap.set(p.t, {});
    timeMap.get(p.t).backfill = cfg.get(p);
  });
  recorded.forEach((p) => {
    if (!timeMap.has(p.t)) timeMap.set(p.t, {});
    timeMap.get(p.t).recorded = cfg.get(p);
  });

  const sortedKeys = Array.from(timeMap.keys()).sort((a, b) => new Date(a) - new Date(b));
  const labels = sortedKeys.map((k) => new Date(k).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const backfillData = sortedKeys.map((k) => timeMap.get(k).backfill ?? null);
  const recordedData = sortedKeys.map((k) => timeMap.get(k).recorded ?? null);

  const canvas = $('historyChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (historyChartInstance) historyChartInstance.destroy();

  if (!sortedKeys.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  historyChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Backfill (hourly)',
          data: backfillData,
          borderColor: '#565B64',
          borderDash: [4, 3],
          pointRadius: 0,
          spanGaps: true,
          tension: 0.25,
        },
        {
          label: 'Recorded (live, 5 min)',
          data: recordedData,
          borderColor: '#FFB300',
          backgroundColor: 'rgba(255,179,0,0.08)',
          pointRadius: 2,
          spanGaps: true,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: '#8A8F98', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: '#2B2F37' } },
        y: { ticks: { color: '#8A8F98' }, grid: { color: '#2B2F37' }, title: { display: true, text: cfg.label, color: '#8A8F98' } },
      },
      plugins: { legend: { labels: { color: '#ECEEF0', font: { size: 11 } } } },
    },
  });
}

historyMetricEl.addEventListener('change', renderHistoryChart);

// ------------------------------------------------------------
// Forecast table
// ------------------------------------------------------------

function renderForecastTable(rows) {
  forecastBody.innerHTML = '';
  if (!rows.length) {
    forecastBody.innerHTML = `<tr><td colspan="8" class="source-card-error">Forecast unavailable for this location.</td></tr>`;
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const time = new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const cells = [
      time,
      r.tempC !== null ? `${fmt(c2f(r.tempC), 0)}°F` : '—',
      r.pressureHpa !== null ? `${fmt(hpa2inHg(r.pressureHpa), 2)}"` : '—',
      r.rh !== null ? `${fmt(r.rh, 0)}%` : '—',
      r.vaporHpa !== null ? `${fmt(hpa2inHg(r.vaporHpa), 3)}"` : '—',
      r.da !== null ? Math.round(r.da).toLocaleString() : '—',
      r.ratio !== null ? `${fmt(r.ratio * 100, 1)}%` : '—',
      r.windKmh !== null ? `${fmt(kmh2mph(r.windKmh), 0)}mph${r.windDeg !== null ? ' @' + Math.round(r.windDeg) + '°' : ''}` : '—',
    ];
    tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
    forecastBody.appendChild(tr);
  });
}

// ------------------------------------------------------------
// Search — combined Nominatim (venues/tracks) + Open-Meteo geocoder (places)
// ------------------------------------------------------------

let searchDebounce = null;

function classifyNominatim(d) {
  const n = (d.name || d.display_name || '').toLowerCase();
  const keywords = ['raceway', 'speedway', 'dragstrip', 'drag strip', 'motorsport', 'strip', 'international speedway'];
  if (keywords.some((k) => n.includes(k))) return 'track';
  const type = (d.type || '').toLowerCase();
  if (['track', 'raceway', 'motorsport'].includes(type)) return 'track';
  return 'place';
}

async function fetchNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&addressdetails=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((d) => ({
    name: d.name || (d.display_name || '').split(',')[0],
    admin: d.address?.state || d.address?.county || null,
    country: d.address?.country || null,
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    elevationM: null,
    tag: classifyNominatim(d),
    fullLabel: d.display_name,
  }));
}

async function fetchOpenMeteoGeocode(query) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name,
    admin: r.admin1 || null,
    country: r.country || null,
    lat: r.latitude,
    lon: r.longitude,
    elevationM: r.elevation ?? null,
    tag: 'place',
    fullLabel: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

async function runSearch(query) {
  if (!query || query.trim().length < 2) {
    searchResults.classList.add('hidden');
    return;
  }
  const [nomResults, omResults] = await Promise.all([
    fetchNominatim(query).catch(() => []),
    fetchOpenMeteoGeocode(query).catch(() => []),
  ]);
  renderSearchResults([...nomResults, ...omResults].slice(0, 10));
}

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.innerHTML = `<div class="search-empty">No matches. Try a track name or nearby city.</div>`;
    searchResults.classList.remove('hidden');
    return;
  }
  results.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    const metaParts = [r.admin, r.country].filter(Boolean);
    div.innerHTML = `
      <div>
        <div class="search-result-name">${r.name}</div>
        <div class="search-result-meta">${metaParts.join(', ')}</div>
      </div>
      <span class="search-result-tag ${r.tag === 'track' ? 'track' : ''}">${r.tag === 'track' ? 'Track' : 'Place'}</span>`;
    div.addEventListener('click', () => {
      searchResults.classList.add('hidden');
      searchInput.value = r.name;
      loadLocation({ name: r.name, admin: r.admin, country: r.country, lat: r.lat, lon: r.lon, elevationM: r.elevationM, heading: null });
    });
    searchResults.appendChild(div);
  });
  searchResults.classList.remove('hidden');
}

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(e.target.value), 400);
});
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });
searchBtn.addEventListener('click', () => runSearch(searchInput.value));
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) searchResults.classList.add('hidden'); });

// ------------------------------------------------------------
// Geolocation
// ------------------------------------------------------------

geoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { alert('Geolocation is not available in this browser.'); return; }
  geoBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      geoBtn.textContent = 'Use my location';
      loadLocation({ name: 'My location', admin: null, country: null, lat: pos.coords.latitude, lon: pos.coords.longitude, elevationM: null, heading: null });
    },
    () => { geoBtn.textContent = 'Use my location'; alert('Could not get your location. Check browser permissions.'); }
  );
});

// ------------------------------------------------------------
// Saved tracks (localStorage)
// ------------------------------------------------------------

function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; }
}
function setSaved(list) { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); }

function renderSavedPills() {
  const saved = getSaved();
  savedPillsEl.innerHTML = '';
  saved.forEach((loc, i) => {
    const pill = document.createElement('div');
    pill.className = 'saved-pill';
    const label = document.createElement('span');
    label.textContent = loc.name;
    label.addEventListener('click', () => loadLocation(loc));
    const remove = document.createElement('button');
    remove.className = 'saved-pill-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${loc.name}`);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      const list = getSaved();
      list.splice(i, 1);
      setSaved(list);
      renderSavedPills();
    });
    pill.appendChild(label);
    pill.appendChild(remove);
    savedPillsEl.appendChild(pill);
  });
}

saveBtn.addEventListener('click', () => {
  if (!currentLocation) return;
  const saved = getSaved();
  const exists = saved.some((l) => Math.abs(l.lat - currentLocation.lat) < 0.001 && Math.abs(l.lon - currentLocation.lon) < 0.001);
  if (exists) return;
  saved.push(currentLocation);
  setSaved(saved);
  renderSavedPills();
});

refreshBtn.addEventListener('click', () => { if (currentLocation) loadLocation(currentLocation); });

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

renderSavedPills();
