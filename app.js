// ============================================================
// DA/RAW — averages weather data across NWS + several forecast
// models and derives density altitude / air density ratio.
// No API keys required. All sources are free/public.
// ============================================================

const OPEN_METEO_MODELS = [
  { id: 'best_match', label: 'Open-Meteo · Best Match' },
  { id: 'gfs_seamless', label: 'NOAA GFS' },
  { id: 'icon_seamless', label: 'DWD ICON' },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS' },
  { id: 'gem_seamless', label: 'ECCC GEM' },
];

const CURRENT_VARS = 'temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,wind_direction_10m';
const SAVED_KEY = 'da_raw_saved_tracks';

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
const pressureAltEl = $('pressureAlt');
const avgGrid = $('avgGrid');
const avgSourceCount = $('avgSourceCount');
const sourcesGrid = $('sourcesGrid');

let currentLocation = null; // { name, admin, country, lat, lon, elevationM }

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

// ------------------------------------------------------------
// Density altitude / air density math
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

// Actual (moist) air density ratio vs. standard sea-level density, via ideal gas law.
function airDensityRatio(stationHpa, tempC, rh) {
  if ([stationHpa, tempC, rh].some((v) => v === null || v === undefined)) return null;
  const tK = tempC + 273.15;
  // Buck equation, saturation vapor pressure in hPa
  const es = 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));
  const e = es * (rh / 100);
  const pd = stationHpa - e;
  const Rd = 287.05;
  const Rv = 461.495;
  const rho = (pd * 100) / (Rd * tK) + (e * 100) / (Rv * tK);
  const rho0 = 1.225;
  return rho / rho0;
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

// ------------------------------------------------------------
// Fetchers — each resolves to a normalized source object,
// never rejects (failures are encoded as ok:false).
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
// Main load flow
// ------------------------------------------------------------

async function loadLocation(loc) {
  currentLocation = loc;
  emptyState.classList.add('hidden');
  readout.classList.remove('hidden');
  refreshBtn.disabled = false;
  saveBtn.disabled = false;

  locationName.textContent = loc.name;
  const metaParts = [];
  if (loc.admin) metaParts.push(loc.admin);
  if (loc.country) metaParts.push(loc.country);
  if (loc.elevationM !== null && loc.elevationM !== undefined) {
    metaParts.push(`elev ${Math.round(m2ft(loc.elevationM)).toLocaleString()} ft`);
  }
  metaParts.push(`${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`);
  locationMeta.textContent = metaParts.join(' · ');

  const jobs = [
    { fn: fetchNWS(loc.lat, loc.lon) },
    ...OPEN_METEO_MODELS.map((m) => ({ fn: fetchOpenMeteoModel(loc.lat, loc.lon, m) })),
  ];

  buildBulbs(jobs.length);
  statusCount.textContent = 'Loading sources…';
  statusTime.textContent = '—';

  const results = new Array(jobs.length);
  await Promise.all(
    jobs.map((job, i) =>
      job.fn.then((res) => {
        results[i] = res;
        setBulb(i, res.ok ? 'ok' : 'fail');
      })
    )
  );

  renderResults(results);
}

function renderResults(results) {
  const okResults = results.filter((r) => r.ok);
  statusCount.textContent = `${okResults.length} of ${results.length} sources reporting`;
  statusTime.textContent = `updated ${new Date().toLocaleTimeString()}`;

  // ---- averages ----
  const avgTempC = average(okResults.map((r) => r.tempC));
  const avgRh = average(okResults.map((r) => r.rh));
  const avgDewC = average(okResults.map((r) => r.dewC));
  const avgPressureHpa = average(okResults.map((r) => r.pressureHpa));
  const avgWindKmh = average(okResults.map((r) => r.windKmh));
  const avgWindDeg = circularMeanDeg(okResults.map((r) => r.windDeg));

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

  // ---- hero: density altitude / air density ratio ----
  const da = densityAltitudeFt(avgPressureHpa, avgTempC);
  const pa = pressureAltitudeFt(avgPressureHpa);
  const ratio = airDensityRatio(avgPressureHpa, avgTempC, avgRh);

  if (da !== null) {
    daValue.textContent = Math.round(da).toLocaleString();
    daNote.textContent = `From averaged station pressure and temperature across ${okResults.length} source${okResults.length === 1 ? '' : 's'}.`;
  } else {
    daValue.textContent = '—';
    daNote.textContent = 'Not enough source data to compute a reading.';
  }
  pressureAltEl.textContent = pa !== null ? `${Math.round(pa).toLocaleString()} ft` : '—';
  densityRatioEl.textContent = ratio !== null ? `${fmt(ratio * 100, 1)}%` : '—';
  correctionFactorEl.textContent = ratio !== null ? fmt(ratio, 3) : '—';

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
}

// ------------------------------------------------------------
// Geocoding search
// ------------------------------------------------------------

let searchDebounce = null;

async function runSearch(query) {
  if (!query || query.trim().length < 2) {
    searchResults.classList.add('hidden');
    return;
  }
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch (e) {
    searchResults.innerHTML = `<div class="search-empty">Search failed — check your connection.</div>`;
    searchResults.classList.remove('hidden');
  }
}

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.innerHTML = `<div class="search-empty">No matches. Try a nearby city name.</div>`;
    searchResults.classList.remove('hidden');
    return;
  }
  results.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    const metaParts = [r.admin1, r.country].filter(Boolean);
    div.innerHTML = `<div class="search-result-name">${r.name}</div><div class="search-result-meta">${metaParts.join(', ')}</div>`;
    div.addEventListener('click', () => {
      searchResults.classList.add('hidden');
      searchInput.value = r.name;
      loadLocation({
        name: r.name,
        admin: r.admin1 || null,
        country: r.country || null,
        lat: r.latitude,
        lon: r.longitude,
        elevationM: r.elevation ?? null,
      });
    });
    searchResults.appendChild(div);
  });
  searchResults.classList.remove('hidden');
}

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(e.target.value), 350);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(searchInput.value);
});
searchBtn.addEventListener('click', () => runSearch(searchInput.value));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) searchResults.classList.add('hidden');
});

// ------------------------------------------------------------
// Geolocation
// ------------------------------------------------------------

geoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Geolocation is not available in this browser.');
    return;
  }
  geoBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      geoBtn.textContent = 'Use my location';
      loadLocation({
        name: 'My location',
        admin: null,
        country: null,
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        elevationM: null,
      });
    },
    () => {
      geoBtn.textContent = 'Use my location';
      alert('Could not get your location. Check browser permissions.');
    }
  );
});

// ------------------------------------------------------------
// Saved tracks (localStorage)
// ------------------------------------------------------------

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) || [];
  } catch {
    return [];
  }
}
function setSaved(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

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
  const exists = saved.some(
    (l) => Math.abs(l.lat - currentLocation.lat) < 0.001 && Math.abs(l.lon - currentLocation.lon) < 0.001
  );
  if (exists) return;
  saved.push(currentLocation);
  setSaved(saved);
  renderSavedPills();
});

refreshBtn.addEventListener('click', () => {
  if (currentLocation) loadLocation(currentLocation);
});

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

renderSavedPills();
