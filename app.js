/* ============================================================
   Tel Aviv Shelter Finder — app.js
   ============================================================ */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const TEL_AVIV_CENTER = [32.08, 34.78];
const NOMINATIM       = 'https://nominatim.openstreetmap.org/search';
const OSRM_ROUTE      = 'https://router.project-osrm.org/route/v1';
const OSRM_FOOT_ROUTE = 'https://routing.openstreetmap.de/routed-foot/route/v1';
const OSRM_TABLE      = 'https://router.project-osrm.org/table/v1';

const THRESHOLD = { foot: 200, bicycle: 300, car: 400 }; // metres

// ── State ──────────────────────────────────────────────────────────────────
let map, gpsDotMarker, routeLayer, walkRouteLayer, shelterLayerGroup, destLayer;
let currentMode   = 'foot';
let currentRoute  = null;   // GeoJSON coordinates array
let allShelters   = [];     // cached shelter list
let userCoords    = null;   // latest GPS fix {lat, lon}

// ── Init map ───────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { zoomControl: true }).setView(TEL_AVIV_CENTER, 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  shelterLayerGroup = L.layerGroup().addTo(map);
  destLayer         = L.layerGroup().addTo(map); // separate — never wipes shelters
}

// ── GPS dot ────────────────────────────────────────────────────────────────
function showGpsDot(lat, lon) {
  const icon = L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  if (gpsDotMarker) {
    gpsDotMarker.setLatLng([lat, lon]);
  } else {
    gpsDotMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
  }
}

// ── Geolocation helpers ────────────────────────────────────────────────────
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new Error('GPS error: ' + err.message)),
      { timeout: 10000, enableHighAccuracy: true }
    );
  });
}

// ── Geocoding ──────────────────────────────────────────────────────────────
async function geocode(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=il`;
  const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('Geocoding request failed');
  const data = await res.json();
  if (!data.length) throw new Error(`Address not found: "${address}"`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

// ── Routing ────────────────────────────────────────────────────────────────
async function getRoute(from, to, profile) {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const base   = profile === 'foot' ? `${OSRM_FOOT_ROUTE}/foot` : `${OSRM_ROUTE}/${profile === 'bicycle' ? 'cycling' : 'driving'}`;
  const url    = `${base}/${coords}?overview=full&geometries=geojson`;
  const res    = await fetch(url);
  if (!res.ok) throw new Error('Routing request failed');
  const data   = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('No route found');
  return {
    coords:   data.routes[0].geometry.coordinates,   // [[lon,lat], ...]
    duration: data.routes[0].duration,
    distance: data.routes[0].distance,
    bounds:   data.routes[0].geometry.coordinates.reduce(
      (b, [ln, lt]) => b.extend([lt, ln]),
      L.latLngBounds([from.lat, from.lon], [to.lat, to.lon])
    ),
  };
}

// ── Shelter data — loaded from shelters-data.js (embedded at build time) ──
function getAllShelters() {
  return typeof SHELTERS_DATA !== 'undefined' ? SHELTERS_DATA : [];
}

function bboxFromRoute(routeCoords, bufferDeg = 0.02) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of routeCoords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat: minLat - bufferDeg, maxLat: maxLat + bufferDeg, minLon: minLon - bufferDeg, maxLon: maxLon + bufferDeg };
}

function fetchShelters(routeCoords) {
  const all  = getAllShelters();
  const bbox = bboxFromRoute(routeCoords);
  const { minLat, maxLat, minLon, maxLon } = bbox;
  return all.filter(s =>
    s.lat >= minLat && s.lat <= maxLat && s.lon >= minLon && s.lon <= maxLon
  );
}

// ── Geometry helpers ───────────────────────────────────────────────────────
function toRad(d) { return d * Math.PI / 180; }

function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const dL = toRad(lat2 - lat1);
  const dO = toRad(lon2 - lon1);
  const a  = Math.sin(dL/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Minimum distance from point to line segment (all in degrees, returns metres)
function pointToSegmentDist(pLat, pLon, aLat, aLon, bLat, bLon) {
  const ax = aLon, ay = aLat, bx = bLon, by = bLat, px = pLon, py = pLat;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return haversine(py, px, ay, ax);
  const t = Math.max(0, Math.min(1, ((px - ax)*dx + (py - ay)*dy) / (dx*dx + dy*dy)));
  return haversine(py, px, ay + t*dy, ax + t*dx);
}

function minDistToRoute(lat, lon, routeCoords) {
  let minDist = Infinity;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [aLon, aLat] = routeCoords[i];
    const [bLon, bLat] = routeCoords[i + 1];
    const d = pointToSegmentDist(lat, lon, aLat, aLon, bLat, bLon);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ── Proximity filter ───────────────────────────────────────────────────────
function sheltersNearRoute(shelters, routeCoords, mode) {
  const threshold = THRESHOLD[mode] || 300;
  const nearby = [], far = [];
  for (const s of shelters) {
    const d = minDistToRoute(s.lat, s.lon, routeCoords);
    if (d <= threshold) {
      nearby.push({ ...s, distToRoute: Math.round(d) });
    } else {
      far.push({ ...s, distToRoute: Math.round(d) });
    }
  }
  return { nearby, far };
}

// ── Map rendering ──────────────────────────────────────────────────────────
function makeIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
    <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
    <text x="14" y="19" text-anchor="middle" font-size="13" fill="white">🛡</text>
  </svg>`;
  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -36],
  });
}

const greenIcon = makeIcon('#16a34a');
const greyIcon  = makeIcon('#64748b');
const redIcon   = makeIcon('#dc2626');

// Always draws ALL 351 shelters. Nearby ones (green) are highlighted; rest stay grey.
function renderShelters(nearbyShelters) {
  shelterLayerGroup.clearLayers();

  // Build a lookup for nearby shelters by coord key
  const nearbyMap = new Map(nearbyShelters.map(s => [`${s.lat},${s.lon}`, s]));

  for (const s of getAllShelters()) {
    const key        = `${s.lat},${s.lon}`;
    const nearbyInfo = nearbyMap.get(key);
    const isNearby   = !!nearbyInfo;
    const icon       = isNearby ? greenIcon : greyIcon;
    const opacity    = isNearby ? 1 : 0.5;

    const marker = L.marker([s.lat, s.lon], { icon, opacity });
    marker.bindPopup(
      `<div class="popup-name">${s.name || 'מקלט ציבורי'}</div>` +
      `<div class="popup-address">${s.address || ''}</div>` +
      (nearbyInfo ? `<div class="popup-dist">✅ ${nearbyInfo.distToRoute} m from route</div>` : '')
    );
    shelterLayerGroup.addLayer(marker);
  }
}

function renderRoute(routeCoords, distKm, mins, color = '#3b82f6', labelIcon = '') {
  if (routeLayer) map.removeLayer(routeLayer);
  if (walkRouteLayer) { map.removeLayer(walkRouteLayer); walkRouteLayer = null; }
  const latlngs = routeCoords.map(([lon, lat]) => [lat, lon]);
  routeLayer = L.polyline(latlngs, { color, weight: 5, opacity: 0.85 }).addTo(map);
  const label = [labelIcon, distKm ? `📏 ${distKm} km` : '', mins ? `~${mins} min` : ''].filter(Boolean).join(' · ');
  if (label) routeLayer.bindTooltip(label, { permanent: true, direction: 'center', className: 'route-dist-label' });
  return routeLayer;
}

function renderWalkRoute(routeCoords, distKm, mins) {
  if (walkRouteLayer) map.removeLayer(walkRouteLayer);
  const latlngs = routeCoords.map(([lon, lat]) => [lat, lon]);
  walkRouteLayer = L.polyline(latlngs, { color: '#16a34a', weight: 5, opacity: 0.85 }).addTo(map);
  const label = `🚶 · 📏 ${distKm} km · ~${mins} min`;
  walkRouteLayer.bindTooltip(label, { permanent: true, direction: 'center', className: 'route-dist-label' });
  return walkRouteLayer;
}

// ── Status bar helpers ─────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className   = cls;
}

function setFindBtn(disabled, text) {
  const btn = document.getElementById('find-btn');
  btn.disabled   = disabled;
  btn.textContent = text || 'Find Route & Shelters';
}

// ── Navigate to nearest shelter ────────────────────────────────────────────
async function navigateToNearestShelter() {
  const btn = document.getElementById('nearest-btn');
  btn.disabled = true;
  setStatus('Getting your location…');

  try {
    const gps = await getGPS();
    userCoords = gps;
    showGpsDot(gps.lat, gps.lon);

    // Bug fix: search ALL 351 shelters, not just the route-filtered subset.
    // The route bbox may not contain the shelter closest to the user's current position.
    const candidates = getAllShelters();
    if (!candidates.length) throw new Error('No shelter data available');

    setStatus('Finding nearest shelter…');

    // Pick the closest shelter by straight-line distance (most accurate for walking)
    const nearest = [...candidates]
      .map(s => ({ ...s, dist: haversine(gps.lat, gps.lon, s.lat, s.lon) }))
      .sort((a, b) => a.dist - b.dist)[0];

    const dest = { lat: nearest.lat, lon: nearest.lon };
    const modeLbl = { foot: 'walking', bicycle: 'biking', car: 'driving' }[currentMode] || currentMode;

    if (currentMode === 'car') {
      // Dual routes: car (blue) + walking (green)
      setStatus('Fetching car and walking routes…');
      const [carRoute, footRoute] = await Promise.all([
        getRoute(gps, dest, 'car'),
        getRoute(gps, dest, 'foot'),
      ]);
      currentRoute = carRoute.coords;
      const carKm   = (carRoute.distance / 1000).toFixed(2);
      const carMins = Math.ceil(carRoute.duration / 60);
      const walkKm  = (footRoute.distance / 1000).toFixed(2);
      const walkMins = Math.ceil(footRoute.duration / 60);

      renderRoute(carRoute.coords, carKm, carMins, '#3b82f6', '🚗');
      renderWalkRoute(footRoute.coords, walkKm, walkMins);

      destLayer.clearLayers();
      const destMarker = L.marker([nearest.lat, nearest.lon], { icon: redIcon });
      destMarker.bindPopup(
        `<div class="popup-name">🎯 ${nearest.name || 'מקלט ציבורי'}</div>` +
        `<div class="popup-address">${nearest.address || ''}</div>` +
        `<div class="popup-dist">🚗 ${carKm} km · ~${carMins} min driving</div>` +
        `<div class="popup-dist">🚶 ${walkKm} km · ~${walkMins} min walking</div>`
      ).openPopup();
      destLayer.addLayer(destMarker);

      const bounds = carRoute.bounds.extend(footRoute.bounds);
      map.fitBounds(bounds, { padding: [60, 60] });
      setStatus(`🛡️ Nearest shelter — 🚗 ${carKm} km ~${carMins} min · 🚶 ${walkKm} km ~${walkMins} min`, 'success');

    } else {
      // Use walking route for both foot and bicycle (ignores one-way streets)
      // For bicycle: use walking path but calculate time at cycling speed (~15 km/h)
      const route  = await getRoute(gps, dest, 'foot');
      currentRoute = route.coords;
      const distKm = (route.distance / 1000).toFixed(2);
      const mins   = currentMode === 'bicycle'
        ? Math.ceil(route.distance / 250)   // 15 km/h = 250 m/min
        : Math.ceil(route.duration / 60);   // walking: use OSRM time
      const modeIcon = currentMode === 'bicycle' ? '🚴' : '🚶';

      renderRoute(route.coords, distKm, mins, '#3b82f6', modeIcon);

      destLayer.clearLayers();
      const destMarker = L.marker([nearest.lat, nearest.lon], { icon: redIcon });
      destMarker.bindPopup(
        `<div class="popup-name">🎯 ${nearest.name || 'מקלט ציבורי'}</div>` +
        `<div class="popup-address">${nearest.address || ''}</div>` +
        `<div class="popup-dist">📏 ${distKm} km · ~${mins} min ${modeLbl}</div>`
      ).openPopup();
      destLayer.addLayer(destMarker);

      map.fitBounds(route.bounds, { padding: [60, 60] });
      setStatus(`🛡️ Nearest shelter: ${distKm} km away · ~${mins} min ${modeLbl}`, 'success');
    }
    document.getElementById('shelter-count').hidden = true;

  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

// ── Main "Find Route" flow ─────────────────────────────────────────────────
async function findRoute() {
  const fromVal = document.getElementById('from-input').value.trim();
  const toVal   = document.getElementById('to-input').value.trim();

  if (!fromVal) { setStatus('Please enter a start address', 'error'); return; }
  if (!toVal)   { setStatus('Please enter a destination',   'error'); return; }

  setFindBtn(true, 'Working…');
  document.getElementById('nearest-btn').hidden = true;
  document.getElementById('shelter-count').hidden = true;

  try {
    // 1. Geocode
    setStatus('Geocoding addresses…');
    const [from, to] = await Promise.all([geocode(fromVal), geocode(toVal)]);

    // 2. Route
    setStatus('Fetching route…');
    const route  = await getRoute(from, to, currentMode);
    currentRoute = route.coords;
    const distKm  = (route.distance / 1000).toFixed(2);
    const routeMins = Math.ceil(route.duration / 60);
    renderRoute(route.coords, distKm, routeMins);
    map.fitBounds(route.bounds, { padding: [60, 60] });

    // 3. Fetch shelters (sync — data is embedded)
    allShelters = fetchShelters(route.coords);

    // 4. Filter by proximity
    const { nearby, far } = sheltersNearRoute(allShelters, route.coords, currentMode);

    // 5. Render all shelters — nearby highlighted green, rest grey
    renderShelters(nearby);

    const badge = document.getElementById('shelter-count');
    badge.textContent = `🛡️ ${nearby.length} shelter${nearby.length !== 1 ? 's' : ''} along route`;
    badge.hidden = false;

    const modeLabel = { foot: 'walking', bicycle: 'biking', car: 'driving' }[currentMode] || currentMode;
    const mins      = Math.ceil(route.duration / 60);
    setStatus(`Route: ${distKm} km · ~${mins} min ${modeLabel} · ${nearby.length} shelters nearby`, 'success');

    // Show emergency button
    document.getElementById('nearest-btn').hidden = false;

  } catch (e) {
    setStatus('Error: ' + e.message, 'error');
    console.error(e);
  } finally {
    setFindBtn(false);
  }
}

// ── Panel collapse (mobile) ────────────────────────────────────────────────
function setupPanelToggle() {
  const toggleBtn = document.getElementById('panel-toggle');
  const body      = document.getElementById('panel-body');

  // Measure natural height first
  const naturalH  = body.scrollHeight;
  body.style.maxHeight = naturalH + 'px';
  body.style.opacity   = '1';

  toggleBtn.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    if (collapsed) {
      body.style.maxHeight = '0';
    } else {
      body.style.maxHeight = body.scrollHeight + 'px';
    }
    toggleBtn.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? '▼' : '▲';
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupPanelToggle();

  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      currentMode = btn.dataset.mode;
    });
  });

  // GPS button
  document.getElementById('gps-btn').addEventListener('click', async () => {
    const btn = document.getElementById('gps-btn');
    btn.classList.add('loading');
    setStatus('Getting GPS location…');
    try {
      const gps = await getGPS();
      userCoords = gps;
      showGpsDot(gps.lat, gps.lon);
      // Reverse geocode for a readable label
      const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${gps.lat}&lon=${gps.lon}&format=json`);
      const data = await res.json();
      const label = data.display_name
        ? data.display_name.split(',').slice(0, 2).join(', ')
        : `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
      document.getElementById('from-input').value = label;
      map.setView([gps.lat, gps.lon], 15);
      setStatus('Location set ✓', 'success');
    } catch (e) {
      setStatus('GPS error: ' + e.message, 'error');
    } finally {
      btn.classList.remove('loading');
    }
  });

  // Find Route button
  document.getElementById('find-btn').addEventListener('click', findRoute);

  // Enter key in inputs
  ['from-input', 'to-input'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') findRoute();
    });
  });

  // Nearest shelter button
  document.getElementById('nearest-btn').addEventListener('click', navigateToNearestShelter);

  // Try to get GPS silently on load
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        showGpsDot(userCoords.lat, userCoords.lon);
      },
      () => {/* silent */},
      { timeout: 5000 }
    );
  }

  // Show all shelters immediately on load (grey — no route yet)
  renderShelters([]);
  const badge = document.getElementById('shelter-count');
  badge.textContent = `🛡️ ${getAllShelters().length} shelters in Tel Aviv`;
  badge.hidden = false;
});
