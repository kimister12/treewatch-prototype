'use strict';

// Application state and utilities
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  role: 'citizen', citizenView: 'home', handlerView: 'overview',
  reports: [], stats: {}, queueFilter: 'all', reportFilter: 'all', queueSearch: '',
  location: { lat: 3.180368, lon: 101.517298, label: 'Elmina, Shah Alam, Selangor', source: 'default', accuracy: 40 },
  weather: { temperature: null, rainfall: 25, gust: 40, summary: 'Loading live conditions…' },
  scan: {
    step: 1, cues: new Set(), context: '',
    photos: ['assets/tree-whole.webp', 'assets/tree-trunk.webp', 'assets/tree-canopy.webp'],
    analysis: null
  },
  selectedReportId: null, selectedHandlerId: null,
  maps: { citizen: null, overview: null, full: null }, mapLayers: { citizen: [], overview: [], full: [] }
};

const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const riskClass = tier => tier === 'High' ? 'high' : tier === 'Medium' ? 'medium' : 'monitor';
const formatDate = value => new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const reportPhoto = report => report.photos?.[0] || 'assets/tree-whole.webp';

function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setConnection(ok) {
  const badge = $('.connection-badge');
  badge.classList.toggle('offline', !ok);
  const deviceMode = window.TreeWatchStorageMode === 'device';
  $('#connectionLabel').textContent = ok ? (deviceMode ? 'Demo saved on this device' : 'Shared system online') : 'Connection interrupted';
}

function calculatePreviewRisk() {
  const cueWeights = { 'Leaning tree': 18, 'Trunk crack': 24, 'Dead branches': 14, 'Lifted roots': 28 };
  const consequenceWeights = { Road: 88, House: 92, Parking: 72, Playground: 95, Footpath: 70, 'Open grass': 28 };
  const cues = [...state.scan.cues];
  const likelihood = Math.min(95, 18 + cues.reduce((sum, cue) => sum + (cueWeights[cue] || 8), 0));
  const consequence = consequenceWeights[state.scan.context] || 50;
  const stormFactor = Math.min(1.8, 1 + Math.min(state.weather.rainfall, 100) / 250 + Math.min(state.weather.gust, 100) / 220);
  const riskScore = Math.min(99, Math.round(Math.sqrt(likelihood * consequence) * stormFactor));
  const aiScore = Math.min(96, Math.max(42, 38 + cues.length * 10 + (cues.includes('Lifted roots') ? 12 : 0) + (cues.includes('Trunk crack') ? 8 : 0)));
  return { likelihood, consequence, storm_factor: Number(stormFactor.toFixed(2)), risk_score: riskScore, ai_score: aiScore, risk_tier: riskScore >= 78 ? 'High' : riskScore >= 55 ? 'Medium' : 'Monitor' };
}

// API and live weather/location services
async function api(path, options = {}) {
  if (window.TreeWatchStaticApi) return window.TreeWatchStaticApi(path, options);
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadData({ quiet = false } = {}) {
  try {
    const [{ reports }, stats] = await Promise.all([api('/api/reports'), api('/api/stats')]);
    state.reports = reports;
    state.stats = stats;
    setConnection(true);
    renderAll();
    $('#lastSynced').textContent = `Synced ${new Date().toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit' })}`;
    if (!quiet) showToast(window.TreeWatchStorageMode === 'device' ? 'Device demo refreshed' : 'Shared reports refreshed');
  } catch (error) {
    setConnection(false);
    if (!quiet) showToast(error.message);
  }
}

async function loadWeather(lat = state.location.lat, lon = state.location.lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,weather_code&hourly=precipitation,wind_gusts_10m&timezone=Asia%2FKuala_Lumpur&forecast_days=2`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Weather unavailable');
    const data = await response.json();
    const start = Math.max(0, data.hourly.time.findIndex(time => time >= data.current.time));
    const rain = data.hourly.precipitation.slice(start, start + 24).reduce((sum, value) => sum + Number(value || 0), 0);
    const gust = Math.max(...data.hourly.wind_gusts_10m.slice(start, start + 24).map(Number));
    state.weather = {
      temperature: Math.round(data.current.temperature_2m),
      rainfall: Math.round(rain), gust: Math.round(gust),
      summary: rain >= 20 || gust >= 50 ? 'Storm caution is elevated today' : rain >= 5 ? 'Rain is possible later today' : 'Conditions are currently stable'
    };
    $('#windSlider').value = clamp(state.weather.gust, 0, 100);
    $('#rainSlider').value = clamp(state.weather.rainfall, 0, 120);
  } catch {
    state.weather = { temperature: 29, rainfall: 25, gust: 40, summary: 'Prototype forecast shown' };
  }
  renderWeather();
  renderRanker();
  updateReview();
}

function renderWeather() {
  const weather = state.weather;
  $('#homeWeatherHeadline').textContent = weather.summary;
  $('#homeWeatherCopy').textContent = weather.rainfall >= 20 ? 'Avoid parking beneath flagged trees and keep clear of marked fall zones.' : 'Review nearby tree reports before using tree-lined parking and paths.';
  $('#homeTemp').textContent = weather.temperature == null ? '--°' : `${weather.temperature}°`;
  $('#homeRain').textContent = `${weather.rainfall} mm`;
  $('#homeGust').textContent = `${weather.gust} km/h`;
  $('#scanRain').textContent = `${weather.rainfall} mm`;
  $('#scanGust').textContent = `${weather.gust} km/h`;
  $('#mapWeatherText').textContent = `${weather.temperature ?? '--'}°C · ${weather.rainfall} mm rain · gusts ${weather.gust} km/h`;
  $('#handlerWeather').textContent = `${weather.temperature ?? '--'}°C · ${weather.rainfall} mm · ${weather.gust} km/h`;
  $('#handlerWeatherLocation').textContent = state.location.label;
}

async function searchLocation(query) {
  const endpoint = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=my&accept-language=en&q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Location search is unavailable.');
  const [result] = await response.json();
  if (!result) throw new Error('No Malaysian location matched that search.');
  const address = result.address || {};
  const parts = [address.neighbourhood || address.suburb || address.village || address.town || address.city || result.name, address.city || address.town || address.state_district, address.state].filter((item, index, list) => item && list.indexOf(item) === index);
  return { lat: Number(result.lat), lon: Number(result.lon), label: parts.slice(0, 3).join(', ') || result.display_name.split(',').slice(0, 3).join(', '), source: 'search', accuracy: 40 };
}

async function reverseGeocode(lat, lon) {
  try {
    const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    return [data.locality || data.city, data.principalSubdivision].filter(Boolean).join(', ') || 'Current GPS location';
  } catch { return 'Current GPS location'; }
}

function requestGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not support geolocation.'));
    navigator.geolocation.getCurrentPosition(async position => {
      const { latitude: lat, longitude: lon, accuracy } = position.coords;
      resolve({ lat, lon, accuracy, label: await reverseGeocode(lat, lon), source: 'gps' });
    }, () => reject(new Error('Location permission was not granted. Elmina remains selected.')), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

async function applyLocation(location, message = '') {
  state.location = location;
  $('#homeLocation').textContent = location.label;
  $('#scanAddress').textContent = location.label;
  $('#scanCoords').textContent = `${Math.abs(location.lat).toFixed(5)}° ${location.lat >= 0 ? 'N' : 'S'}, ${Math.abs(location.lon).toFixed(5)}° ${location.lon >= 0 ? 'E' : 'W'}${location.source === 'gps' ? ` · ±${Math.round(location.accuracy)}m` : ''}`;
  $('#mapLocationLabel').textContent = location.label;
  $('#handlerWeatherLocation').textContent = location.label;
  await loadWeather(location.lat, location.lon);
  recenterMaps();
  updateDuplicateNotice();
  if (message) showToast(message);
}

// Navigation and role switching
function switchRole(role) {
  state.role = role;
  $$('.role-button').forEach(button => button.classList.toggle('active', button.dataset.role === role));
  $('#citizenApp').classList.toggle('hidden', role !== 'citizen');
  $('#handlerApp').classList.toggle('hidden', role !== 'handler');
  if (role === 'handler') {
    renderHandler();
    setTimeout(() => { state.maps.overview?.invalidateSize(); state.maps.full?.invalidateSize(); }, 120);
  } else {
    setTimeout(() => state.maps.citizen?.invalidateSize(), 120);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigateCitizen(view) {
  state.citizenView = view;
  $$('.citizen-view').forEach(panel => panel.classList.toggle('active', panel.dataset.citizenView === view));
  $$('.citizen-bottom-nav button').forEach(button => button.classList.toggle('active', button.dataset.citizenNav === view));
  if (view === 'map') setTimeout(() => { initCitizenMap(); state.maps.citizen?.invalidateSize(); }, 100);
  if (view === 'reports') renderCitizenReports();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigateHandler(view) {
  state.handlerView = view;
  $$('.handler-nav button').forEach(button => button.classList.toggle('active', button.dataset.handlerView === view));
  $$('.handler-view').forEach(panel => panel.classList.toggle('active', panel.dataset.handlerViewPanel === view));
  const titles = { overview: 'Risk operations overview', queue: 'Device demo triage queue', riskmap: 'Township risk map' };
  $('#handlerPageTitle').textContent = titles[view];
  if (view === 'riskmap') setTimeout(() => { initFullMap(); state.maps.full?.invalidateSize(); }, 100);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.role-button').forEach(button => button.addEventListener('click', () => switchRole(button.dataset.role)));
$$('[data-citizen-nav]').forEach(button => button.addEventListener('click', () => navigateCitizen(button.dataset.citizenNav)));
$$('[data-handler-view]').forEach(button => button.addEventListener('click', () => navigateHandler(button.dataset.handlerView)));
$('.brand').addEventListener('click', event => { event.preventDefault(); switchRole('citizen'); navigateCitizen('home'); });

// Citizen reporting workflow
function setScanStep(step) {
  state.scan.step = clamp(step, 1, 4);
  $$('.scan-step').forEach(panel => panel.classList.toggle('active', Number(panel.dataset.scanStep) === state.scan.step));
  $$('.scan-progress button').forEach(button => {
    const value = Number(button.dataset.stepJump);
    button.classList.toggle('active', value === state.scan.step);
    button.classList.toggle('done', value < state.scan.step);
  });
  $('#scanBack').disabled = state.scan.step === 1;
  $('#scanNext').classList.toggle('hidden', state.scan.step === 4);
  $('#scanSubmit').classList.toggle('hidden', state.scan.step !== 4);
  if (state.scan.step === 4) updateReview();
  window.scrollTo({ top: 70, behavior: 'smooth' });
}

function validateStep(step) {
  if (step === 3 && !state.scan.cues.size) { showToast('Select at least one visible warning cue.'); return false; }
  if (step === 3 && !state.scan.context) { showToast('Select what is inside the estimated fall zone.'); return false; }
  return true;
}

function updateReview() {
  const analysis = calculatePreviewRisk();
  state.scan.analysis = analysis;
  $('#reviewAiScore').textContent = analysis.ai_score;
  $('#reviewTier').textContent = analysis.risk_tier === 'High' ? 'Prompt handler check recommended' : analysis.risk_tier === 'Medium' ? 'Handler review recommended' : 'Monitor and review';
  $('#reviewReason').textContent = `${[...state.scan.cues].join(' + ') || 'No cues selected'} · ${state.scan.context || 'surroundings not selected'} · live weather context.`;
  $('#reviewLikelihood').textContent = `${analysis.likelihood}/100`;
  $('#reviewConsequence').textContent = `${analysis.consequence}/100`;
  $('#reviewStorm').textContent = `${analysis.storm_factor.toFixed(2)}×`;
  const badge = $('#reviewRiskBadge');
  badge.textContent = analysis.risk_tier;
  badge.className = `risk-badge ${riskClass(analysis.risk_tier)}`;
}

function updateDuplicateNotice() {
  const match = state.reports.find(report => report.status !== 'Mitigated' && distanceMeters(report.lat, report.lon, state.location.lat, state.location.lon) <= 15);
  $('#duplicateNotice').classList.toggle('hidden', !match);
  if (match) $('#duplicateNotice p').textContent = `${match.neighbor_count} resident report${match.neighbor_count === 1 ? '' : 's'} already attached to ${match.id}. New evidence will be merged.`;
}

async function compressImage(file) {
  const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = dataUrl; });
  const scale = Math.min(1, 900 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .72);
}

$$('.photo-slot input').forEach((input, index) => input.addEventListener('change', async () => {
  const [file] = input.files;
  if (!file) return;
  try {
    const photo = await compressImage(file);
    state.scan.photos[index] = photo;
    const slot = input.closest('.photo-slot');
    $('img', slot).src = photo;
    slot.classList.add('changed');
    showToast('Photo added and compressed for upload');
  } catch { showToast('That image could not be processed.'); }
}));

$$('#cueGrid button').forEach(button => button.addEventListener('click', () => {
  const cue = button.dataset.cue;
  state.scan.cues.has(cue) ? state.scan.cues.delete(cue) : state.scan.cues.add(cue);
  button.classList.toggle('selected', state.scan.cues.has(cue));
  updateReview();
}));

$$('#contextOptions button').forEach(button => button.addEventListener('click', () => {
  state.scan.context = button.dataset.context;
  $$('#contextOptions button').forEach(item => item.classList.toggle('selected', item === button));
  updateReview();
}));

$('#scanBack').addEventListener('click', () => setScanStep(state.scan.step - 1));
$('#scanNext').addEventListener('click', () => { if (validateStep(state.scan.step)) setScanStep(state.scan.step + 1); });
$$('[data-step-jump]').forEach(button => button.addEventListener('click', () => {
  const next = Number(button.dataset.stepJump);
  if (next <= state.scan.step || (next === state.scan.step + 1 && validateStep(state.scan.step))) setScanStep(next);
}));

async function handleLocationSearch(input, button) {
  const query = input.value.trim();
  if (!query) return showToast('Type a Malaysian township, street, or postcode.');
  button.disabled = true;
  try { await applyLocation(await searchLocation(query), 'Map and weather updated for the searched location'); }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}

$('#scanLocationButton').addEventListener('click', () => handleLocationSearch($('#scanLocationInput'), $('#scanLocationButton')));
$('#mapSearchButton').addEventListener('click', () => handleLocationSearch($('#mapLocationInput'), $('#mapSearchButton')));
[$('#scanLocationInput'), $('#mapLocationInput')].forEach(input => input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); handleLocationSearch(input, input.id.startsWith('scan') ? $('#scanLocationButton') : $('#mapSearchButton')); } }));
[$('#scanGpsButton'), $('#mapGpsButton')].forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try { await applyLocation(await requestGps(), 'Device location detected'); }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}));

function resetScan() {
  state.scan = { step: 1, cues: new Set(), context: '', photos: ['assets/tree-whole.webp', 'assets/tree-trunk.webp', 'assets/tree-canopy.webp'], analysis: null };
  $$('#cueGrid button,#contextOptions button').forEach(button => button.classList.remove('selected'));
  $('#reporterName').value = ''; $('#reportNotes').value = ''; $('#treeType').selectedIndex = 0;
  $$('.photo-slot').forEach((slot, index) => { slot.classList.remove('changed'); $('img', slot).src = state.scan.photos[index]; });
  setScanStep(1);
}

$('#reportForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!validateStep(3)) return setScanStep(3);
  const submit = $('#scanSubmit');
  submit.disabled = true; submit.textContent = 'Saving report…';
  try {
    const payload = {
      reporter_name: $('#reporterName').value || 'Resident', lat: state.location.lat, lon: state.location.lon,
      address: state.location.label, tree_type: $('#treeType').value, cues: [...state.scan.cues], context: state.scan.context,
      notes: $('#reportNotes').value, photos: state.scan.photos, rainfall: state.weather.rainfall, gust: state.weather.gust
    };
    const result = await api('/api/reports', { method: 'POST', body: JSON.stringify(payload) });
    await loadData({ quiet: true });
    state.selectedReportId = result.report.id;
    $('#successTitle').textContent = result.merged ? 'Your evidence joined an existing tree ticket.' : 'Your report is now in the handler queue.';
    $('#successCopy').textContent = result.merged ? `${result.report.neighbor_count} residents are now attached to the same tree. Everyone receives future updates.` : 'Township handlers can see this report immediately on their dashboard.';
    $('#successTicket').innerHTML = `<strong>${esc(result.report.id)} · ${esc(result.report.tree_type)}</strong><br>${esc(result.report.address)} · Risk ${result.report.risk_score}`;
    $('#reportSuccessDialog').showModal();
    resetScan();
  } catch (error) { showToast(error.message); }
  finally { submit.disabled = false; submit.innerHTML = 'Save report<svg><use href="#i-arrow"></use></svg>'; }
});

$('#successDone').addEventListener('click', () => { $('#reportSuccessDialog').close(); navigateCitizen('reports'); renderCitizenReports(); });

// Citizen map, weather and report tracking
function createLeafletMap(id, zoom = 17) {
  if (!window.L) return null;
  const map = L.map(id, { zoomControl: true }).setView([state.location.lat, state.location.lon], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  return map;
}

function markerIcon(report) {
  const cls = riskClass(report.risk_tier);
  return L.divIcon({ className: '', iconSize: [38, 38], iconAnchor: [19, 36], html: `<div class="tree-marker ${cls}"><svg viewBox="0 0 24 24"><path d="M12 22v-7m0 2-3-3m3 1 3-3M7 14a4 4 0 0 1-1-7.9A6 6 0 0 1 17.8 8 3.5 3.5 0 0 1 17 15H8.5A3.5 3.5 0 0 1 7 14Z"/></svg></div>` });
}

function populateMap(map, bucket, onSelect) {
  if (!map) return;
  state.mapLayers[bucket].forEach(layer => map.removeLayer(layer));
  state.mapLayers[bucket] = [];
  state.reports.forEach(report => {
    const marker = L.marker([report.lat, report.lon], { icon: markerIcon(report) }).addTo(map);
    const color = report.risk_tier === 'High' ? '#e65b48' : report.risk_tier === 'Medium' ? '#efa83b' : '#4c9d6f';
    const zone = L.circle([report.lat, report.lon], { radius: 15, color, weight: 1.5, dashArray: '5 5', fillColor: color, fillOpacity: .13 }).addTo(map);
    marker.bindTooltip(`${esc(report.id)} · Risk ${report.risk_score}`, { direction: 'top' });
    marker.on('click', () => onSelect(report));
    state.mapLayers[bucket].push(marker, zone);
  });
}

function initCitizenMap() {
  if (!state.maps.citizen) state.maps.citizen = createLeafletMap('citizenMap', 18);
  populateMap(state.maps.citizen, 'citizen', selectCitizenMapReport);
}

function recenterMaps() {
  Object.values(state.maps).forEach(map => map?.setView([state.location.lat, state.location.lon], map === state.maps.overview ? 17 : 18));
  renderMapLayers();
}

function renderMapLayers() {
  if (state.maps.citizen) populateMap(state.maps.citizen, 'citizen', selectCitizenMapReport);
  if (state.maps.overview) populateMap(state.maps.overview, 'overview', openHandlerReport);
  if (state.maps.full) populateMap(state.maps.full, 'full', selectHandlerMapReport);
  $('#mapActiveCount').textContent = state.reports.filter(report => report.status !== 'Mitigated').length;
}

function selectCitizenMapReport(report) {
  state.selectedReportId = report.id;
  $('#selectedMapReport').classList.remove('empty');
  $('#selectedMapReport').innerHTML = `<div class="selected-report-body"><img src="${esc(reportPhoto(report))}" alt="${esc(report.tree_type)} report"><div><div class="report-top"><div><span class="eyebrow">${esc(report.id)} · ${esc(report.risk_tier)} risk</span><h3>${esc(report.tree_type)}</h3></div><span class="report-status ${esc(report.status)}">${esc(report.status)}</span></div><p>${esc(report.address)}</p><p>${report.neighbor_count} resident${report.neighbor_count === 1 ? '' : 's'} attached · ${esc(report.cues.join(', '))}</p><div class="selected-report-metrics"><span>Risk ${report.risk_score}</span><span>15m zone</span><span>${esc(report.owner)}</span></div></div></div>`;
}

function renderHome() {
  const active = state.reports.filter(report => report.status !== 'Mitigated').sort((a, b) => b.risk_score - a.risk_score);
  $('#nearbyCount').textContent = active.length;
  $('#notificationCount').textContent = state.reports.reduce((sum, report) => sum + Math.max(0, (report.events?.length || 1) - 1), 0);
  $('#homeRiskList').innerHTML = active.slice(0, 4).map(report => `<button class="home-risk-item" data-home-report="${esc(report.id)}"><i class="risk-dot ${riskClass(report.risk_tier)}"></i><span><b>${esc(report.tree_type)} · ${esc(report.id)}</b><small>${esc(report.address)} · ${esc(report.status)} · ${report.neighbor_count} resident${report.neighbor_count === 1 ? '' : 's'}</small></span><span>${report.risk_score}</span></button>`).join('') || '<p class="empty-map-copy">No active reports in this area.</p>';
  $$('[data-home-report]').forEach(button => button.addEventListener('click', () => {
    navigateCitizen('map');
    const report = state.reports.find(item => item.id === button.dataset.homeReport);
    if (report) { selectCitizenMapReport(report); setTimeout(() => state.maps.citizen?.setView([report.lat, report.lon], 19), 100); }
  }));
}

function renderCitizenReports() {
  let reports = [...state.reports].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (state.reportFilter === 'active') reports = reports.filter(report => report.status !== 'Mitigated');
  if (state.reportFilter === 'resolved') reports = reports.filter(report => report.status === 'Mitigated');
  $('#citizenReportsList').innerHTML = reports.map(report => `<button class="citizen-report-row" data-citizen-report="${esc(report.id)}"><img src="${esc(reportPhoto(report))}" alt=""><span><b>${esc(report.id)} · ${esc(report.tree_type)}</b><small>${esc(report.address)}</small><small>Updated ${formatDate(report.updated_at)} · ${report.neighbor_count} resident${report.neighbor_count === 1 ? '' : 's'}</small></span><span>${esc(report.status)}</span></button>`).join('') || '<div class="empty-map-copy"><p>No reports match this filter.</p></div>';
  $$('[data-citizen-report]').forEach(button => button.addEventListener('click', () => {
    state.selectedReportId = button.dataset.citizenReport;
    renderCitizenReportDetail();
  }));
  if (state.selectedReportId && reports.some(report => report.id === state.selectedReportId)) renderCitizenReportDetail();
}

function renderCitizenReportDetail() {
  const report = state.reports.find(item => item.id === state.selectedReportId);
  const detail = $('#citizenReportDetail');
  if (!report) return detail.classList.add('hidden');
  detail.classList.remove('hidden');
  detail.innerHTML = `<div class="report-detail-hero"><img src="${esc(reportPhoto(report))}" alt="${esc(report.tree_type)}"><span>${esc(report.status)}</span></div><div class="report-detail-content"><span class="eyebrow">Ticket ${esc(report.id)}</span><h2>${esc(report.tree_type)}</h2><p>${esc(report.address)} · Responsible owner: ${esc(report.owner)} · Risk score ${report.risk_score}</p><div class="timeline">${(report.events || []).map((event, index) => `<div class="timeline-item"><i>${index + 1}</i><span><strong>${esc(event.status)}</strong><small>${esc(event.message)} · ${formatDate(event.created_at)}</small></span></div>`).join('')}</div></div>`;
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$$('[data-report-filter]').forEach(button => button.addEventListener('click', () => {
  state.reportFilter = button.dataset.reportFilter;
  $$('[data-report-filter]').forEach(item => item.classList.toggle('active', item === button));
  renderCitizenReports();
}));

// Handler dashboard and operations
function initOverviewMap() {
  if (!state.maps.overview) state.maps.overview = createLeafletMap('handlerOverviewMap', 17);
  populateMap(state.maps.overview, 'overview', openHandlerReport);
}

function initFullMap() {
  if (!state.maps.full) state.maps.full = createLeafletMap('handlerFullMap', 18);
  populateMap(state.maps.full, 'full', selectHandlerMapReport);
}

function renderKpis() {
  $('#kpiActive').textContent = state.stats.active ?? 0;
  $('#kpiHigh').textContent = state.stats.high ?? 0;
  $('#kpiResidents').textContent = state.stats.residents ?? 0;
  $('#kpiInspected').textContent = state.stats.inspected ?? 0;
  $('#kpiRisk').textContent = state.stats.average_risk ?? 0;
  $('#queueBadge').textContent = state.stats.active ?? 0;
}

function scenarioRank(report, wind, rain) {
  const factor = .78 + (wind / 100) * .65 + (rain / 120) * .5;
  const exposureBoost = ['Road', 'House', 'Playground'].includes(report.context) ? 5 : 0;
  return Math.min(99, Math.round(report.risk_score * (.68 + factor * .30) + exposureBoost));
}

function renderRanker() {
  const wind = Number($('#windSlider').value), rain = Number($('#rainSlider').value);
  $('#windSliderValue').textContent = `${wind} km/h`;
  $('#rainSliderValue').textContent = `${rain} mm`;
  const factor = .78 + (wind / 100) * .65 + (rain / 120) * .5;
  $('#stormFactorBadge').textContent = `${factor.toFixed(2)}×`;
  const ranked = state.reports.filter(report => report.status !== 'Mitigated').map(report => ({ ...report, scenarioScore: scenarioRank(report, wind, rain) })).sort((a, b) => b.scenarioScore - a.scenarioScore);
  $('#rankedList').innerHTML = ranked.slice(0, 5).map((report, index) => `<button class="rank-row" data-handler-report="${esc(report.id)}"><span>${index + 1}</span><div><b>${esc(report.id)} · ${esc(report.tree_type)}</b><small>${esc(report.cues.join(' + '))} · ${esc(report.context)}</small></div><strong>${report.scenarioScore}</strong></button>`).join('');
  bindHandlerReportButtons($('#rankedList'));
}

function renderActivity() {
  const activity = state.reports.flatMap(report => (report.events || []).map(event => ({ ...event, report }))).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 4);
  $('#activityFeed').innerHTML = activity.map(item => `<button class="activity-item" data-handler-report="${esc(item.report.id)}"><span>${esc(item.status)}</span><b>${esc(item.report.id)} · ${esc(item.report.tree_type)}</b><small>${esc(item.message)} · ${formatDate(item.created_at)}</small></button>`).join('') || '<div class="empty-map-copy"><p>No activity recorded.</p></div>';
  bindHandlerReportButtons($('#activityFeed'));
}

function renderQueue() {
  const query = state.queueSearch.toLowerCase();
  let reports = [...state.reports].sort((a, b) => b.risk_score - a.risk_score);
  if (state.queueFilter !== 'all') reports = reports.filter(report => report.risk_tier === state.queueFilter || report.status === state.queueFilter);
  if (query) reports = reports.filter(report => [report.id, report.address, report.tree_type, report.status].some(value => String(value).toLowerCase().includes(query)));
  $('#handlerQueue').innerHTML = `<div class="queue-row header"><span>Ticket / tree</span><span>Location</span><span>Risk tier</span><span>Score</span><span>Status</span><span>Action</span></div>${reports.map(report => `<div class="queue-row"><span><b>${esc(report.id)} · ${esc(report.tree_type)}</b><small>${report.neighbor_count} resident${report.neighbor_count === 1 ? '' : 's'} · ${esc(report.cues.join(', '))}</small></span><span><b>${esc(report.address)}</b><small>${esc(report.context)} exposure</small></span><span class="queue-risk"><i style="background:${report.risk_tier === 'High' ? 'var(--danger)' : report.risk_tier === 'Medium' ? 'var(--warn)' : 'var(--safe)'}"></i>${esc(report.risk_tier)}</span><span class="queue-score">${report.risk_score}</span><span><b>${esc(report.status)}</b><small>${formatDate(report.updated_at)}</small></span><button data-handler-report="${esc(report.id)}">Review</button></div>`).join('')}`;
  bindHandlerReportButtons($('#handlerQueue'));
}

function handlerDetailHtml(report) {
  return `<div class="dialog-report-hero"><img src="${esc(reportPhoto(report))}" alt="${esc(report.tree_type)}"><div class="dialog-report-copy"><span class="eyebrow">${esc(report.id)} · ${esc(report.risk_tier)} risk</span><h2>${esc(report.tree_type)}</h2><p>${esc(report.address)} · ${report.neighbor_count} resident${report.neighbor_count === 1 ? '' : 's'} attached · Owner: ${esc(report.owner)}</p><p><strong>Visible cues:</strong> ${esc(report.cues.join(', '))}. <strong>Fall-zone context:</strong> ${esc(report.context)}. <strong>Resident note:</strong> ${esc(report.notes || 'None provided')}.</p><div class="dialog-score-grid"><div><span>Risk score</span><strong>${report.risk_score}/99</strong></div><div><span>Likelihood</span><strong>${report.likelihood}/100</strong></div><div><span>Consequence</span><strong>${report.consequence}/100</strong></div><div><span>Storm factor</span><strong>${Number(report.storm_factor).toFixed(2)}×</strong></div></div><p><strong>Analysis mode:</strong> ${esc(report.analysis_mode)}. Photographs cannot confirm internal decay.</p></div></div>`;
}

function openHandlerReport(reportOrId) {
  const report = typeof reportOrId === 'string' ? state.reports.find(item => item.id === reportOrId) : reportOrId;
  if (!report) return;
  state.selectedHandlerId = report.id;
  $('#handlerReportDetail').innerHTML = handlerDetailHtml(report);
  $('#handlerStatus').value = report.status;
  $('#handlerSchedule').value = report.schedule || '';
  $('#handlerNote').value = report.handler_note || '';
  $('#handlerReportDialog').showModal();
}

function bindHandlerReportButtons(root = document) {
  $$('[data-handler-report]', root).forEach(button => button.addEventListener('click', () => openHandlerReport(button.dataset.handlerReport)));
}

function selectHandlerMapReport(report) {
  state.selectedHandlerId = report.id;
  $('#handlerMapDetail').innerHTML = `<div class="selected-report-body"><img src="${esc(reportPhoto(report))}" alt=""><div><span class="eyebrow">${esc(report.id)} · ${esc(report.risk_tier)} risk</span><h3>${esc(report.tree_type)}</h3><p>${esc(report.address)}</p><p>${report.neighbor_count} residents · ${esc(report.status)} · Risk ${report.risk_score}</p><div class="selected-report-metrics"><span>${esc(report.context)}</span><span>${Number(report.storm_factor).toFixed(2)}× storm</span></div><button class="primary-action" data-handler-report="${esc(report.id)}">Open full report</button></div></div>`;
  bindHandlerReportButtons($('#handlerMapDetail'));
}

function renderHandler() {
  renderKpis(); renderRanker(); renderQueue(); renderActivity();
  initOverviewMap(); renderMapLayers();
  if (state.handlerView === 'riskmap') initFullMap();
}

$$('.queue-tabs button').forEach(button => button.addEventListener('click', () => {
  state.queueFilter = button.dataset.queueFilter;
  $$('.queue-tabs button').forEach(item => item.classList.toggle('active', item === button));
  renderQueue();
}));
$('#queueSearch').addEventListener('input', event => { state.queueSearch = event.target.value; renderQueue(); });
[$('#windSlider'), $('#rainSlider')].forEach(input => input.addEventListener('input', renderRanker));
$('#refreshData').addEventListener('click', () => loadData());
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));

$('#handlerActionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#handlerActionForm .primary-action');
  button.disabled = true; button.textContent = 'Saving update…';
  try {
    await api(`/api/reports/${encodeURIComponent(state.selectedHandlerId)}`, { method: 'PATCH', body: JSON.stringify({ status: $('#handlerStatus').value, schedule: $('#handlerSchedule').value, handler_note: $('#handlerNote').value }) });
    $('#handlerReportDialog').close();
    await loadData({ quiet: true });
    showToast('Status saved · all attached residents notified');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Save action & notify'; }
});

// Startup
function renderAll() {
  renderHome();
  renderCitizenReports();
  renderMapLayers();
  updateDuplicateNotice();
  if (state.role === 'handler') renderHandler();
}

window.addEventListener('error', event => {
  console.error(event.error || event.message);
  setConnection(false);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadData({ quiet: true });
});

(async function start() {
  setScanStep(1);
  $('#homeLocation').textContent = state.location.label;
  $('#scanAddress').textContent = state.location.label;
  $('#mapLocationLabel').textContent = state.location.label;
  await Promise.all([loadData({ quiet: true }), loadWeather()]);
  renderAll();
  $('#appLoader').classList.add('done');
  setInterval(() => { if (!document.hidden) loadData({ quiet: true }); }, 15000);
})().catch(error => {
  $('#appLoader').classList.add('done');
  setConnection(false);
  showToast(error.message || 'TreeWatch could not start.');
});
