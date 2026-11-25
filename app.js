/*
 * Release Check – proof-of-concept vehicle release validation web app.
 * Runs entirely in the browser: OCR with Tesseract.js, VIN barcodes with the
 * browser BarcodeDetector, data in localStorage on this phone only.
 */
'use strict';

/* =====================================================================
 * 1. Registration helpers (pure functions, unit-tested in Node)
 * ===================================================================== */

// Characters OCR commonly confuses, used to fix a read by position.
const TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B' };
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8' };

function cleanReg(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const CURRENT_RE = /^[A-Z]{2}\d{2}[A-Z]{3}$/;          // AB21 XYZ (2001 onwards)
const PREFIX_RE = /^[A-Z]\d{1,3}[A-Z]{3}$/;            // A123 BCD
const SUFFIX_RE = /^[A-Z]{3}\d{1,3}[A-Z]$/;            // ABC 123D
const NI_RE = /^[A-Z]{3}\d{1,4}$/;                     // ABZ 1234 (accepted when typed, not auto-detected)

// DVLA rules for current-format plates (2001 onwards): the two-letter memory tag
// never uses I, Q or Z, and the three random letters never use I or Q.
// A read that breaks these rules cannot be a real plate, so it was misread.
function impossibleCurrent(n) {
  n = cleanReg(n);
  if (!CURRENT_RE.test(n)) return false;
  return /[IQZ]/.test(n.slice(0, 2)) || /[IQ]/.test(n.slice(4));
}

function isValidReg(n) {
  n = cleanReg(n);
  if (CURRENT_RE.test(n)) return !impossibleCurrent(n);
  return PREFIX_RE.test(n) || SUFFIX_RE.test(n) || NI_RE.test(n);
}

function formatReg(s) {
  const n = cleanReg(s);
  if (CURRENT_RE.test(n)) return n.slice(0, 4) + ' ' + n.slice(4);
  let m = n.match(/^([A-Z]\d{1,3})([A-Z]{3})$/); if (m) return m[1] + ' ' + m[2];
  m = n.match(/^([A-Z]{3})(\d{1,3}[A-Z])$/); if (m) return m[1] + ' ' + m[2];
  m = n.match(/^([A-Z]{3})(\d{1,4})$/); if (m) return m[1] + ' ' + m[2];
  return n;
}

// Fix a 7-character current-format read by position (letters / digits).
// Rejects reads that need more than 2 fixes, or that are mostly the wrong type,
// so words such as "COLLECT" or refs such as "BK10421" are not turned into plates.
function fixCurrent(raw) {
  if (raw.length !== 7) return null;
  const pattern = 'LLDDLLL';
  let out = '', fixes = 0, realLetters = 0, realDigits = 0;
  for (let i = 0; i < 7; i++) {
    const ch = raw[i];
    if (pattern[i] === 'L') {
      if (/[A-Z]/.test(ch)) { out += ch; realLetters++; }
      else if (TO_LETTER[ch]) { out += TO_LETTER[ch]; fixes++; }
      else return null;
    } else {
      if (/\d/.test(ch)) { out += ch; realDigits++; }
      else if (TO_DIGIT[ch]) { out += TO_DIGIT[ch]; fixes++; }
      else return null;
    }
  }
  if (fixes > 2 || realDigits < 1 || realLetters < 3) return null;
  return { reg: out, corrections: fixes };
}

// Find UK registrations in a line of OCR text.
function findRegCandidates(text) {
  const up = String(text || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  const found = new Map();
  const add = (reg, corrections, raw) => {
    const prev = found.get(reg);
    if (!prev || prev.corrections > corrections) found.set(reg, { reg, corrections, raw });
  };
  for (const m of up.matchAll(/(?<![A-Z0-9])([A-Z0-9]{2}) ?([A-Z0-9]{2}) ?([A-Z0-9]{3})(?![A-Z0-9])/g)) {
    const fixed = fixCurrent(m[1] + m[2] + m[3]);
    if (fixed) add(fixed.reg, fixed.corrections, m[0].trim());
  }
  for (const m of up.matchAll(/(?<![A-Z0-9])([A-Z]\d{1,3}) ?([A-Z]{3})(?![A-Z0-9])/g)) add(m[1] + m[2], 0, m[0].trim());
  for (const m of up.matchAll(/(?<![A-Z0-9])([A-Z]{3}) ?(\d{1,3}[A-Z])(?![A-Z0-9])/g)) add(m[1] + m[2], 0, m[0].trim());
  return [...found.values()].sort((a, b) => a.corrections - b.corrections);
}

// Collapse look-alike characters so "AB2I XYZ" and "AB21 XYZ" compare equal.
function canonical(s) {
  return cleanReg(s).replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5')
    .replace(/B/g, '8').replace(/Z/g, '2').replace(/G/g, '6');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Decide the outcome of a scan.
 * scan: { reg, conf (0-100), corrections, method: 'camera' | 'typed' | 'eye' }
 * returns { kind: 'ok' | 'check' | 'stop' | 'released', entry, reason, near, released }
 */
function evaluateScan(scan, entries, releasedItems, threshold) {
  const n = cleanReg(scan.reg);
  const entry = entries.find((e) => cleanReg(e.reg) === n);
  if (entry) {
    const rel = releasedItems[n];
    if (rel) return { kind: 'released', entry, released: rel };
    const low = scan.method === 'camera' && (scan.conf < threshold || scan.corrections > 0);
    if (low) return { kind: 'check', entry, reason: 'low' };
    return { kind: 'ok', entry };
  }
  const near = entries.filter((e) => {
    const m = cleanReg(e.reg);
    return canonical(m) === canonical(n) || levenshtein(m, n) <= 1;
  });
  if (near.length) return { kind: 'check', entry: null, reason: 'near', near: near.map((e) => e.reg), impossible: impossibleCurrent(n) };
  return { kind: 'stop', entry: null, reason: 'missing' };
}

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Turn OCR lines into diary entries. This version captures ONLY the collection
 * time and the registration; every other column on the diary is ignored.
 * lines: [{ text, confidence, words: [{ text, confidence }] }]
 */
/**
 * Turn OCR lines into diary rows. Each row uses the FIRST registration printed
 * on it (the top line of the registration cell, or the leftmost on a line).
 * Any further registrations on the same row are kept in `alt` so the review
 * screen can show them, but they are not added to the release list.
 * A line holding only a registration (a second line in the registration
 * cell) joins the nearest full row directly above or below it, if the OCR
 * positions show it is close enough to be in the same cell.
 */
function parseDiaryLines(lines) {
  const items = [];
  for (const line of lines) {
    // Join characters split by stray punctuation ("Ki.M" -> "KiM"), but keep times like 09.30.
    const text = String(line.text || '').replace(/(?<=[A-Za-z])[.,`](?=[A-Za-z0-9])|(?<=\d)[.,`](?=[A-Za-z])/g, '');
    const up = text.toUpperCase();
    const norm = up.replace(/[^A-Z0-9\s]/g, ' ');
    const time = ((up.match(TIME_RE) || [])[0] || '').replace('.', ':');
    const cands = findRegCandidates(up)
      .map((c) => Object.assign({ at: norm.indexOf(c.raw) }, c))
      .sort((a, b) => (a.at - b.at) || (a.corrections - b.corrections));
    // Two candidates from the same characters (e.g. lookalike fixes) keep the first only.
    const regs = [];
    for (const c of cands) if (!regs.some((r) => r.at === c.at)) regs.push(c);
    if (!regs.length && !time) continue;
    const tWord = time ? (line.words || []).find((w) => TIME_RE.test(String(w.text || '').toUpperCase())) : null;
    const timeConf = Math.round(tWord ? tWord.confidence : (typeof line.confidence === 'number' ? line.confidence : 0));
    // A second line inside the registration cell holds just a registration;
    // a real diary row also has other columns (customer, booking ref...).
    let rest = norm;
    for (const r of regs) rest = rest.replace(r.raw, ' ');
    rest = rest.replace(/\b([01]?\d|2[0-3]) ?[0-5]\d\b/, ' ').replace(/\s+/g, '');
    items.push({ line, regs, time: normTime(time), timeConf, box: line.bbox || null, regOnly: rest.length <= 3 });
  }
  const hs = items.filter((i) => i.box).map((i) => i.box.y1 - i.box.y0).sort((a, b) => a - b);
  const lineH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  // Anchors are full diary lines (other columns, or a time). A line holding only
  // a registration joins the nearest anchor directly above or below it, if it is
  // close enough to be part of the same table cell.
  const isAnchor = (it) => !it.regOnly || !!it.time;
  const gap = (upper, lower) => (upper.box && lower.box && lineH) ? lower.box.y0 - upper.box.y1 : Infinity;
  const near = 0.6 * lineH;
  const owner = items.map((it, i) => {
    if (isAnchor(it)) return i;
    const up = i > 0 && isAnchor(items[i - 1]) ? gap(items[i - 1], it) : Infinity;
    const down = i < items.length - 1 && isAnchor(items[i + 1]) ? gap(it, items[i + 1]) : Infinity;
    if (Math.min(up, down) >= near) return i; // stands alone as its own row
    return up <= down ? i - 1 : i + 1;
  });
  const groups = new Map();
  items.forEach((it, i) => { const o = owner[i]; if (!groups.has(o)) groups.set(o, []); groups.get(o).push(it); });
  const rows = [];
  for (const [, its] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    const regs = its.flatMap((it) => it.regs.map((c) => ({ c, line: it.line })));
    if (!regs.length) continue; // a stray time with no registration
    const times = [...new Set(its.map((it) => it.time).filter(Boolean))];
    const tIt = its.find((it) => it.time);
    rows.push({ regs, time: times.length === 1 ? times[0] : '', timeConf: tIt ? tIt.timeConf : 0 });
  }
  const byReg = new Map();
  for (const r of rows) {
    const { c, line } = r.regs[0];
    let conf = typeof line.confidence === 'number' ? line.confidence : 0;
    const regChars = cleanReg(c.raw);
    const ws = (line.words || []).filter((w) => {
      const t = cleanReg(w.text);
      return t.length >= 2 && regChars.includes(t);
    });
    if (ws.length) conf = Math.min(...ws.map((w) => w.confidence));
    if (c.corrections > 0) conf = Math.min(conf, 70);
    conf = Math.round(Math.max(0, Math.min(100, conf)));
    const alt = [...new Set(r.regs.slice(1).map((x) => formatReg(x.c.reg)).filter((g) => cleanReg(g) !== c.reg))];
    const e = { reg: formatReg(c.reg), time: r.time, timeConf: r.timeConf, conf, corrected: c.corrections > 0 };
    if (alt.length) e.alt = alt;
    const prev = byReg.get(c.reg);
    if (!prev || prev.conf < e.conf) byReg.set(c.reg, e);
  }
  return [...byReg.values()]; // kept in the order printed on the diary
}

const MAX_PAGES = 3; // page 1 plus 2 additional pages

function toMin(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(t || '');
  return m ? +m[1] * 60 + +m[2] : null;
}

/**
 * Times on a diary page are normally in order. Return the indexes of rows whose
 * time breaks that order (rows outside the longest in-order run). If the page is
 * not mostly in time order (under 70% of rows in the run), nothing is flagged.
 */
function timeOrderFlags(times) {
  const pts = [];
  times.forEach((t, i) => { const v = toMin(t); if (v != null) pts.push([i, v]); });
  const out = new Set();
  const n = pts.length;
  if (n < 3) return out;
  const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (pts[j][1] <= pts[i][1] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i;
  const keep = new Set();
  for (let k = best; k !== -1; k = prev[k]) keep.add(k);
  if (keep.size < Math.ceil(n * 0.7)) return out;
  pts.forEach(([i], k) => { if (!keep.has(k)) out.add(i); });
  return out;
}

// "9:30" -> "09:30"; returns '' if not a valid 24-hour time.
function normTime(t) {
  const m = String(t || '').trim().match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
}

function extractVin(raw) {
  const s = cleanReg(raw);
  const m = s.match(/[A-HJ-NPR-Z0-9]{17}/);
  return m ? m[0] : null;
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

// Operator / supervisor IDs: 2–12 letters, digits or hyphens, stored in capitals.
function normOperatorId(s) {
  const v = String(s || '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9-]{2,12}$/.test(v) ? v : '';
}

const PHOTO_MODES = { all: 'All scans', exceptions: 'Exceptions only', off: 'Off' };
// Exceptions = any result that blocks the release, plus supervisor overrides.
const EXCEPTION_KINDS = ['stop', 'check', 'released'];
function shouldSavePhoto(mode, kind, isOverride) {
  if (mode === 'all') return true;
  if (mode === 'off') return false;
  return !!isOverride || EXCEPTION_KINDS.includes(kind);
}

if (typeof module !== 'undefined') {
  module.exports = { cleanReg, isValidReg, impossibleCurrent, formatReg, fixCurrent, findRegCandidates, canonical, levenshtein, evaluateScan, parseDiaryLines, normTime, toMin, timeOrderFlags, MAX_PAGES, normOperatorId, PHOTO_MODES, shouldSavePhoto, extractVin, csvCell };
}

/* =====================================================================
 * 2. App (browser only)
 * ===================================================================== */
if (typeof document !== 'undefined') (function main() {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const uid = () => Math.random().toString(36).slice(2, 10);

  const SAMPLE = [
    { reg: 'LM70 OPQ', time: '08:45' },
    { reg: 'AB21 XYZ', time: '09:30' },
    { reg: 'BK73 TGH', time: '10:00' },
    { reg: 'YX19 RPL', time: '11:15' },
    { reg: 'FD24 KLM', time: '13:00' }
  ];

  /* ---------- Storage ---------- */
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('rc.' + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(key, val) {
      try { localStorage.setItem('rc.' + key, JSON.stringify(val)); return true; }
      catch (e) { toast('Phone storage is full. Export and clear the audit log.', true); return false; }
    }
  };

  const S = {
    settings: Object.assign({ operatorId: '', threshold: 85, siteOpen: '06:00', siteClose: '20:00', photoMode: 'exceptions' }, store.get('settings', {}), { requireVin: false }), // VIN check off: the diary capture has no VIN in this version
    diary: store.get('diary', null),                 // { date, lockedAt, entries: [] }
    released: store.get('released', { date: todayISO(), items: {} }),
    log: store.get('log', []),
    draft: null,                                     // diary being reviewed: { entries, pages, raw: [], checkedAll, source }
    captureMode: 'new',                              // 'new' diary or 'append' another page
    result: null,                                    // current validation
    screen: 'home',
    scanMode: 'camera',
    busy: false
  };
  if (S.released.date !== todayISO()) S.released = { date: todayISO(), items: {} };
  // v1.3: full names are no longer used. Drop any stored name; the operator must enter an ID.
  if ('operator' in S.settings) { delete S.settings.operator; store.set('settings', S.settings); }
  if (!PHOTO_MODES[S.settings.photoMode]) S.settings.photoMode = 'exceptions';
  const opId = () => S.settings.operatorId;

  const save = {
    settings: () => store.set('settings', S.settings),
    diary: () => store.set('diary', S.diary),
    released: () => store.set('released', S.released),
    log: () => store.set('log', S.log)
  };

  function logEvent(result, reg, note, extra) {
    const d = new Date();
    S.log.push(Object.assign({ id: uid(), ts: d.toISOString(), time: nowHM(), operatorId: opId(), reg: reg || '', result, note: note || '' }, extra || {}));
    if (!save.log()) {
      // Storage full: drop photos from the oldest entries and retry once.
      S.log.slice(0, Math.ceil(S.log.length / 2)).forEach((l) => { delete l.thumb; });
      save.log();
    }
  }

  function markReleased(reg, how) {
    S.released.items[cleanReg(reg)] = { at: nowHM(), by: opId(), how };
    save.released();
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, warn) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('warn', !!warn);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  /* ---------- Navigation ---------- */
  const TITLES = { setup: 'Set up', home: 'Today', processing: 'Reading diary', review: 'Check extracted list', scan: 'Scan vehicle', result: 'Validation result', vin: 'Scan VIN', override: 'Supervisor override', audit: 'Audit log', settings: 'Settings' };
  const BACK = { review: 'home', scan: 'home', result: 'scan', vin: 'result', override: 'result', audit: 'home', settings: 'home' };

  function show(screen) {
    if (S.screen === 'scan' || S.screen === 'vin') stopCamera();
    S.screen = screen;
    document.querySelectorAll('[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== screen; });
    $('#screenTitle').textContent = TITLES[screen] || '';
    $('#backBtn').hidden = !BACK[screen];
    const id = opId() || '';
    $('#opName').textContent = id ? 'ID ' + id : '';
    $('#opInitials').textContent = id ? id.slice(0, 2) : '?';
    window.scrollTo(0, 0);
    ({ home: renderHome, review: renderReview, result: renderResult, override: renderOverride, audit: renderAudit, settings: renderSettings, scan: enterScan, vin: enterVin }[screen] || (() => {}))();
  }

  $('#backBtn').addEventListener('click', () => show(BACK[S.screen] || 'home'));
  $('#settingsBtn').addEventListener('click', () => { if (opId()) show('settings'); });

  /* ---------- Camera ---------- */
  let stream = null;
  async function startCamera(video) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot open the camera. Use Chrome, and open the app over https.');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const torch = $('#torchBtn');
    torch.hidden = !(caps && caps.torch) || video.id !== 'plateVideo';
    torch.setAttribute('aria-pressed', 'false');
  }
  function stopCamera() {
    stopVinLoop();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }
  function cameraError(e) {
    if (e && e.name === 'NotAllowedError') return 'Camera permission was refused. Allow camera access for this site in Chrome settings, or use "Type it".';
    if (e && e.name === 'NotFoundError') return 'No camera found on this device. Use "Type it".';
    return (e && e.message) || 'The camera could not be started.';
  }
  $('#torchBtn').addEventListener('click', async () => {
    const btn = $('#torchBtn');
    const on = btn.getAttribute('aria-pressed') !== 'true';
    try {
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] });
      btn.setAttribute('aria-pressed', String(on));
    } catch (e) { toast('Torch is not available on this phone.', true); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (S.screen === 'scan' || S.screen === 'vin') show(S.screen);
  });

  /* ---------- Image processing ---------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); };
      img.src = url;
    });
  }

  // Draw a source region into a greyscale, contrast-stretched canvas (optionally black/white).
  function prepare(src, sx, sy, sw, sh, targetW, binarize) {
    const scale = targetW / sw;
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = g; hist[g]++;
    }
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    let threshold = 128;
    if (binarize) {
      // Otsu threshold on the stretched histogram
      const h2 = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) h2[Math.max(0, Math.min(255, ((d[i] - lo) * 255 / range) | 0))]++;
      let sum = 0; for (let v = 0; v < 256; v++) sum += v * h2[v];
      let sumB = 0, wB = 0, best = 0;
      for (let v = 0; v < 256; v++) {
        wB += h2[v]; if (!wB) continue;
        const wF = total - wB; if (!wF) break;
        sumB += v * h2[v];
        const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
        if (between > best) { best = between; threshold = v; }
      }
    }
    for (let i = 0; i < d.length; i += 4) {
      let g = Math.max(0, Math.min(255, ((d[i] - lo) * 255 / range) | 0));
      if (binarize) g = g > threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Diary photos: adaptive black/white (copes with shadows), then remove table
  // ruling lines, which otherwise stop the text reader finding the rows.
  function prepareDiary(img, targetW) {
    const scale = targetW / img.naturalWidth;
    const c = document.createElement('canvas');
    const w = c.width = Math.round(img.naturalWidth * scale);
    const h = c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    // Integral image for local means (Bradley adaptive threshold).
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) { row += g[(y - 1) * w + (x - 1)]; integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + row; }
    }
    const r = Math.max(8, Math.round(w / 32));
    const bw = new Uint8Array(w * h); // 1 = ink
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integ[(y1 + 1) * (w + 1) + (x1 + 1)] - integ[y0 * (w + 1) + (x1 + 1)] - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
        bw[y * w + x] = g[y * w + x] * area < sum * 0.85 ? 1 : 0;
      }
    }
    // Remove long horizontal and vertical runs (table lines).
    const clear = new Uint8Array(w * h);
    const minH = Math.round(w * 0.12), minV = Math.round(h * 0.08);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x <= w; x++) {
        if (x < w && bw[y * w + x]) { run++; continue; }
        if (run >= minH) for (let k = x - run; k < x; k++) clear[y * w + k] = 1;
        run = 0;
      }
    }
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y <= h; y++) {
        if (y < h && bw[y * w + x]) { run++; continue; }
        if (run >= minV) for (let k = y - run; k < y; k++) clear[k * w + x] = 1;
        run = 0;
      }
    }
    for (let p = 0, i = 0; p < bw.length; p++, i += 4) {
      const v = bw[p] && !clear[p] ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  }

  function thumbnail(src, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = Math.max(1, Math.round(240 * sh / sw));
    c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  }

  // Map the on-screen guide box to the camera frame (video uses object-fit: cover).
  function guideRegion(video, guide) {
    const vr = video.getBoundingClientRect();
    const gr = guide.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
    let sx = (gr.left - vr.left - ox) / scale, sy = (gr.top - vr.top - oy) / scale;
    let sw = gr.width / scale, sh = gr.height / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    return { sx, sy, sw, sh };
  }

  /* ---------- OCR (Tesseract.js) ---------- */
  let workerPromise = null;
  let onProgress = null;
  function getWorker() {
    if (!window.Tesseract) return Promise.reject(new Error('The text reader did not load. Check the internet connection and reload the app.'));
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, { logger: (m) => { if (onProgress) onProgress(m); } })
        .catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  function linesFrom(data) {
    const lines = [];
    if (data.blocks && data.blocks.length) {
      for (const b of data.blocks) for (const p of (b.paragraphs || [])) for (const l of (p.lines || [])) {
        lines.push({ text: l.text, confidence: l.confidence, bbox: l.bbox || null, words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence })) });
      }
    } else if (data.lines && data.lines.length) {
      for (const l of data.lines) lines.push({ text: l.text, confidence: l.confidence, bbox: l.bbox || null, words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence })) });
    } else {
      for (const t of String(data.text || '').split('\n')) if (t.trim()) lines.push({ text: t, confidence: data.confidence || 0, words: [] });
    }
    return lines;
  }

  async function ocr(canvas, params) {
    const worker = await getWorker();
    await worker.setParameters(params);
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    return { text: data.text || '', lines: linesFrom(data) };
  }

  /* ---------- Home ---------- */
  function renderHome() {
    const d = S.diary;
    const today = todayISO();
    const stale = d && d.date !== today;
    const ready = d && !stale;
    let html = '';
    if (!ready) {
      html += `<div class="card stack">
        <h2>${stale ? 'Diary is from ' + esc(d.date) : 'No diary loaded for today'}</h2>
        <p class="muted">Photograph the printed Daily Diary to load today’s collections. Scanning stays locked until the extracted list has been checked.</p>
        <button class="btn primary" type="button" data-action="capture-diary">Capture Daily Diary</button>
        <button class="btn" type="button" data-action="pick-diary">Use a saved photo</button>
        <button class="btn" type="button" data-action="sample-diary">Load test diary (demo)</button>
      </div>
      <button class="btn big" type="button" disabled>Scan Vehicle</button>
      <p class="small center">Load today’s diary to start scanning.</p>`;
    } else {
      const total = d.entries.length;
      const rel = d.entries.filter((e) => S.released.items[cleanReg(e.reg)]).length;
      html += `<div class="card stack">
        <div class="row" style="justify-content:space-between"><h2>Today’s Daily Diary</h2><span class="pill blue">Locked ${esc(d.lockedAt)} · ${d.pages || 1} of ${MAX_PAGES} pages</span></div>
        <div class="grid3">
          <div class="stat"><b>${total}</b><span>Vehicles</span></div>
          <div class="stat"><b>${rel}</b><span>Released</span></div>
          <div class="stat"><b>${total - rel}</b><span>To collect</span></div>
        </div>
      </div>
      <button class="btn primary big" type="button" data-action="go-scan">Scan Vehicle</button>
      <div class="grid2">
        ${(d.pages || 1) < MAX_PAGES ? `<button class="btn" type="button" data-action="add-page-home">Add page ${(d.pages || 1) + 1} of ${MAX_PAGES}</button>` : '<button class="btn" type="button" disabled>All 3 pages used</button>'}
        <button class="btn" type="button" data-action="recapture">New diary</button>
      </div>
      <button class="btn" type="button" data-action="go-audit">Audit log</button>
      <h3>Today’s vehicles</h3>`;
      for (const e of d.entries) {
        const r = S.released.items[cleanReg(e.reg)];
        html += `<div class="vehicle"><span class="plate white">${esc(e.reg)}</span>
          <div class="who"><div>${esc(e.time || 'No time')}</div><div>Collection time</div></div>
          ${r ? `<span class="pill slate">Released ${esc(r.at)}</span>` : '<span class="pill blue">Due</span>'}</div>`;
      }
    }
    if (!ready) html += `<button class="btn" type="button" data-action="go-audit">Audit log</button>`;
    $('#homeBody').innerHTML = html;
  }

  /* ---------- Diary capture ---------- */
  async function readDiaryPhoto(file) {
    if (!file) return;
    show('processing');
    const status = $('#procStatus'), bar = $('#procBar');
    const setP = (txt, p) => { status.textContent = txt; bar.style.width = Math.round((p || 0) * 100) + '%'; };
    setP('Preparing image', 0.02);
    onProgress = (m) => {
      if (m.status === 'recognizing text') setP('Reading text', m.progress);
      else setP(m.status ? m.status.charAt(0).toUpperCase() + m.status.slice(1) : 'Loading', m.progress);
    };
    try {
      const img = await loadImage(file);
      const w = img.naturalWidth;
      const canvas = prepareDiary(img, Math.min(2200, Math.max(1600, w)));
      // Try the page layouts that suit printed lists/tables; stop once rows are found.
      let lines = [], raw = '';
      for (const psm of ['6', '4', '11']) {
        const res = await ocr(canvas, { tessedit_pageseg_mode: psm, tessedit_char_whitelist: '', preserve_interword_spaces: '1' });
        const found = parseDiaryLines(res.lines);
        if (found.length > parseDiaryLines(lines).length) { lines = res.lines; raw = res.text; }
        if (!raw) raw = res.text;
        if (found.length >= 2) break;
        setP('Trying another layout', 0.1);
      }
      const append = S.captureMode === 'append' && S.draft && S.draft.pages < MAX_PAGES;
      const page = append ? S.draft.pages + 1 : 1;
      const entries = parseDiaryLines(lines).map((e) => Object.assign({ id: uid(), page, confirmed: false, edited: false }, e));
      if (append) {
        S.draft.entries.push(...entries);
        S.draft.pages = page;
        S.draft.raw.push(raw);
        S.draft.checkedAll = false;
        if (S.draft.source === 'sample') S.draft.source = 'test diary + photo';
      } else {
        S.draft = { entries, pages: 1, raw: [raw], checkedAll: false, source: 'photo' };
      }
      toast(entries.length ? 'Page ' + page + ': ' + entries.length + ' registrations found' : 'No registrations found on page ' + page + '. Retake it closer and flatter, or add the rows by hand.', !entries.length);
      show('review');
    } catch (e) {
      toast(e.message || 'The diary could not be read.', true);
      show(S.captureMode === 'append' && S.draft ? 'review' : 'home');
    } finally {
      onProgress = null;
      $('#diaryCamera').value = ''; $('#diaryPick').value = '';
    }
  }
  $('#diaryCamera').addEventListener('change', (e) => readDiaryPhoto(e.target.files[0]));
  $('#diaryPick').addEventListener('change', (e) => readDiaryPhoto(e.target.files[0]));

  /* ---------- Review ---------- */
  // Work out every reason a row must be confirmed against the paper diary.
  function rowFlags(d) {
    const flags = new Map();
    const open = toMin(S.settings.siteOpen), close = toMin(S.settings.siteClose);
    for (let p = 1; p <= d.pages; p++) {
      const rows = d.entries.filter((e) => e.page === p);
      const ooo = timeOrderFlags(rows.map((e) => e.time));
      rows.forEach((e, i) => {
        const why = [];
        if (!e.edited && !e.manual && !e.carried) {
          if (impossibleCurrent(e.reg)) why.push('Not a real UK registration: I and Q are never used in the last three letters (I, Q and Z never in the first two). Likely misread.');
          else if (!isValidReg(e.reg)) why.push('Not a standard UK registration format.');
          if (e.corrected) why.push('Some registration characters were corrected automatically.');
          else if (e.conf < S.settings.threshold) why.push('Low read confidence on the registration (' + e.conf + '%).');
          if (e.alt && e.alt.length) why.push('This row also shows ' + e.alt.join(', ') + '. Only the first registration (' + e.reg + ') is used. Check it is the vehicle being collected.');
          if (!e.time) why.push('No collection time was read. Type it in, or confirm the row has none.');
          else {
            if (e.timeConf < S.settings.threshold) why.push('Low read confidence on the time (' + e.timeConf + '%).');
            const t = toMin(e.time);
            if (open != null && close != null && (t < open || t > close)) why.push('Time is outside site hours (' + S.settings.siteOpen + '–' + S.settings.siteClose + ').');
            if (ooo.has(i)) why.push('Time is out of sequence with the rows around it.');
          }
        }
        flags.set(e.id, why);
      });
    }
    return flags;
  }
  function needsConfirm(e, flags) {
    return (flags.get(e.id) || []).length > 0;
  }
  function duplicates(entries) {
    const seen = {}, dup = new Set();
    for (const e of entries) { const k = cleanReg(e.reg); if (!k) continue; if (seen[k]) dup.add(k); seen[k] = true; }
    return dup;
  }
  function reviewProblems() {
    const d = S.draft;
    const probs = [];
    if (!d.entries.length) probs.push('Add at least one vehicle.');
    if (d.entries.some((e) => !cleanReg(e.reg))) probs.push('Every row needs a registration.');
    if (duplicates(d.entries).size) probs.push('Remove duplicate registrations.');
    const flags = rowFlags(d);
    const unconf = d.entries.filter((e) => needsConfirm(e, flags) && !e.confirmed).length;
    if (unconf) probs.push(unconf + ' flagged ' + (unconf === 1 ? 'entry needs' : 'entries need') + ' confirming.');
    if (!d.checkedAll) probs.push('Tick that you have checked the list against the paper diary.');
    return probs;
  }
  function renderReview() {
    const d = S.draft;
    if (!d) { show('home'); return; }
    const dup = duplicates(d.entries);
    const flags = rowFlags(d);
    let html = `<div class="card"><b>${d.entries.length} ${d.entries.length === 1 ? 'registration' : 'registrations'} on ${d.pages} of ${MAX_PAGES} ${d.pages === 1 ? 'page' : 'pages'}.</b>
      <p class="small">Only the collection time and registration are captured. Compare every row with the paper diary, fix anything wrong, and confirm flagged rows.</p></div>`;
    for (let p = 1; p <= d.pages; p++) {
      const rows = d.entries.filter((e) => e.page === p);
      const carried = rows.length && rows.every((e) => e.carried);
      html += `<div class="row" style="justify-content:space-between;margin-top:6px"><h3>Page ${p} · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${carried ? ' (already locked)' : ''}</h3>
        ${p === d.pages && p > 1 && !carried ? `<button class="btn small-btn danger" type="button" data-action="del-page">Remove page ${p}</button>` : ''}</div>`;
      if (!rows.length) html += '<p class="small">No rows on this page. Add them by hand or remove the page.</p>';
      for (const e of rows) {
        const why = flags.get(e.id) || [];
        const flag = why.length > 0;
        const isDup = dup.has(cleanReg(e.reg));
        const confPill = e.carried ? '<span class="pill slate">Locked</span>' : e.manual ? '<span class="pill blue">Added</span>' : e.edited ? '<span class="pill blue">Edited</span>'
          : `<span class="pill ${flag ? 'amber' : 'green'}">${Math.min(e.conf, e.time ? e.timeConf : 100)}%</span>`;
        html += `<div class="entry ${isDup ? 'dup' : flag ? 'flag' : ''}" data-id="${e.id}">
          <div class="row" style="justify-content:space-between">${confPill}
            <button class="btn small-btn danger" type="button" data-action="del-entry" data-id="${e.id}" aria-label="Remove ${esc(e.reg)}">Remove</button></div>
          <div class="fields">
            <label class="reg-field">Registration<input type="text" value="${esc(e.reg)}" data-field="reg" data-id="${e.id}" autocapitalize="characters" spellcheck="false"></label>
            <label>Collection time<input type="text" value="${esc(e.time)}" data-field="time" data-id="${e.id}" inputmode="decimal" placeholder="HH:MM" maxlength="5"></label>
          </div>
          ${isDup ? '<div class="banner-note red">Duplicate registration' + (d.pages > 1 ? ' (it may be on another page)' : '') + '. Remove one of these rows.</div>' : ''}
          ${flag ? `<div class="banner-note amber">${why.map(esc).join('<br>')}<br>Check the row against the paper diary.</div>
            <label class="check"><input type="checkbox" data-action="confirm-entry" data-id="${e.id}" ${e.confirmed ? 'checked' : ''}> <span>Matches the paper diary</span></label>` : ''}
        </div>`;
      }
    }
    const probs = reviewProblems();
    html += `<button class="btn" type="button" data-action="add-entry">Add a vehicle by hand</button>
      ${d.pages < MAX_PAGES ? `<div class="card stack"><b>Diary continues on another page?</b>
        <p class="small">You can add up to ${MAX_PAGES - d.pages} more ${MAX_PAGES - d.pages === 1 ? 'page' : 'pages'}. Rows are added to this list.</p>
        <div class="grid2"><button class="btn primary" type="button" data-action="add-page">Photograph page ${d.pages + 1}</button>
        <button class="btn" type="button" data-action="add-page-pick">Use a saved photo</button></div></div>`
        : `<p class="small center">All ${MAX_PAGES} pages used.</p>`}
      ${d.raw.some(Boolean) ? `<details><summary>Show the text the app read</summary><pre></pre></details>` : ''}
      <div class="card"><label class="check"><input id="checkedAll" type="checkbox" data-action="checked-all" ${d.checkedAll ? 'checked' : ''}>
        <span>I have checked all ${d.entries.length} entries on ${d.pages} ${d.pages === 1 ? 'page' : 'pages'} against the printed Daily Diary.</span></label></div>
      ${probs.length ? `<p class="small">${probs.map(esc).join(' ')}</p>` : ''}
      <button class="btn primary" type="button" data-action="lock" ${probs.length ? 'disabled' : ''}>Lock today’s list</button>
      <button class="btn" type="button" data-action="capture-diary">Start again from page 1</button>`;
    $('#reviewBody').innerHTML = html;
    const pre = $('#reviewBody pre');
    if (pre) pre.textContent = d.raw.map((t, i) => (t ? '--- Page ' + (i + 1) + ' ---\n' + t : '')).filter(Boolean).join('\n');
  }
  $('#reviewBody').addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t.dataset.field) return;
    const e = S.draft.entries.find((x) => x.id === t.dataset.id);
    if (!e) return;
    let v = t.value.trim();
    if (t.dataset.field === 'reg') v = formatReg(v);
    if (t.dataset.field === 'time') { const n = normTime(v); if (v && !n) { toast('Enter the time as HH:MM, e.g. 09:30.', true); } v = n; }
    if (e[t.dataset.field] !== v) { e[t.dataset.field] = v; e.edited = true; e.carried = false; }
    renderReview();
  });

  function lockDiary() {
    const d = S.draft;
    if (reviewProblems().length) return;
    const entries = d.entries.map((e) => ({ reg: formatReg(e.reg), time: e.time, conf: e.conf, timeConf: e.timeConf, page: e.page }))
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    S.diary = { date: todayISO(), lockedAt: nowHM(), entries, pages: d.pages, source: d.source };
    save.diary();
    if (S.released.date !== todayISO()) { S.released = { date: todayISO(), items: {} }; save.released(); }
    const confirmed = d.entries.filter((e) => e.confirmed).length;
    const edited = d.entries.filter((e) => e.edited || e.manual).length;
    logEvent('DIARY LOCKED', '', `Plate photos: ${PHOTO_MODES[S.settings.photoMode]} · ${entries.length} entries on ${d.pages} ${d.pages === 1 ? 'page' : 'pages'} (${d.source === 'sample' ? 'test diary' : d.source}); ${confirmed} confirmed, ${edited} edited or added`);
    S.draft = null;
    toast('Diary locked: ' + entries.length + ' vehicles loaded');
    show('home');
  }

  /* ---------- Scan ---------- */
  async function enterScan() {
    if (!S.diary || S.diary.date !== todayISO()) { show('home'); return; }
    setScanMode(S.scanMode);
  }
  async function setScanMode(mode) {
    S.scanMode = mode;
    document.querySelectorAll('[data-action="scan-mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('#scanCamera').hidden = mode !== 'camera';
    $('#scanType').hidden = mode !== 'type';
    if (mode === 'camera') {
      $('#scanMsg').textContent = 'Fill the frame with the number plate, then tap Read plate.';
      $('#readPlateBtn').disabled = false;
      try { await startCamera($('#plateVideo')); }
      catch (e) { $('#scanMsg').textContent = cameraError(e); $('#readPlateBtn').disabled = true; }
    } else {
      stopCamera();
      $('#typedReg').value = '';
      setTimeout(() => $('#typedReg').focus(), 50);
    }
  }

  async function readPlate() {
    if (S.busy) return;
    const video = $('#plateVideo');
    if (!stream || video.readyState < 2) { $('#scanMsg').textContent = 'Camera is not ready yet.'; return; }
    S.busy = true;
    const btn = $('#readPlateBtn');
    btn.disabled = true; btn.textContent = 'Reading…';
    $('#scanMsg').textContent = 'Reading the plate. Hold still.';
    onProgress = (m) => { if (m.status && m.status !== 'recognizing text') $('#scanMsg').textContent = 'Loading text reader… ' + Math.round((m.progress || 0) * 100) + '%'; };
    try {
      const { sx, sy, sw, sh } = guideRegion(video, $('#plateGuide'));
      const frame = document.createElement('canvas');
      frame.width = video.videoWidth; frame.height = video.videoHeight;
      frame.getContext('2d').drawImage(video, 0, 0);
      const thumb = thumbnail(frame, sx, sy, sw, sh);
      const targetW = Math.min(1200, Math.max(600, sw * 2));
      // Raw-line mode copes best with the plate border; no character whitelist
      // (it zeroes Tesseract's confidence scores). Fall back to other modes.
      // [page mode, black/white, scale]. The last two passes run only if the
      // earlier ones found nothing usable on today's diary.
      const passes = [['13', false, 1], ['8', false, 1], ['13', true, 1], ['7', true, 1], ['13', false, 1.5], ['8', true, 1.5]];
      // Collect candidates from every pass, then prefer: on today's diary,
      // current-format plates (2001+), higher confidence.
      const diaryRegs = new Set(S.diary.entries.map((e) => cleanReg(e.reg)));
      const all = [];
      let rawText = '';
      for (const [psm, bin, scale] of passes) {
        if (scale > 1 && all.some((c) => c.inDiary)) break;
        const prepared = prepare(frame, sx, sy, sw, sh, Math.min(1800, targetW * scale), bin);
        const res = await ocr(prepared, { tessedit_pageseg_mode: psm, tessedit_char_whitelist: '' });
        rawText = rawText || res.text;
        if (location.hash === '#debug') (window.__rcDebug = window.__rcDebug || []).push({ img: prepared.toDataURL(), text: res.text, region: { sx, sy, sw, sh } });
        const words = res.lines.flatMap((l) => l.words);
        const cands = findRegCandidates(res.text);
        const whole = cleanReg(res.text);
        if (!cands.length && isValidReg(whole) && !NI_RE.test(whole)) cands.push({ reg: whole, corrections: 0, raw: whole });
        for (const c of cands) {
          const regChars = cleanReg(c.raw);
          const ws = words.filter((w) => { const t = cleanReg(w.text); return t.length >= 2 && regChars.includes(t); });
          const conf = Math.round(ws.length ? Math.min(...ws.map((w) => w.confidence)) : (res.lines[0] ? res.lines[0].confidence : 0));
          all.push({ reg: c.reg, conf, corrections: c.corrections, inDiary: diaryRegs.has(c.reg), current: CURRENT_RE.test(c.reg), possible: !impossibleCurrent(c.reg) });
        }
        if (all.some((c) => c.inDiary && c.conf >= S.settings.threshold && !c.corrections)) break;
      }
      all.sort((a, b) => (b.inDiary - a.inDiary) || (b.possible - a.possible) || (b.current - a.current) || (b.conf - a.conf));
      const best = all[0] ? { reg: formatReg(all[0].reg), conf: all[0].conf, corrections: all[0].corrections } : null;
      if (!best) {
        $('#scanMsg').textContent = 'Could not read a registration' + (rawText.trim() ? ' (read "' + rawText.trim().slice(0, 20) + '")' : '') + '. Move closer, avoid glare, or use "Type it".';
        return;
      }
      startResult({ reg: best.reg, conf: best.conf, corrections: best.corrections, method: 'camera', thumb });
    } catch (e) {
      $('#scanMsg').textContent = e.message || 'The plate could not be read.';
    } finally {
      onProgress = null;
      S.busy = false;
      btn.disabled = false; btn.textContent = 'Read plate';
    }
  }

  function checkTyped() {
    const v = cleanReg($('#typedReg').value);
    if (!v) { toast('Type a registration first.', true); return; }
    if (!isValidReg(v)) toast('Not a standard UK format. Checking it anyway.', true);
    startResult({ reg: formatReg(v), conf: 100, corrections: 0, method: 'typed' });
  }

  /* ---------- Result ---------- */
  const KIND = {
    ok: { cls: 'k-ok', word: 'OK TO RELEASE', icon: '✓', badge: 'b-ok' },
    stop: { cls: 'k-stop', word: 'DO NOT RELEASE', icon: '✕', badge: 'b-stop' },
    check: { cls: 'k-check', word: 'MANUAL CHECK', icon: '!', badge: 'b-check' },
    released: { cls: 'k-released', word: 'ALREADY RELEASED', icon: '■', badge: 'b-released' }
  };
  const METHOD = { camera: 'Camera read', typed: 'Typed by operator', eye: 'Confirmed by eye' };

  function resultNote(r) {
    if (r.kind === 'ok') return 'Registration matched today’s diary';
    if (r.kind === 'released') return 'Already released at ' + r.released.at + ' by ' + r.released.by;
    if (r.reason === 'vin') return 'VIN mismatch: scanned ' + r.vin.value + ', diary ' + r.entry.vin6;
    if (r.reason === 'near') return 'No exact match; diary has ' + r.near.join(', ');
    if (r.reason === 'low') return 'Read confidence ' + r.scan.conf + '%' + (r.scan.corrections ? ', characters corrected' : '');
    return 'Not in today’s diary';
  }

  function startResult(scan) {
    const ev = evaluateScan(scan, S.diary.entries, S.released.items, S.settings.threshold);
    const r = Object.assign({ scan, at: nowHM(), collector: false, vinEye: false }, ev);
    r.vin = { status: 'na' };
    if (r.kind === 'ok') {
      if (!S.settings.requireVin) r.vin.status = 'notrequired';
      else r.vin.status = r.entry.vin6 ? 'pending' : 'unavailable';
    }
    S.result = r;
    const mode = S.settings.photoMode;
    r.photoSaved = !!scan.thumb && shouldSavePhoto(mode, r.kind, false);
    logEvent(KIND[r.kind].word, scan.reg, resultNote(r) + ' · ' + METHOD[scan.method] + (scan.method === 'camera' ? ' ' + scan.conf + '%' : ''),
      { conf: scan.conf, method: scan.method, photoMode: mode, photoTaken: !!scan.thumb, photoSaved: r.photoSaved, thumb: r.photoSaved ? scan.thumb : undefined });
    if (navigator.vibrate) navigator.vibrate(r.kind === 'ok' ? 80 : [120, 80, 120]);
    show('result');
  }

  function canHandOver(r) {
    if (!r.collector) return false;
    const v = r.vin.status;
    return v === 'pass' || v === 'notrequired' || (v === 'unavailable' && r.vinEye);
  }

  function renderResult() {
    const r = S.result;
    if (!r) { show('scan'); return; }
    const k = KIND[r.kind];
    const e = r.entry;
    let msg = '';
    if (r.kind === 'ok') msg = r.vin.status === 'pass' || r.vin.status === 'notrequired' ? 'Matched with today’s Daily Diary' + (r.entry.time ? ' (collection ' + r.entry.time + ')' : '') + '. Verify the collector before handing over the keys.' : 'Registration matched. Check the VIN before handing over.';
    else if (r.kind === 'released') msg = `This vehicle was handed over at ${r.released.at} by ${r.released.by}. Do not release it again.`;
    else if (r.reason === 'vin') msg = 'Plate and VIN do not belong to the same booking. Possible wrong or swapped plate.';
    else if (r.reason === 'near' && r.impossible) msg = r.scan.reg + ' cannot be a real UK plate (I and Q are never used in the last three letters; I, Q and Z never in the first two), so it was misread. Closest on today\u2019s diary: ' + r.near.join(', ') + '. Check the plate by eye.';
    else if (r.reason === 'near') msg = 'No exact match. Check the plate by eye: it may have been misread.';
    else if (r.reason === 'low') msg = `Read confidence is below ${S.settings.threshold}%. Check the plate by eye.`;
    else msg = 'Registration not found in today’s Daily Diary. Verify the booking or contact a supervisor.'
      + (r.scan.method === 'camera' && r.scan.conf < S.settings.threshold ? ' The read was unclear: scan again or type the registration to be sure.' : '');

    const checks = [];
    if (e) checks.push(['pass', 'Registration in today’s diary', e.reg]);
    else if (r.reason === 'near') checks.push(['warn', 'Registration in today’s diary', 'Close to ' + r.near.join(', ')]);
    else checks.push(['fail', 'Registration in today’s diary', 'No matching entry']);
    if (r.scan.method === 'camera') checks.push([r.scan.conf >= S.settings.threshold && !r.scan.corrections ? 'pass' : 'warn', 'Plate read confidence', r.scan.conf + '% (threshold ' + S.settings.threshold + '%)' + (r.scan.corrections ? ', characters corrected' : '')]);
    else checks.push(['na', 'How it was checked', METHOD[r.scan.method]]);
    if (e) checks.push(r.kind === 'released' ? ['fail', 'Not already released', 'Released ' + r.released.at + ' by ' + r.released.by] : ['pass', 'Not already released', 'No handover recorded']);
    const vinRow = {
      pass: ['pass', 'VIN last 6 characters', r.vin.value + ' matches booking'],
      fail: ['fail', 'VIN last 6 characters', 'Scanned ' + r.vin.value + ', diary ' + (e && e.vin6)],
      pending: ['warn', 'VIN last 6 characters', 'Not checked yet'],
      unavailable: ['warn', 'VIN last 6 characters', 'No VIN on the diary for this booking'],
      notrequired: ['na', 'VIN last 6 characters', 'Not required (Settings)']
    }[r.vin.status];
    if (vinRow && r.vin.status !== 'notrequired') checks.push(vinRow);
    const sym = { pass: '✓', fail: '✕', warn: '!', na: '–' };

    let html = `<div class="result-banner ${k.cls}" role="alert">
        <div class="head"><div class="ring" aria-hidden="true" style="font-size:26px;font-weight:800">${k.icon}</div><div class="word">${k.word}</div></div>
        <div>${esc(msg)}</div></div>
      <div class="card stack">
        <div class="row" style="justify-content:space-between;align-items:flex-start"><span class="plate big">${esc(r.scan.reg)}</span>
          ${r.scan.thumb ? `<div><img class="thumb" src="${r.scan.thumb}" alt="Photo of the scanned plate">
            <div class="small" style="margin-top:4px">${r.photoSaved ? 'Saved to audit log' : 'Not saved (Plate photos: ' + esc(PHOTO_MODES[S.settings.photoMode]) + ')'}</div></div>` : ''}</div>
        <div class="details">
          <div><div class="k">Collection time</div><div class="v">${esc((e && e.time) || '—')}</div></div>
          <div><div class="k">Checked</div><div class="v">${esc(r.at)} · ID ${esc(opId())}</div></div>
        </div>
      </div>
      <div class="card checks">${checks.map((c) => `<div class="checkrow"><div class="dot ${c[0]}" aria-hidden="true">${sym[c[0]]}</div>
        <div><div class="l">${esc(c[1])}</div><div class="d">${esc(c[2])}</div></div></div>`).join('')}</div>`;

    if (r.kind === 'ok') {
      if (r.vin.status === 'pending') {
        html += `<button class="btn primary" type="button" data-action="go-vin">Check VIN</button>`;
      }
      if (r.vin.status === 'unavailable') {
        html += `<div class="card"><label class="check"><input type="checkbox" data-action="vin-eye" ${r.vinEye ? 'checked' : ''}>
          <span>No VIN on the diary. I have checked the VIN by eye against the booking paperwork.</span></label></div>`;
      }
      html += `<div class="card"><label class="check"><input type="checkbox" data-action="collector" ${r.collector ? 'checked' : ''}>
          <span>Collector’s booking and photo ID checked.</span></label></div>
        <button class="btn go" type="button" data-action="handover" ${canHandOver(r) ? '' : 'disabled'}>Confirm handover</button>
        <button class="btn" type="button" data-action="go-scan">Cancel</button>`;
    } else if (r.kind === 'check') {
      const options = r.reason === 'near' ? r.near : [r.scan.reg];
      html += options.map((reg) => `<button class="btn primary" type="button" data-action="eye-confirm" data-reg="${esc(reg)}">Checked by eye: plate is ${esc(reg)}</button>`).join('');
      html += `<button class="btn dark" type="button" data-action="go-override">Request supervisor override</button>
        <button class="btn" type="button" data-action="go-scan">Scan again</button>`;
    } else if (r.kind === 'stop') {
      html += `<button class="btn dark" type="button" data-action="go-override">Contact supervisor</button>
        <button class="btn" type="button" data-action="go-scan">Scan again</button>`;
    } else {
      html += `<button class="btn primary" type="button" data-action="go-scan">Scan another vehicle</button>
        <button class="btn" type="button" data-action="go-audit">View audit log</button>`;
    }
    $('#resultBody').innerHTML = html;
  }

  function verifyVin(last6, how, full) {
    const r = S.result;
    if (!r || !r.entry) return;
    const v = cleanReg(last6).slice(-6);
    if (v.length !== 6) { toast('Enter all 6 characters.', true); return; }
    r.vin.value = v;
    if (v === cleanReg(r.entry.vin6)) {
      r.vin.status = 'pass';
      logEvent('VIN VERIFIED', r.scan.reg, 'VIN ' + (full || '…' + v) + ' matches booking · ' + how);
    } else {
      r.vin.status = 'fail';
      r.kind = 'stop'; r.reason = 'vin';
      logEvent('DO NOT RELEASE', r.scan.reg, resultNote(r) + ' · ' + how);
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
    }
    show('result');
  }

  /* ---------- VIN barcode ---------- */
  let vinTimer = null;
  function stopVinLoop() { if (vinTimer) { clearInterval(vinTimer); vinTimer = null; } }
  async function enterVin() {
    if (!S.result || !S.result.entry) { show('home'); return; }
    $('#vinTyped').value = '';
    const msg = $('#vinMsg');
    msg.textContent = 'Point the camera at the VIN barcode on the door pillar or windscreen label.';
    try { await startCamera($('#vinVideo')); }
    catch (e) { msg.textContent = cameraError(e) + ' Type the last 6 characters instead.'; return; }
    if (!('BarcodeDetector' in window)) { msg.textContent = 'This phone’s browser cannot read barcodes. Type the last 6 characters of the VIN.'; return; }
    let formats = [];
    try { formats = await BarcodeDetector.getSupportedFormats(); } catch (e) { /* ignore */ }
    const want = ['code_39', 'code_128', 'data_matrix', 'qr_code', 'pdf417'].filter((f) => formats.includes(f));
    if (!want.length) { msg.textContent = 'Barcode reading is not available. Type the last 6 characters of the VIN.'; return; }
    const detector = new BarcodeDetector({ formats: want });
    const video = $('#vinVideo');
    let busy = false;
    vinTimer = setInterval(async () => {
      if (busy || video.readyState < 2 || S.screen !== 'vin') return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        for (const c of codes) {
          const vin = extractVin(c.rawValue);
          if (vin) { stopVinLoop(); if (navigator.vibrate) navigator.vibrate(60); verifyVin(vin.slice(-6), 'barcode', vin); return; }
        }
      } catch (e) { /* keep trying */ }
      busy = false;
    }, 300);
  }

  /* ---------- Handover ---------- */
  function handover() {
    const r = S.result;
    if (!r || r.kind !== 'ok' || !canHandOver(r)) return;
    const vinTxt = { pass: 'VIN verified', notrequired: 'VIN not required', unavailable: 'VIN checked by eye (not on diary)' }[r.vin.status];
    markReleased(r.entry.reg, 'handover');
    logEvent('HANDOVER', r.entry.reg, 'Collector verified · collection ' + (r.entry.time || 'no time') + (r.vin.status === 'notrequired' ? '' : ' · ' + vinTxt));
    S.result = null;
    toast('Handover recorded for ' + r.entry.reg);
    show('home');
  }

  /* ---------- Override ---------- */
  const REASONS = ['Late booking, not on the printed diary', 'Plate damaged or unreadable, VIN checked by eye', 'Diary misprint, booking confirmed in the system', 'Other (written on the paper diary)'];
  function renderOverride() {
    const r = S.result;
    if (!r) { show('home'); return; }
    $('#overrideBody').innerHTML = `<div class="card stack">
        <div class="row"><span class="plate">${esc(r.scan.reg)}</span><span class="badge ${KIND[r.kind].badge}">${KIND[r.kind].word}</span></div>
        <p class="small">Only a supervisor can release a vehicle the app has not cleared. Their supervisor ID and reason are written to the audit log.</p></div>
      <fieldset class="stack" style="border:0;margin:0;padding:0">
        <legend style="font-weight:700;margin-bottom:8px">Reason for override</legend>
        ${REASONS.map((t, i) => `<label class="reason"><input type="radio" name="reason" value="${i}"> ${esc(t)}</label>`).join('')}
      </fieldset>
      <label for="supId">Supervisor ID</label>
      <input id="supId" class="plate-input" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12" placeholder="e.g. S0417">
      <label class="check"><input id="supConfirm" type="checkbox"> <span>I am the supervisor with this ID and I authorise this release.</span></label>
      <button class="btn dark" type="button" data-action="authorise">Authorise release</button>
      <button class="btn" type="button" data-action="go-result">Cancel</button>`;
  }
  function authorise() {
    const r = S.result;
    const sel = document.querySelector('input[name=reason]:checked');
    const sup = normOperatorId($('#supId').value);
    if (!sel || !sup || !$('#supConfirm').checked) { toast('Choose a reason, enter a valid supervisor ID (2–12 letters or digits) and tick to confirm.', true); return; }
    if (sup === opId()) { toast('The supervisor ID must be different from your operator ID.', true); return; }
    markReleased(r.scan.reg, 'override');
    const mode = S.settings.photoMode;
    const keep = !!r.scan.thumb && shouldSavePhoto(mode, r.kind, true);
    logEvent('OVERRIDE', r.scan.reg, REASONS[+sel.value] + ' · authorised by supervisor ' + sup + ' · was ' + KIND[r.kind].word,
      { supervisorId: sup, photoMode: mode, photoTaken: !!r.scan.thumb, photoSaved: keep, thumb: keep ? r.scan.thumb : undefined });
    S.result = null;
    toast('Override recorded for ' + r.scan.reg);
    show('home');
  }

  /* ---------- Audit ---------- */
  function badgeFor(result) {
    return { 'OK TO RELEASE': 'b-ok', 'DO NOT RELEASE': 'b-stop', 'MANUAL CHECK': 'b-check', 'ALREADY RELEASED': 'b-released', HANDOVER: 'b-handover', OVERRIDE: 'b-override' }[result] || 'b-info';
  }
  // How a log entry's plate photo was handled, for reviewers.
  function photoText(l) {
    if (!l.photoMode) return '';
    const m = 'Photos: ' + (PHOTO_MODES[l.photoMode] || l.photoMode);
    if (typeof l.photoSaved !== 'boolean') return m;
    if (!l.photoTaken) return m + ' (no photo: not a camera read)';
    return m + (l.photoSaved ? ' (saved)' : ' (not saved)');
  }
  function renderAudit() {
    const items = S.log.slice().reverse();
    let html = `<div class="card stack"><p class="small">Every check, handover and override is stored on this phone with time and operator ID. Plate photos are kept according to the Plate photos setting (now: <b>${esc(PHOTO_MODES[S.settings.photoMode])}</b>). Export before clearing.</p>
      <div class="grid2"><button class="btn" type="button" data-action="export">Export CSV</button>
      <button class="btn danger" type="button" data-action="clear-log">Clear log</button></div></div>`;
    if (!items.length) html += '<p class="center muted">No entries yet.</p>';
    for (const l of items) {
      html += `<div class="log"><div class="t">${esc(l.time)}</div><div class="b">
        <div class="row" style="flex-wrap:wrap;gap:8px">${l.reg ? `<b class="mono">${esc(l.reg)}</b>` : ''}<span class="badge ${badgeFor(l.result)}">${esc(l.result)}</span></div>
        <div class="note">${esc(l.note)}</div><div class="by">${l.operatorId ? 'ID ' + esc(l.operatorId) : esc(l.operator || '')} · ${esc(l.ts.slice(0, 10))}${photoText(l) ? ' · ' + esc(photoText(l)) : ''}</div></div>
        ${l.thumb ? `<img src="${l.thumb}" alt="Plate photo">` : ''}</div>`;
    }
    $('#auditBody').innerHTML = html;
  }
  function exportCsv() {
    const head = ['timestamp', 'operator_id', 'registration', 'result', 'detail', 'confidence', 'method', 'supervisor_id', 'photo_mode', 'photo_saved'];
    const rows = S.log.map((l) => [l.ts, l.operatorId || l.operator || '', l.reg, l.result, l.note, l.conf == null ? '' : l.conf, l.method || '',
      l.supervisorId || l.supervisor || '', l.photoMode ? PHOTO_MODES[l.photoMode] || l.photoMode : '', typeof l.photoSaved !== 'boolean' ? '' : !l.photoTaken ? 'no photo taken' : l.photoSaved ? 'yes' : 'no'].map(csvCell).join(','));
    const blob = new Blob(['﻿' + head.join(',') + '\r\n' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'release-check-audit-' + todayISO() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    logEvent('EXPORT', '', S.log.length + ' entries exported');
  }

  /* ---------- Settings ---------- */
  function renderSettings() {
    const s = S.settings;
    $('#settingsBody').innerHTML = `<div class="card stack">
        <label for="setId">Operator ID</label><input id="setId" class="plate-input" type="text" value="${esc(s.operatorId)}" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="12">
        <p class="small">Your staff or badge number. Names are not stored.</p>
        <label for="setThr">Read confidence threshold (%)</label><input id="setThr" type="number" min="50" max="99" value="${s.threshold}">
        <p class="small">Camera reads below this are sent to Manual check, and diary rows below it are flagged.</p>
        <div class="grid2">
          <label>Site opens<input id="setOpen" type="text" inputmode="decimal" placeholder="HH:MM" maxlength="5" value="${esc(s.siteOpen)}"></label>
          <label>Site closes<input id="setClose" type="text" inputmode="decimal" placeholder="HH:MM" maxlength="5" value="${esc(s.siteClose)}"></label>
        </div>
        <p class="small">Diary times outside these hours are flagged for checking.</p>
        <fieldset class="stack" style="border:0;margin:0;padding:0">
          <legend style="font-weight:700;margin-bottom:6px">Plate photos</legend>
          ${Object.keys(PHOTO_MODES).map((k) => `<label class="reason"><input type="radio" name="photoMode" value="${k}" ${s.photoMode === k ? 'checked' : ''}>
            <span>${esc(PHOTO_MODES[k])}${k === 'exceptions' ? ' (default)' : ''}<br><span class="small">${{ all: 'A photo of the plate is saved with every scan.', exceptions: 'Saved only for DO NOT RELEASE, MANUAL CHECK, ALREADY RELEASED and supervisor overrides.', off: 'No plate photos are saved. Scanning still works.' }[k]}</span></span></label>`).join('')}
          <p class="small">Every change to this setting is recorded in the audit log.</p>
        </fieldset>
        <button class="btn primary" type="button" data-action="save-settings">Save</button>
      </div>
      <div class="card stack"><b>Data on this phone</b>
        <p class="small">Diary: ${S.diary ? esc(S.diary.date) + ', ' + S.diary.entries.length + ' vehicles' : 'none'} · Audit log: ${S.log.length} entries</p>
        <button class="btn danger" type="button" data-action="reset-all">Delete all data on this phone</button>
      </div>
      <p class="small">Release Check proof of concept v1.5: diary capture reads collection time and registration only, up to 3 pages; operator IDs instead of names; plate photo setting. Text reading: Tesseract.js (runs on the phone). Nothing is uploaded.</p>`;
  }

  /* ---------- Actions ---------- */
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const r = S.result;
    switch (a) {
      case 'capture-diary': S.captureMode = 'new'; $('#diaryCamera').click(); break;
      case 'pick-diary': S.captureMode = 'new'; $('#diaryPick').click(); break;
      case 'recapture':
        if (confirm('Start a new diary? This replaces today’s list. Vehicles already released stay released.')) { S.captureMode = 'new'; $('#diaryCamera').click(); }
        break;
      case 'add-page': S.captureMode = 'append'; $('#diaryCamera').click(); break;
      case 'add-page-pick': S.captureMode = 'append'; $('#diaryPick').click(); break;
      case 'add-page-home': {
        // Reopen the locked list as a draft; locked rows stay as they are, the new page is added.
        const d = S.diary;
        S.draft = {
          entries: d.entries.map((e) => Object.assign({ id: uid(), carried: true, confirmed: false, page: e.page || 1, timeConf: e.timeConf == null ? 100 : e.timeConf }, e)),
          pages: d.pages || 1, raw: new Array(d.pages || 1).fill(''), checkedAll: false, source: d.source || 'photo'
        };
        S.captureMode = 'append';
        $('#diaryCamera').click();
        break;
      }
      case 'del-page':
        if (S.draft && S.draft.pages > 1) {
          const p = S.draft.pages;
          S.draft.entries = S.draft.entries.filter((e) => e.page !== p);
          S.draft.pages = p - 1; S.draft.raw.pop(); renderReview();
        }
        break;
      case 'sample-diary':
        S.draft = { entries: SAMPLE.map((e, i) => Object.assign({ id: uid(), page: 1, conf: i === 4 ? 71 : 97 + (i % 3), timeConf: 95, corrected: false, confirmed: false, edited: false }, e)), pages: 1, raw: [''], checkedAll: false, source: 'sample' };
        show('review'); break;
      case 'del-entry': S.draft.entries = S.draft.entries.filter((e) => e.id !== el.dataset.id); renderReview(); break;
      case 'add-entry': S.draft.entries.push({ id: uid(), page: S.draft.pages, reg: '', time: '', conf: 100, timeConf: 100, manual: true, confirmed: false }); renderReview(); break;
      case 'lock': lockDiary(); break;
      case 'go-scan': S.result = null; show('scan'); break;
      case 'go-audit': show('audit'); break;
      case 'go-vin': show('vin'); break;
      case 'go-override': show('override'); break;
      case 'go-result': show('result'); break;
      case 'scan-mode': setScanMode(el.dataset.mode); break;
      case 'read-plate': readPlate(); break;
      case 'check-typed': checkTyped(); break;
      case 'vin-typed': stopVinLoop(); verifyVin($('#vinTyped').value, 'typed'); break;
      case 'eye-confirm':
        logEvent('MANUAL CONFIRM', el.dataset.reg, 'Operator checked the plate by eye (camera read ' + r.scan.reg + ' at ' + r.scan.conf + '%)');
        startResult({ reg: el.dataset.reg, conf: 100, corrections: 0, method: 'eye', thumb: r.scan.thumb });
        break;
      case 'handover': handover(); break;
      case 'authorise': authorise(); break;
      case 'export': exportCsv(); renderAudit(); break;
      case 'clear-log':
        if (confirm('Delete all ' + S.log.length + ' audit entries from this phone? Export first if you need them.')) { S.log = []; save.log(); renderAudit(); }
        break;
      case 'save-settings': {
        const id = normOperatorId($('#setId').value);
        const thr = Math.max(50, Math.min(99, parseInt($('#setThr').value, 10) || 85));
        if (!id) { toast('Enter an operator ID: 2–12 letters, digits or hyphens.', true); return; }
        const pmEl = document.querySelector('input[name=photoMode]:checked');
        const pm = pmEl ? pmEl.value : S.settings.photoMode;
        const so = normTime($('#setOpen').value), sc = normTime($('#setClose').value);
        if (!so || !sc || toMin(so) >= toMin(sc)) { toast('Enter site hours as HH:MM, with opening before closing.', true); return; }
        const before = Object.assign({}, S.settings);
        Object.assign(S.settings, { operatorId: id, threshold: thr, siteOpen: so, siteClose: sc, photoMode: pm });
        save.settings();
        const changes = [];
        if (before.photoMode !== pm) changes.push('Plate photos: ' + PHOTO_MODES[before.photoMode] + ' → ' + PHOTO_MODES[pm]);
        if (before.operatorId !== id) changes.push('Operator ID: ' + before.operatorId + ' → ' + id);
        if (before.threshold !== thr) changes.push('Confidence threshold: ' + before.threshold + '% → ' + thr + '%');
        if (before.siteOpen !== so || before.siteClose !== sc) changes.push('Site hours: ' + before.siteOpen + '–' + before.siteClose + ' → ' + so + '–' + sc);
        if (changes.length) logEvent('SETTINGS CHANGED', '', changes.join(' · '), { photoMode: pm });
        toast('Settings saved'); show('home'); break;
      }
      case 'reset-all':
        if (confirm('Delete the diary, release records, audit log and settings from this phone?')) {
          ['settings', 'diary', 'released', 'log'].forEach((k) => localStorage.removeItem('rc.' + k));
          location.reload();
        }
        break;
      default: break;
    }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    const a = el.dataset && el.dataset.action;
    if (a === 'confirm-entry') { const e = S.draft.entries.find((x) => x.id === el.dataset.id); if (e) e.confirmed = el.checked; renderReview(); }
    if (a === 'checked-all') { S.draft.checkedAll = el.checked; renderReview(); }
    if (a === 'collector' && S.result) { S.result.collector = el.checked; renderResult(); }
    if (a === 'vin-eye' && S.result) { S.result.vinEye = el.checked; renderResult(); }
  });
  $('#typedReg').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkTyped(); });
  $('#vinTyped').addEventListener('keydown', (e) => { if (e.key === 'Enter') { stopVinLoop(); verifyVin($('#vinTyped').value, 'typed'); } });

  $('#setupSave').addEventListener('click', () => {
    const id = normOperatorId($('#setupName').value);
    if (!id) { toast('Enter your operator ID: 2–12 letters, digits or hyphens.', true); return; }
    S.settings.operatorId = id; save.settings();
    logEvent('SETTINGS CHANGED', '', 'Operator ID set to ' + id + ' · Plate photos: ' + PHOTO_MODES[S.settings.photoMode], { photoMode: S.settings.photoMode });
    show('home');
  });

  /* ---------- Start ---------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (!window.isSecureContext) toast('Open this app over https, or the camera will not work.', true);
  show(opId() ? 'home' : 'setup');
  // Warm up the text reader in the background once a diary is loaded.
  if (S.diary && window.Tesseract) setTimeout(() => getWorker().catch(() => {}), 1500);
})();
