/* dashboard.js v3 — ADXL345 edition
   Changes from v2:
   - No Yaw (ADXL345 has no magnetometer)
   - No Temperature (ADXL345 has no temp sensor)
   - STAT now shows Accel Avg (ax_avg, ay_avg, az_avg)
   - EVENT table shows Total-G column (computed client-side)
   - SNR counter replaces Temperature counter
   - Shock classification: light / medium / heavy by total-g
*/

const socket = io();
let statCount  = 0;
let eventCount = 0;

// ── Shock classification counters ──────────────────────────
const shockCounts = { light: 0, medium: 0, heavy: 0 };

// Thresholds (total-g)
// Light:  2 – 3.5g  (minor bumps)
// Medium: 3.5 – 5.0g  (moderate impact)
// Heavy:  ≥ 7.0g    (strong shock)
const THRESH_LIGHT  = 3.5;
const THRESH_MEDIUM = 5.0;

const MAX_ROWS = 20;

function classifyShock(totalG) {
  if (totalG < THRESH_LIGHT)  return 'light';
  if (totalG < THRESH_MEDIUM) return 'medium';
  return 'heavy';
}

function fmt(val, d = 2) {
  if (val === null || val === undefined) return '--';
  return (val >= 0 ? ' ' : '') + parseFloat(val).toFixed(d);
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Shock breakdown popup ──────────────────────────────────
function buildPopup() {
  const existing = document.getElementById('shock-popup');
  if (existing) { existing.remove(); return; }

  const card = document.querySelector('.shock-card');
  const popup = document.createElement('div');
  popup.id = 'shock-popup';
  popup.innerHTML = `
    <div class="popup-title">SHOCK BREAKDOWN</div>
    <div class="popup-row popup-heavy">
      <span class="popup-dot"></span>
      <span class="popup-label">Heavy  <span class="popup-hint">(≥ ${THRESH_MEDIUM}g)</span></span>
      <span class="popup-count" id="pop-heavy">${shockCounts.heavy}</span>
    </div>
    <div class="popup-row popup-medium">
      <span class="popup-dot"></span>
      <span class="popup-label">Medium <span class="popup-hint">(${THRESH_LIGHT}–${THRESH_MEDIUM}g)</span></span>
      <span class="popup-count" id="pop-medium">${shockCounts.medium}</span>
    </div>
    <div class="popup-row popup-light">
      <span class="popup-dot"></span>
      <span class="popup-label">Light  <span class="popup-hint">(&lt; ${THRESH_LIGHT}g)</span></span>
      <span class="popup-count" id="pop-light">${shockCounts.light}</span>
    </div>
    <div class="popup-bar-wrap">
      <div class="popup-bar" id="pop-bar-heavy" style="background:var(--shock)"></div>
      <div class="popup-bar" id="pop-bar-medium" style="background:var(--warn-orange)"></div>
      <div class="popup-bar" id="pop-bar-light" style="background:var(--warn-yellow)"></div>
    </div>
    <div class="popup-peak">Peak recorded: <span id="pop-peak">--</span> g</div>
  `;
  card.appendChild(popup);
  updatePopupBars();

  // close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeHandler(e) {
      if (!popup.contains(e.target) && !card.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closeHandler);
      }
    });
  }, 10);
}

function updatePopupBars() {
  const total = shockCounts.light + shockCounts.medium + shockCounts.heavy || 1;
  const setBar = (id, count) => {
    const el = document.getElementById(id);
    if (el) el.style.width = Math.round((count / total) * 100) + '%';
  };
  setBar('pop-bar-heavy',  shockCounts.heavy);
  setBar('pop-bar-medium', shockCounts.medium);
  setBar('pop-bar-light',  shockCounts.light);

  // update counts if popup is open
  setEl('pop-heavy',  shockCounts.heavy);
  setEl('pop-medium', shockCounts.medium);
  setEl('pop-light',  shockCounts.light);
}

// Peak g tracker
let peakG = 0;

// ── Connection ─────────────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('dot').classList.add('connected');
  setEl('status-text', 'CONNECTED');

  // load history from REST API on connect
  fetch('/api/stats').then(r => r.json()).then(rows => {
    rows.reverse().forEach(r => addStatRow(r));
  });
  fetch('/api/events').then(r => r.json()).then(rows => {
    rows.reverse().forEach(r => addEventRow(r));
  });
});

socket.on('disconnect', () => {
  document.getElementById('dot').classList.remove('connected');
  setEl('status-text', 'DISCONNECTED');
});

// ── STAT packet ────────────────────────────────────────────
socket.on('stat', (d) => {
  statCount++;
  setEl('stat-count', statCount);
  setEl('last-rssi', d.rssi ?? '--');
  setEl('last-snr',  d.snr  != null ? parseFloat(d.snr).toFixed(1) + ' dB' : '--');

  // Orientation
  setEl('roll-min',  fmt(d.roll_min));
  setEl('roll-max',  fmt(d.roll_max));
  setEl('roll-avg',  fmt(d.roll_avg));
  setEl('pitch-min', fmt(d.pitch_min));
  setEl('pitch-max', fmt(d.pitch_max));
  setEl('pitch-avg', fmt(d.pitch_avg));

  // Accel averages
  setEl('ax-avg', fmt(d.ax_avg, 3));
  setEl('ay-avg', fmt(d.ay_avg, 3));
  setEl('az-avg', fmt(d.az_avg, 3));

  addStatRow(d);
});

// ── EVENT (shock) packet ───────────────────────────────────
socket.on('event', (d) => {
  eventCount++;
  setEl('event-count', eventCount);
  setEl('last-rssi', d.rssi ?? '--');

  addEventRow(d);

  // flash shock counter card
  const card = document.querySelector('.shock-card');
  card.style.background = '#2a0a10';
  setTimeout(() => card.style.background = '', 800);
});

// ── Add row to stat history table ──────────────────────────
function addStatRow(d) {
  const tbody = document.getElementById('stat-log');
  const placeholder = tbody.querySelector('td[colspan]');
  if (placeholder) placeholder.parentElement.remove();

  const rollRange  = ((d.roll_max  - d.roll_min ) || 0).toFixed(2);
  const pitchRange = ((d.pitch_max - d.pitch_min) || 0).toFixed(2);

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${d.timestamp ?? '--'}</td>
    <td>${fmt(d.roll_avg)}</td>
    <td>${fmt(d.pitch_avg)}</td>
    <td>${fmt(d.az_avg, 3)}</td>
    <td>${rollRange}°</td>
    <td>${pitchRange}°</td>
    <td>${d.sample_count ?? d.count ?? '--'}</td>
    <td>${d.snr != null ? parseFloat(d.snr).toFixed(1) + ' dB' : '--'}</td>
  `;

  tbody.insertBefore(tr, tbody.firstChild);
  trimTable(tbody, MAX_ROWS);
}

// ── Add row to shock event table ───────────────────────────
function addEventRow(d) {
  const tbody = document.getElementById('event-log');
  const placeholder = tbody.querySelector('td[colspan]');
  if (placeholder) placeholder.parentElement.remove();

  // Compute total-g magnitude client-side
  const totalG = (d.acc_x != null && d.acc_y != null && d.acc_z != null)
    ? Math.sqrt(d.acc_x**2 + d.acc_y**2 + d.acc_z**2)
    : null;

  const totalGDisplay = totalG !== null ? totalG.toFixed(3) : '--';

  // Classify
  let level = 'heavy';
  if (totalG !== null) {
    level = classifyShock(totalG);
    shockCounts[level]++;

    if (totalG > peakG) {
      peakG = totalG;
      setEl('pop-peak', totalG.toFixed(3));
    }

    updatePopupBars();
  }

  const tr = document.createElement('tr');
  tr.classList.add('shock-row', `shock-${level}`);

  // badge
  const badge = `<span class="shock-badge shock-badge-${level}">${level.toUpperCase()}</span>`;

  tr.innerHTML = `
    <td>${d.timestamp ?? '--'}</td>
    <td>${fmt(d.acc_x, 3)}</td>
    <td>${fmt(d.acc_y, 3)}</td>
    <td>${fmt(d.acc_z, 3)}</td>
    <td class="total-g-cell">${totalGDisplay} ${badge}</td>
    <td>${fmt(d.roll)}</td>
    <td>${fmt(d.pitch)}</td>
    <td>${d.rssi ?? '--'}</td>
  `;

  tbody.insertBefore(tr, tbody.firstChild);
  trimTable(tbody, MAX_ROWS);
}

// ── Trim table to max rows ─────────────────────────────────
function trimTable(tbody, max) {
  while (tbody.rows.length > max) {
    tbody.deleteRow(tbody.rows.length - 1);
  }
}

// ── Wire up shock card click ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const shockCard = document.querySelector('.shock-card');
  if (shockCard) {
    shockCard.style.cursor = 'pointer';
    shockCard.addEventListener('click', buildPopup);
  }
});