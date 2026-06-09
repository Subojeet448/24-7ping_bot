// ══════════════════════════════════════════════════════════════════════════════
// PingBot Service Worker — Background Ping Engine
// Browser band ho ya tab hidden ho — yeh kaam karta rahega
// ══════════════════════════════════════════════════════════════════════════════

const SW_VERSION   = 'pb-sw-v3';
const PING_API     = '/api/ping';
const ALARM_STORE  = 'pb_sw_alarms'; // IDB store name (future use)

// ── State ────────────────────────────────────────────────────────────────────
let monitors  = [];   // [{id, url, interval, paused, nextPing}]
let timers    = {};   // { id: setTimeout handle }
let pings     = 0;
let swActive  = false;

// ── Install & Activate ───────────────────────────────────────────────────────
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
  swActive = true;
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER — Main page se commands aate hain
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};

  switch (type) {

    case 'INIT':
      // Page ne apna full monitors array bheja — sync karo
      monitors = payload.monitors || [];
      pings    = payload.pings    || 0;
      monitors.forEach(m => {
        if (!m.paused) scheduleMonitor(m.id);
      });
      break;

    case 'ADD':
      addOrUpdate(payload.monitor);
      scheduleMonitor(payload.monitor.id);
      break;

    case 'UPDATE':
      addOrUpdate(payload.monitor);
      reschedule(payload.monitor.id);
      break;

    case 'DELETE':
      removeMonitor(payload.id);
      break;

    case 'PAUSE':
      setMonitorPaused(payload.id, true);
      break;

    case 'RESUME':
      setMonitorPaused(payload.id, false);
      break;

    case 'PAUSE_ALL':
      monitors.forEach(m => setMonitorPaused(m.id, true));
      break;

    case 'RESUME_ALL':
      monitors.forEach(m => setMonitorPaused(m.id, false));
      break;

    case 'CLEAR_ALL':
      Object.values(timers).forEach(t => clearTimeout(t));
      timers    = {};
      monitors  = [];
      break;

    case 'INTERVAL_CHANGE':
      changeInterval(payload.id, payload.interval);
      break;

    case 'PING_NOW':
      doPing(payload.id);
      break;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CORE PING LOGIC
// ══════════════════════════════════════════════════════════════════════════════
async function doPing(id) {
  const m = monitors.find(x => x.id === id);
  if (!m || m.paused) return;

  m.lastPing = Date.now();
  let result = {};

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(
      `${PING_API}?url=${encodeURIComponent(m.url)}&_=${Date.now()}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`SW fetch error: ${res.status}`);
    result = await res.json();

  } catch(err) {
    // Network down ya abort
    result = {
      url: m.url, ok: false, status: 'down',
      status_code: 0, ms: 0, error: err.name === 'AbortError' ? 'Timeout (15s)' : err.message
    };
  }

  // Update monitor state
  m.status    = result.ok ? 'up' : 'down';
  m.lastMs    = result.ms   ?? null;
  m.lastCode  = result.status_code ?? 0;
  m.lastError = result.error ?? null;
  m.pingCount = (m.pingCount || 0) + 1;
  if (m.status === 'down') m.downCount = (m.downCount || 0) + 1;
  m.history   = m.history || [];
  m.history.push({ ok: m.status === 'up', ms: m.lastMs, ts: Date.now() });
  if (m.history.length > 30) m.history.shift();
  pings++;

  // Broadcast result to all open tabs/windows
  broadcastToClients({
    type:    'PING_RESULT',
    monitor: { ...m },
    pings
  });

  // Schedule next ping
  scheduleMonitor(id);
}

// ── Schedule ─────────────────────────────────────────────────────────────────
function scheduleMonitor(id) {
  const m = monitors.find(x => x.id === id);
  if (!m || m.paused) return;

  clearTimeout(timers[id]);
  // Next ping ke waqt ka hisab lagao (agar already ping hua tha to remaining time)
  const elapsed = m.lastPing ? (Date.now() - m.lastPing) : m.interval;
  const delay   = Math.max(0, m.interval - elapsed);

  timers[id] = setTimeout(() => doPing(id), delay);
}

function reschedule(id) {
  clearTimeout(timers[id]);
  const m = monitors.find(x => x.id === id);
  if (m && !m.paused) scheduleMonitor(id);
}

// ── Monitor Helpers ──────────────────────────────────────────────────────────
function addOrUpdate(mon) {
  const idx = monitors.findIndex(x => x.id === mon.id);
  if (idx >= 0) monitors[idx] = { ...monitors[idx], ...mon };
  else          monitors.push({ ...mon });
}

function removeMonitor(id) {
  clearTimeout(timers[id]);
  delete timers[id];
  monitors = monitors.filter(m => m.id !== id);
}

function setMonitorPaused(id, paused) {
  const m = monitors.find(x => x.id === id);
  if (!m) return;
  m.paused = paused;
  if (paused) {
    clearTimeout(timers[id]);
  } else {
    doPing(id); // Resume pe immediate ping
  }
}

function changeInterval(id, interval) {
  const m = monitors.find(x => x.id === id);
  if (!m) return;
  m.interval = interval;
  m.lastPing = null; // Force immediate reschedule
  reschedule(id);
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
async function broadcastToClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(c => c.postMessage(data));
}
