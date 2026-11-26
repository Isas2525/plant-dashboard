/* Plant Observatory — Web Bluetooth client for spresense_sensor_menu / BluetoothMonitor.h
 * Device name : SPR-PERIPHERAL
 * Service     : 0x3802  (BT SIG base UUID → 00003802-0000-1000-8000-00805f9b34fb)
 * Notify char : 0x4A02  (one "key=value\n" text line per notification, 12 lines per snapshot)
 */
(function () {
  'use strict';

  const DEVICE_NAME = 'SPR-PERIPHERAL';
  const SERVICE_UUID = 0x3802;
  const CHAR_UUID = 0x4a02;
  const STALE_MS = 6000;          // a full snapshot normally arrives every ~1.2 s
  const MAX_HISTORY = 4000;       // ~1 h at 1 snapshot/s, more than the largest range
  const MAX_RECONNECTS = 3;

  const META = {
    soil_pct: { title: 'Soil moisture', unit: '%', digits: 1 },
    temp_C: { title: 'Temperature', unit: '°C', digits: 1 },
    rh_pct: { title: 'Humidity', unit: '%', digits: 1 },
    co2_ppm: { title: 'Carbon dioxide', unit: 'ppm', digits: 0 },
  };
  const MICS = ['micA_dBFS', 'micB_dBFS', 'micC_dBFS', 'micD_dBFS'];
  const EXPORT_FIELDS = ['sample', 'soil_pct', 'soil_V', 'soil_raw', 'temp_C', 'rh_pct', 'co2_ppm', ...MICS, 'audio'];

  const $ = (id) => document.getElementById(id);
  const ui = {
    clock: $('clock'), dot: $('dot'), connection: $('connection'), lastUpdate: $('lastUpdate'),
    connect: $('connect'), disconnect: $('disconnect'), notice: $('notice'),
    chart: $('chart'), chartTitle: $('chartTitle'), range: $('range'), emptyChart: $('emptyChart'),
    minimum: $('minimum'), maximum: $('maximum'), meters: $('meters'), audioState: $('audioState'),
    micHint: $('micHint'), soilMeta: $('soilMeta'), exportBtn: $('export'), demoBtn: $('demo'),
  };

  const state = {
    history: [],
    latest: null,
    selected: 'soil_pct',
    device: null,
    characteristic: null,
    userDisconnect: false,
    reconnects: 0,
    demoTimer: null,
    demoSample: 0,
    mode: 'idle',   // idle | connecting | live | demo
  };

  const decoder = new SnapshotDecoder(onSample);
  const textDecoder = new TextDecoder('utf-8');

  /* ---------- helpers ---------- */
  const fmt = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const timeStr = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function setNotice(text, demo = false) {
    ui.notice.textContent = text;
    ui.notice.classList.toggle('demo-notice', demo);
  }
  function setStatus(label, dot) {
    ui.connection.textContent = label;
    ui.dot.className = 'dot' + (dot ? ' ' + dot : '');
  }
  function svgEl(name, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  /* ---------- meters (built once) ---------- */
  const meterEls = MICS.map((key, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'meter';
    wrap.innerHTML = '<div class="track"><div class="fill"></div></div><b>MIC ' + 'ABCD'[i] + '</b><span>— dBFS</span>';
    ui.meters.appendChild(wrap);
    return { fill: wrap.querySelector('.fill'), value: wrap.querySelector('span') };
  });

  /* ---------- incoming data ---------- */
  function onSample(sample) {
    state.latest = sample;
    state.history.push(sample);
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    render();
  }

  function onNotification(event) {
    const dv = event.target.value;
    const text = textDecoder.decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    decoder.feed(text);
  }

  /* ---------- Bluetooth ---------- */
  function bluetoothProblem() {
    if (!window.isSecureContext)
      return 'This page must be opened over HTTPS (or http://localhost). Bluetooth is blocked on plain http:// and file pages.';
    if (!navigator.bluetooth)
      return 'This browser has no Web Bluetooth. Use Chrome on Android (iPhone browsers do not support it).';
    return null;
  }

  async function connect() {
    const problem = bluetoothProblem();
    if (problem) { setNotice(problem); return; }
    stopDemo();
    ui.connect.disabled = true;
    state.userDisconnect = false;
    try {
      setStatus('Choose your device…', '');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }, { services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      state.device = device;
      device.addEventListener('gattserverdisconnected', onGattDisconnected);
      state.reconnects = 0;
      await openGatt();
    } catch (err) {
      ui.connect.disabled = false;
      if (err && err.name === 'NotFoundError') {
        setStatus('Not connected', '');
        setNotice('No device chosen. If SPR-PERIPHERAL was not listed, close nRF Connect, reset the board and try again.');
      } else {
        setStatus('Connection failed', 'stale');
        setNotice('Could not connect: ' + (err && err.message ? err.message : err));
      }
    }
  }

  async function openGatt() {
    state.mode = 'connecting';
    setStatus('Connecting…', 'stale');
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const ch = await service.getCharacteristic(CHAR_UUID);
    ch.addEventListener('characteristicvaluechanged', onNotification);
    decoder.reset();
    await ch.startNotifications();
    state.characteristic = ch;
    state.mode = 'live';
    ui.connect.hidden = true;
    ui.connect.disabled = false;
    ui.disconnect.hidden = false;
    setStatus('Connected · waiting for first reading', 'stale');
    setNotice('Connected to ' + (state.device.name || DEVICE_NAME) + '. A full reading takes about 1–2 seconds.');
  }

  function onGattDisconnected() {
    if (state.characteristic) state.characteristic.removeEventListener('characteristicvaluechanged', onNotification);
    state.characteristic = null;
    decoder.reset(); // drop any half-received snapshot
    if (state.userDisconnect || state.mode === 'demo') return resetButtons();
    if (state.reconnects < MAX_RECONNECTS) {
      state.reconnects++;
      setStatus('Connection lost · reconnecting (' + state.reconnects + '/' + MAX_RECONNECTS + ')', 'stale');
      setTimeout(() => openGatt().catch(() => onGattDisconnected()), 1500 * state.reconnects);
    } else {
      state.mode = 'idle';
      resetButtons();
      setStatus('Disconnected', '');
      setNotice('Lost the board. Move the phone closer, then tap Connect device.');
    }
  }

  function disconnect() {
    state.userDisconnect = true;
    if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
    state.mode = 'idle';
    resetButtons();
    setStatus('Not connected', '');
    setNotice('Disconnected. Your readings stay on this page until you close it.');
  }

  function resetButtons() {
    ui.connect.hidden = false;
    ui.connect.disabled = false;
    ui.disconnect.hidden = true;
  }

  /* ---------- demo ---------- */
  function startDemo() {
    if (state.mode === 'demo') return stopDemo(true);
    if (state.mode === 'live') disconnect();
    state.mode = 'demo';
    ui.demoBtn.textContent = 'Stop demo';
    setStatus('Demo data', 'live');
    setNotice('DEMO — these numbers are made up, not from your board.', true);
    const tick = () => {
      const t = Date.now() / 1000;
      const listening = Math.floor(t / 20) % 2 === 0;
      const lines = [
        'sample=' + ++state.demoSample,
        'soil_pct=' + (55 + 8 * Math.sin(t / 40)).toFixed(1),
        'soil_V=' + (2.1 + 0.2 * Math.sin(t / 40)).toFixed(3),
        'soil_raw=' + Math.round(400 + 20 * Math.sin(t / 40)),
        'temp_C=' + (24 + 1.5 * Math.sin(t / 60)).toFixed(1),
        'rh_pct=' + (60 + 5 * Math.cos(t / 50)).toFixed(1),
        'co2_ppm=' + Math.round(650 + 80 * Math.sin(t / 30)),
        ...MICS.map((m, i) => m + '=' + (listening ? (-55 + 15 * Math.random() + i * 3).toFixed(1) : 'NA')),
        'audio=' + (listening ? 'listening' : 'off'),
      ];
      decoder.feed(lines.join('\n') + '\n');
    };
    tick();
    state.demoTimer = setInterval(tick, 1200);
  }

  function stopDemo(announce) {
    if (state.demoTimer) clearInterval(state.demoTimer);
    state.demoTimer = null;
    ui.demoBtn.textContent = 'Preview with demo data';
    if (state.mode === 'demo') {
      state.mode = 'idle';
      state.history = [];   // never mix demo numbers with real ones
      state.latest = null;
      render();
      if (announce) { setStatus('Not connected', ''); setNotice('Demo stopped. Demo readings were cleared.'); }
    }
  }

  /* ---------- export ---------- */
  function exportCsv() {
    if (!state.history.length) { setNotice('Nothing to export yet.'); return; }
    const rows = [['time', ...EXPORT_FIELDS].join(',')];
    for (const s of state.history) {
      rows.push([new Date(s.time).toISOString(), ...EXPORT_FIELDS.map((k) => (s[k] === null || s[k] === undefined ? 'NA' : s[k]))].join(','));
    }
    const blob = new Blob([rows.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spresense_readings_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + (state.mode === 'demo' ? '_DEMO' : '') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- rendering ---------- */
  function drawLine(svg, key, w, h, pad, points) {
    svg.textContent = '';
    const vals = points.map((p) => p[key]).filter((v) => Number.isFinite(v));
    if (vals.length < 2) return null;
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 1e-6) { min -= 1; max += 1; }
    const t0 = points[0].time, t1 = points[points.length - 1].time || t0 + 1;
    const x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - 2 * pad);
    const y = (v) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
    let d = '', pen = false;
    for (const p of points) {
      const v = p[key];
      if (!Number.isFinite(v)) { pen = false; continue; } // NA leaves a gap
      d += (pen ? 'L' : 'M') + x(p.time).toFixed(1) + ' ' + y(v).toFixed(1);
      pen = true;
    }
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    return { min: Math.min(...vals), max: Math.max(...vals), x, y };
  }

  function renderChart() {
    const key = state.selected, meta = META[key];
    const card = document.querySelector('.card[data-key="' + key + '"]');
    ui.chart.style.color = card ? getComputedStyle(card).getPropertyValue('--accent') : '#d1ec9b';
    ui.chartTitle.textContent = meta.title;
    const since = Date.now() - Number(ui.range.value) * 1000;
    const points = state.history.filter((p) => p.time >= since);
    const res = drawLine(ui.chart, key, 640, 230, 18, points);
    ui.emptyChart.hidden = !!res;
    if (res) {
      ui.minimum.textContent = 'MIN ' + res.min.toFixed(meta.digits) + ' ' + meta.unit;
      ui.maximum.textContent = 'MAX ' + res.max.toFixed(meta.digits) + ' ' + meta.unit;
      ui.chart.appendChild(svgEl('text', { x: 18, y: 14, fill: '#a4b4a6', 'font-size': 11 })).textContent = timeStr(points[0].time);
      ui.chart.appendChild(svgEl('text', { x: 622, y: 14, fill: '#a4b4a6', 'font-size': 11, 'text-anchor': 'end' })).textContent = timeStr(points[points.length - 1].time);
    } else {
      ui.minimum.textContent = 'MIN —';
      ui.maximum.textContent = 'MAX —';
    }
  }

  function render() {
    const s = state.latest;
    for (const key in META) {
      $(key).textContent = s ? fmt(s[key], META[key].digits) : '—';
      const spark = document.querySelector('svg[data-spark="' + key + '"]');
      drawLine(spark, key, 260, 50, 4, state.history.slice(-60));
    }
    ui.soilMeta.textContent = s
      ? 'Estimated voltage ' + fmt(s.soil_V, 2) + ' V · ADC ' + fmt(s.soil_raw, 0)
      : 'Estimated voltage — · ADC —';

    const audio = s ? s.audio : 'off';
    ui.audioState.textContent = { off: 'Off', listening: 'Listening', recording: '● Recording', fault: 'Fault' }[audio] || 'Off';
    ui.micHint.textContent = audio === 'fault' ? 'The board reported a microphone fault. Check the TFT / Serial monitor.'
      : audio === 'off' ? 'Open SOUND on the TFT to start listening.' : 'Live levels from the four microphones.';
    MICS.forEach((key, i) => {
      const v = s ? s[key] : null;
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, ((v + 90) / 90) * 100)) : 0; // -90..0 dBFS
      meterEls[i].fill.style.height = pct + '%';
      meterEls[i].value.textContent = fmt(v, 1) + ' dBFS';
    });
    renderChart();
    updateFreshness();
  }

  function updateFreshness() {
    ui.clock.textContent = new Date().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (state.mode !== 'live' && state.mode !== 'demo') {
      if (state.latest) ui.lastUpdate.textContent = 'Last reading ' + timeStr(state.latest.time) + ' (not live).';
      return;
    }
    if (!state.latest) { ui.lastUpdate.textContent = 'Waiting for the first full snapshot…'; return; }
    const age = Date.now() - state.latest.time;
    const sec = Math.round(age / 1000);
    ui.lastUpdate.textContent = 'Reading #' + state.latest.sample + ' · ' + (sec <= 1 ? 'just now' : sec + ' s ago');
    if (state.mode === 'live') {
      if (age > STALE_MS) setStatus('Connected · no new data (stale)', 'stale');
      else setStatus('Live', 'live');
    }
  }

  /* ---------- wiring ---------- */
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.card').forEach((c) => c.classList.toggle('selected', c === card));
      state.selected = card.dataset.key;
      renderChart();
    });
  });
  ui.range.addEventListener('change', renderChart);
  ui.connect.addEventListener('click', connect);
  ui.disconnect.addEventListener('click', disconnect);
  ui.demoBtn.addEventListener('click', startDemo);
  ui.exportBtn.addEventListener('click', exportCsv);
  window.addEventListener('beforeunload', (e) => {
    if (state.history.length && state.mode === 'live') { e.preventDefault(); e.returnValue = ''; }
  });
  setInterval(updateFreshness, 1000);

  const problem = bluetoothProblem();
  if (problem) setNotice(problem + ' You can still try “Preview with demo data”.');
  render();

  // exposed for testing only
  window.__plantDashboard = { state, decoder };
})();
