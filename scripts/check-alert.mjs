// ============================================================
// DA/RAW — server-side alert check.
// Runs on a GitHub Actions schedule (see .github/workflows/alert-check.yml),
// completely independent of any open browser tab. Fetches the same
// sources as the website, averages them (with the same pressure
// outlier-rejection the site uses), computes density altitude and
// correction factor, and emails/texts you on threshold crossings and/or
// on a routine schedule.
// ============================================================

import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

const OPEN_METEO_MODELS = [
  { id: 'best_match' },
  { id: 'gfs_seamless' },
  { id: 'icon_seamless' },
  { id: 'ecmwf_ifs025' },
  { id: 'gem_seamless' },
  { id: 'ukmo_seamless' },
  { id: 'meteofrance_seamless' },
  { id: 'jma_seamless' },
];
const CURRENT_VARS = 'temperature_2m,relative_humidity_2m,surface_pressure';

const CONFIG_PATH = new URL('../alert-config.json', import.meta.url);
const STATE_PATH = new URL('../alert-state.json', import.meta.url);

function pressureAltitudeFt(stationHpa) {
  if (stationHpa === null || stationHpa === undefined) return null;
  return 145366.45 * (1 - Math.pow(stationHpa / 1013.25, 0.190284));
}
function densityAltitudeFt(stationHpa, tempC) {
  const pa = pressureAltitudeFt(stationHpa);
  if (pa === null || tempC === null || tempC === undefined) return null;
  const isaTempC = 15 - 1.98 * (pa / 1000);
  return pa + 120 * (tempC - isaTempC);
}
function vaporPressureHpa(tempC, rh) {
  if (tempC === null || tempC === undefined || rh === null || rh === undefined) return null;
  const es = 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
  return es * (rh / 100);
}
function airDensityRatio(stationHpa, tempC, rh) {
  if ([stationHpa, tempC, rh].some((v) => v === null || v === undefined)) return null;
  const tK = tempC + 273.15;
  const e = vaporPressureHpa(tempC, rh);
  const pd = stationHpa - e;
  const Rd = 287.05, Rv = 461.495;
  const rho = (pd * 100) / (Rd * tK) + (e * 100) / (Rv * tK);
  return rho / 1.225;
}
// Correction factor = reciprocal of air density ratio (ρ₀/ρ) — matches
// the site and most trackside racing calculators, not the SAE J1349
// dyno standard.
function correctionFactor(ratio) {
  return ratio !== null && ratio !== undefined && ratio !== 0 ? 1 / ratio : null;
}
function average(vals) {
  const v = vals.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
// Same outlier guard as the site: drop a source's pressure from the
// average if it's a clear outlier (e.g. reporting sea-level pressure).
function rejectPressureOutliers(entries) {
  const valid = entries.filter((e) => e.value !== null && e.value !== undefined);
  if (valid.length < 3) return valid;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid].value : (sorted[mid - 1].value + sorted[mid].value) / 2;
  return valid.filter((e) => Math.abs(e.value - median) <= 5); // ~0.15 inHg
}

async function fetchNWS(lat, lon) {
  try {
    const pointRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (!pointRes.ok) throw new Error('outside NWS coverage');
    const point = await pointRes.json();
    const stationsRes = await fetch(point.properties.observationStations);
    const stations = await stationsRes.json();
    const stationId = stations.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) throw new Error('no nearby station');
    const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`);
    const obs = await obsRes.json();
    const p = obs.properties;
    return {
      id: 'nws',
      ok: true,
      tempC: p.temperature?.value ?? null,
      rh: p.relativeHumidity?.value ?? null,
      pressureHpa: p.barometricPressure?.value != null ? p.barometricPressure.value / 100 : null,
    };
  } catch (e) {
    return { id: 'nws', ok: false, error: e.message };
  }
}

async function fetchOpenMeteoModel(lat, lon, model) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${CURRENT_VARS}&models=${model.id}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('model unavailable');
    const data = await res.json();
    const c = data.current;
    if (!c) throw new Error('no current data');
    return { id: model.id, ok: true, tempC: c.temperature_2m ?? null, rh: c.relative_humidity_2m ?? null, pressureHpa: c.surface_pressure ?? null };
  } catch (e) {
    return { id: model.id, ok: false, error: e.message };
  }
}

async function readJson(url, fallback) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch { return fallback; }
}

async function sendMail(env, subject, text) {
  const { EMAIL_USER, EMAIL_APP_PASSWORD, EMAIL_TO } = env;
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD || !EMAIL_TO) {
    throw new Error('Missing EMAIL_USER / EMAIL_APP_PASSWORD / EMAIL_TO secrets.');
  }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD } });
  await transporter.sendMail({ from: EMAIL_USER, to: EMAIL_TO, subject, text });
}

async function main() {
  const config = await readJson(CONFIG_PATH, null);
  if (!config) throw new Error('alert-config.json missing or invalid');
  const { trackName, lat, lon, highFt, lowFt, cooldownMinutes, updateMinutes, excludedSources } = config;
  const excluded = new Set(excludedSources || []);

  const jobs = [fetchNWS(lat, lon), ...OPEN_METEO_MODELS.map((m) => fetchOpenMeteoModel(lat, lon, m))];
  const results = await Promise.all(jobs);
  const ok = results.filter((r) => r.ok && !excluded.has(r.id));
  console.log(`Sources in average: ${ok.length}/${results.length} (${results.filter((r) => !r.ok).length} unavailable, ${excluded.size} manually excluded)`);

  const avgTempC = average(ok.map((r) => r.tempC));
  const avgRh = average(ok.map((r) => r.rh));
  const pressureKept = rejectPressureOutliers(ok.map((r) => ({ id: r.id, value: r.pressureHpa })));
  if (pressureKept.length < ok.filter((r) => r.pressureHpa !== null).length) {
    console.log('Dropped a pressure outlier from the average (likely corrected/sea-level pressure).');
  }
  const avgPressureHpa = average(pressureKept.map((e) => e.value));

  const da = densityAltitudeFt(avgPressureHpa, avgTempC);
  const ratio = airDensityRatio(avgPressureHpa, avgTempC, avgRh);
  const cf = correctionFactor(ratio);

  if (da === null) {
    console.log('Not enough source data to compute density altitude — skipping.');
    return;
  }
  console.log(`${trackName}: DA ${Math.round(da)} ft, ratio ${ratio !== null ? (ratio * 100).toFixed(1) + '%' : 'n/a'}, CF ${cf !== null ? cf.toFixed(3) : 'n/a'}`);

  const state = await readJson(STATE_PATH, { lastAlertAt: null, lastUpdateAt: null });
  let stateChanged = false;

  // Threshold alert
  let triggered = null;
  if (highFt !== null && highFt !== undefined && da > highFt) {
    triggered = `Density altitude at ${trackName} is ${Math.round(da).toLocaleString()} ft — above your ${highFt.toLocaleString()} ft threshold.`;
  } else if (lowFt !== null && lowFt !== undefined && da < lowFt) {
    triggered = `Density altitude at ${trackName} is ${Math.round(da).toLocaleString()} ft — below your ${lowFt.toLocaleString()} ft threshold.`;
  }
  if (triggered) {
    const cooldownMs = (cooldownMinutes ?? 30) * 60 * 1000;
    if (!state.lastAlertAt || Date.now() - new Date(state.lastAlertAt).getTime() >= cooldownMs) {
      await sendMail(process.env, 'DA/RAW alert', triggered);
      state.lastAlertAt = new Date().toISOString();
      stateChanged = true;
      console.log('Alert sent:', triggered);
    } else {
      console.log('Threshold crossed but within cooldown — skipping send.');
    }
  } else {
    console.log('No threshold crossed.');
  }

  // Routine weather-update text, independent of thresholds
  if (updateMinutes) {
    const updateMs = updateMinutes * 60 * 1000;
    if (!state.lastUpdateAt || Date.now() - new Date(state.lastUpdateAt).getTime() >= updateMs) {
      const summary = [
        `DA ${Math.round(da).toLocaleString()} ft`,
        ratio !== null ? `density ${(ratio * 100).toFixed(1)}%` : null,
        cf !== null ? `CF ${cf.toFixed(3)}` : null,
        avgPressureHpa !== null ? `baro ${(avgPressureHpa * 0.0295299831).toFixed(2)}"` : null,
        avgTempC !== null ? `${((avgTempC * 9) / 5 + 32).toFixed(0)}°F` : null,
        avgRh !== null ? `${avgRh.toFixed(0)}% RH` : null,
      ].filter(Boolean).join(', ');
      await sendMail(process.env, 'DA/RAW weather update', `${trackName}: ${summary}.`);
      state.lastUpdateAt = new Date().toISOString();
      stateChanged = true;
      console.log('Routine update sent.');
    } else {
      console.log('Routine update not due yet.');
    }
  }

  if (stateChanged) await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
