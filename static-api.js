'use strict';

/* GitHub Pages adapter: mirrors the prototype API in this browser only. */
(function () {
  const STORAGE_KEY = 'treewatch_demo_reports_v2';
  const DEFAULT_LOCATION = { lat: 3.180368, lon: 101.517298 };

  window.TreeWatchStorageMode = 'device';

  // --- Risk helpers -------------------------------------------------------
  const nowIso = () => new Date().toISOString();
  const text = (value, max = 500) => String(value || '').trim().slice(0, max);
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const list = (value, max = 8) => Array.isArray(value) ? value.map(v => text(v, 80)).filter(Boolean).slice(0, max) : [];
  const photos = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && (item.startsWith('data:image/') || item.startsWith('assets/'))).slice(0, 3) : [];

  function distance(aLat, aLon, bLat, bLon) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
    const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  }

  function calculateRisk(payload) {
    const cues = list(payload.cues);
    const cueWeights = { 'Leaning tree': 18, 'Trunk crack': 24, 'Dead branches': 14, 'Lifted roots': 28 };
    const consequenceWeights = { Road: 88, House: 92, Parking: 72, Playground: 95, Footpath: 70, 'Open grass': 28 };
    const likelihood = Math.min(95, 18 + cues.reduce((sum, cue) => sum + (cueWeights[cue] || 8), 0));
    const consequence = consequenceWeights[text(payload.context, 40)] || 50;
    const rain = Math.max(0, number(payload.rainfall));
    const gust = Math.max(0, number(payload.gust));
    const stormFactor = Math.min(1.8, 1 + Math.min(rain, 100) / 250 + Math.min(gust, 100) / 220);
    const riskScore = Math.min(99, Math.round(Math.sqrt(likelihood * consequence) * stormFactor));
    const aiScore = Math.min(96, Math.max(42, 38 + cues.length * 10 + (cues.includes('Lifted roots') ? 12 : 0) + (cues.includes('Trunk crack') ? 8 : 0)));
    return {
      likelihood, consequence, storm_factor: Number(stormFactor.toFixed(2)), risk_score: riskScore,
      ai_score: aiScore, risk_tier: riskScore >= 78 ? 'High' : riskScore >= 55 ? 'Medium' : 'Monitor'
    };
  }

  function makeId() {
    return `TW-${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 9)}`;
  }

  function normaliseReport(payload) {
    const created = nowIso();
    const report = {
      id: makeId(), reporter_name: text(payload.reporter_name || 'Resident', 80),
      lat: number(payload.lat, DEFAULT_LOCATION.lat), lon: number(payload.lon, DEFAULT_LOCATION.lon),
      address: text(payload.address || 'Elmina, Shah Alam, Selangor', 220),
      tree_type: text(payload.tree_type || 'Tree species unconfirmed', 120), cues: list(payload.cues),
      context: text(payload.context || 'Open grass', 40), notes: text(payload.notes, 800), photos: photos(payload.photos),
      rainfall: Math.max(0, number(payload.rainfall)), gust: Math.max(0, number(payload.gust)),
      analysis_mode: 'Simulated visible-defect pre-check', status: 'Reported',
      owner: /elmina|shah alam/i.test(payload.address || '') ? 'SDP Landscape Team' : 'Township Landscape Unit',
      neighbor_count: 1, created_at: created, updated_at: created,
      events: [{ status: 'Reported', message: 'Resident report received and prioritised.', created_at: created }]
    };
    return Object.assign(report, calculateRisk(report));
  }

  // --- Seed reports and persistence --------------------------------------
  function seedReports() {
    const seeds = [
      { id: 'TW-0248', lat: 3.18070, lon: 101.51753, address: 'Persiaran Shorea, Elmina', tree_type: 'Rain tree', cues: ['Leaning tree', 'Lifted roots'], context: 'Road', status: 'Scheduled', neighbor_count: 4, notes: 'Roots lifted further after heavy rain.' },
      { id: 'TW-0314', lat: 3.18010, lon: 101.51772, address: 'Elmina parking bays', tree_type: 'Yellow flame', cues: ['Trunk crack', 'Dead branches'], context: 'Parking', status: 'Reported', neighbor_count: 3, notes: 'Large dead limb above two parking spaces.' },
      { id: 'TW-0189', lat: 3.18056, lon: 101.51689, address: 'Elmina Lakeside Path', tree_type: 'Angsana', cues: ['Dead branches'], context: 'Footpath', status: 'Inspected', neighbor_count: 2, notes: 'Handler inspection completed; monitor canopy.' },
      { id: 'TW-0291', lat: 3.17995, lon: 101.51702, address: 'Jalan Eserina, Elmina', tree_type: 'Mahogany', cues: ['Trunk crack'], context: 'Open grass', status: 'Mitigated', neighbor_count: 1, notes: 'Targeted pruning completed.' }
    ];
    return seeds.map((item, index) => {
      const created = new Date(Date.now() - (index + 1) * 86400000).toISOString();
      const events = [{ status: 'Reported', message: 'Resident report received.', created_at: created }];
      if (item.status !== 'Reported') events.push({ status: item.status, message: `Report moved to ${item.status}. Citizens notified.`, created_at: nowIso() });
      const base = {
        reporter_name: 'Demo resident', photos: ['assets/tree-whole.webp', 'assets/tree-trunk.webp', 'assets/tree-canopy.webp'],
        rainfall: 28, gust: 48, analysis_mode: 'Simulated visible-defect pre-check', owner: 'SDP Landscape Team',
        created_at: created, updated_at: nowIso(), events, ...item
      };
      return Object.assign(base, calculateRisk(base));
    });
  }

  function readReports() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) { /* Start with safe demo data if storage is unavailable. */ }
    const seeded = seedReports();
    writeReports(seeded);
    return seeded;
  }

  function writeReports(reports) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
    } catch (error) {
      /* Uploaded photos can exceed a browser's quota; retain the report with demo thumbnails. */
      const compact = reports.map(report => ({
        ...report,
        photos: (report.photos || []).map((photo, index) => photo.startsWith('data:image/') ? `assets/tree-${['whole', 'trunk', 'canopy'][index] || 'whole'}.webp` : photo)
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
    }
  }

  function stats(reports) {
    const active = reports.filter(report => report.status !== 'Mitigated');
    return {
      total: reports.length, active: active.length,
      high: active.filter(report => report.risk_tier === 'High').length,
      scheduled: reports.filter(report => report.status === 'Scheduled').length,
      inspected: reports.filter(report => ['Inspected', 'Mitigated'].includes(report.status)).length,
      residents: reports.reduce((sum, report) => sum + Number(report.neighbor_count || 0), 0),
      average_risk: reports.length ? Math.round(reports.reduce((sum, report) => sum + Number(report.risk_score || 0), 0) / reports.length) : 0
    };
  }

  // --- API-compatible request handler ------------------------------------
  window.TreeWatchStaticApi = async function (path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const body = typeof options.body === 'string' ? JSON.parse(options.body || '{}') : (options.body || {});
    const reports = readReports();

    if (method === 'GET' && path === '/api/health') {
      return { ok: true, database: false, storage: 'device', analysis: 'simulation' };
    }
    if (method === 'GET' && path === '/api/reports') {
      return { reports: [...reports].sort((a, b) => b.risk_score - a.risk_score || new Date(b.updated_at) - new Date(a.updated_at)) };
    }
    if (method === 'GET' && path === '/api/stats') return stats(reports);

    if (method === 'POST' && path === '/api/reports') {
      if (!Array.isArray(body.cues) || !body.cues.length) throw new Error('Select at least one visible warning cue.');
      if (!Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) throw new Error('A valid location is required.');
      const incoming = normaliseReport(body);
      const duplicate = reports.find(report => report.status !== 'Mitigated' && distance(report.lat, report.lon, incoming.lat, incoming.lon) <= 15);
      if (duplicate) {
        duplicate.neighbor_count = Number(duplicate.neighbor_count || 1) + 1;
        duplicate.cues = [...new Set([...(duplicate.cues || []), ...incoming.cues])];
        duplicate.notes = [duplicate.notes, incoming.notes].filter(Boolean).join(' | ').slice(0, 1200);
        duplicate.photos = incoming.photos.length ? incoming.photos : duplicate.photos;
        duplicate.rainfall = incoming.rainfall;
        duplicate.gust = incoming.gust;
        Object.assign(duplicate, calculateRisk(duplicate));
        duplicate.updated_at = nowIso();
        duplicate.events = duplicate.events || [];
        duplicate.events.push({ status: duplicate.status, message: 'Supporting resident report merged into this tree ticket.', created_at: duplicate.updated_at });
        writeReports(reports);
        return { merged: true, report: duplicate };
      }
      reports.push(incoming);
      writeReports(reports);
      return { merged: false, report: incoming };
    }

    const match = path.match(/^\/api\/reports\/([^/?#]+)$/);
    if (match) {
      const report = reports.find(item => item.id === decodeURIComponent(match[1]));
      if (!report) throw new Error('Report not found.');
      if (method === 'GET') return { report };
      if (method === 'PATCH') {
        const allowed = ['Reported', 'Scheduled', 'Inspected', 'Mitigated', 'Arborist review'];
        const status = allowed.includes(body.status) ? body.status : report.status;
        report.status = status;
        report.handler_note = text(body.handler_note || report.handler_note, 1000);
        report.schedule = text(body.schedule || report.schedule, 120);
        report.updated_at = nowIso();
        report.events = report.events || [];
        report.events.push({
          status,
          message: text(body.message || `Status changed to ${status}. All attached residents notified.`, 300),
          created_at: report.updated_at
        });
        writeReports(reports);
        return { report };
      }
    }
    throw new Error('Prototype route not found.');
  };
})();
