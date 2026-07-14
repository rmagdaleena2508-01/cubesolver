import { CubeView, PALETTE, invert } from './cube3d.js?v=2';

/* ───────────────── helpers ───────────────── */
const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
};
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/* ───────────────── solver worker RPC ───────────────── */
const chip = $('solver-chip');
const setChip = (state, text) => {
  chip.innerHTML = `<span class="chip-dot ${state}"></span>${text}`;
};

let worker = null;
let solverReady = null;

const rpc = (type, payload) => new Promise((res, rej) => {
  const w = worker;
  const id = Math.random().toString(36).slice(2);
  const onMsg = (e) => {
    if (e.data.id !== id) return;
    w.removeEventListener('message', onMsg);
    e.data.error ? rej(new Error(e.data.error)) : res(e.data.result);
  };
  w.addEventListener('message', onMsg);
  w.postMessage({ id, type, payload });
});

// (Re)spawn the solver worker — also used to recover if a solve ever hangs.
function spawnWorker() {
  worker = new Worker('worker.js?v=2');
  setChip('warming', 'solver: warming up…');
  solverReady = rpc('init')
    .then(() => setChip('', 'solver: ready'))
    .catch((e) => { setChip('err', 'solver: failed'); throw e; });
  solverReady.catch(() => {});
}
spawnWorker();

/* ───────────────── color science ───────────────── */
function rgb2lab([r, g, b]) {
  let [x, y, z] = [r, g, b].map((v) => {
    v /= 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  });
  const X = (x * 0.4124 + y * 0.3576 + z * 0.1805) / 0.95047;
  const Y = (x * 0.2126 + y * 0.7152 + z * 0.0722) / 1.0;
  const Z = (x * 0.0193 + y * 0.1192 + z * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// Weighted Lab distance: lightness is de-weighted because webcam auto-exposure
// shifts L a lot between captures; hue/chroma (a, b) carry the real signal.
const wdist = (a, b) => Math.hypot((a[0] - b[0]) * 0.6, a[1] - b[1], a[2] - b[2]);

/* ───────────────── scan flow ───────────────── */
// Scan order + holding instructions. Row-major sampling of the raw camera
// frame matches the Kociemba facelet order for each face when held this way.
const SCAN_STEPS = [
  { letter: 'F', face: 'GREEN',  hold: 'WHITE on top' },
  { letter: 'R', face: 'RED',    hold: 'WHITE on top' },
  { letter: 'B', face: 'BLUE',   hold: 'WHITE on top' },
  { letter: 'L', face: 'ORANGE', hold: 'WHITE on top' },
  { letter: 'U', face: 'WHITE',  hold: 'tip the cube toward you — GREEN faces the floor' },
  { letter: 'D', face: 'YELLOW', hold: 'tip the cube away — GREEN faces the ceiling' },
];
const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];
const CYCLE = ['U', 'R', 'F', 'D', 'L', 'B']; // tap-cycle order in review

let stream = null;
let scanIdx = 0;
let captured = {};   // letter → [ [r,g,b] ×9 ]
let letters = {};    // letter → [ face-letter ×9 ]
let uncertain = {};  // letter → [ bool ×9 ] — low-confidence classifications
let capBusy = false;
let liveTimer = null;

const video = $('cam');

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
  });
  video.srcObject = stream;
  await video.play();
  // Mirror the preview for front/user cameras (laptops) — sampling always
  // reads the raw frame, which is already the "outside viewer" orientation.
  const facing = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  video.classList.toggle('mirror', facing !== 'environment');
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function updateScanUI() {
  const s = SCAN_STEPS[scanIdx];
  $('scan-step').textContent = `${scanIdx + 1} / 6`;
  const sw = (name) => {
    const map = { GREEN: '--cF', RED: '--cR', BLUE: '--cB', ORANGE: '--cL', WHITE: '--cU', YELLOW: '--cD' };
    return `<span class="swatch" style="background:var(${map[name]})"></span><b>${name}</b>`;
  };
  let hold = s.hold;
  ['WHITE', 'GREEN'].forEach((n) => { hold = hold.replace(n, sw(n)); });
  $('scan-instr').innerHTML = `Show the ${sw(s.face)} center to the camera · ${hold}`;
  $('btn-retake').disabled = scanIdx === 0;
}

// One frame → 9 per-cell colors. Median (not mean) per channel, so glare
// speckles and plastic edges caught in a patch don't skew the reading.
function sampleFrame() {
  const c = $('sample-canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const S = Math.min(c.width, c.height) * 0.62; // matches the on-screen grid
  const x0 = (c.width - S) / 2, y0 = (c.height - S) / 2;
  const cell = S / 3, patch = Math.max(8, Math.round(cell * 0.36));
  const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const out = [];
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
    const cx = x0 + col * cell + cell / 2, cy = y0 + r * cell + cell / 2;
    const d = ctx.getImageData(cx - patch / 2, cy - patch / 2, patch, patch).data;
    const rs = [], gs = [], bs = [];
    for (let i = 0; i < d.length; i += 4) { rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }
    out.push([med(rs), med(gs), med(bs)]);
  }
  return out;
}

// Capture = median across 3 frames (~140ms) — steadies auto-exposure flicker.
async function sampleFace() {
  const frames = [];
  for (let f = 0; f < 3; f++) {
    frames.push(sampleFrame());
    if (f < 2) await new Promise((r) => setTimeout(r, 70));
  }
  return Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].map((ch) => {
      const v = [frames[0][i][ch], frames[1][i][ch], frames[2][i][ch]].sort((a, b) => a - b);
      return v[1];
    })
  );
}

// Live readout: tint each grid cell's border with what the camera reads there,
// so glare and bad lighting are visible *before* you capture.
function startLive() {
  stopLive();
  liveTimer = setInterval(() => {
    if (!stream || !video.videoWidth) return;
    try {
      const s = sampleFrame();
      document.querySelectorAll('#cam-grid i').forEach((el, i) => {
        el.style.borderColor = `rgb(${s[i].map(Math.round).join(',')})`;
        el.style.borderStyle = 'solid';
      });
    } catch { /* frame not ready */ }
  }, 250);
}
function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
}

function renderThumbs() {
  const t = $('thumbs');
  t.innerHTML = '';
  SCAN_STEPS.slice(0, scanIdx).forEach((s) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    captured[s.letter].forEach((rgb) => {
      const i = document.createElement('i');
      i.style.background = `rgb(${rgb.map(Math.round).join(',')})`;
      d.appendChild(i);
    });
    t.appendChild(d);
  });
}

// Greedy min-cost assignment with a capacity of 9 stickers per color class.
// `pinned` (item index → class) pre-assigns the 6 center stickers.
function balancedAssign(items, cents, pinned) {
  const cap = Array(cents.length).fill(9);
  const out = Array(items.length).fill(-1);
  for (const [idx, k] of pinned) { out[idx] = k; cap[k]--; }
  const edges = [];
  items.forEach((it, i) => {
    if (out[i] >= 0) return;
    cents.forEach((c, k) => edges.push([wdist(it.lab, c), i, k]));
  });
  edges.sort((a, b) => a[0] - b[0]);
  let left = items.length - pinned.size;
  for (const [, i, k] of edges) {
    if (!left) break;
    if (out[i] >= 0 || !cap[k]) continue;
    out[i] = k; cap[k]--; left--;
  }
  return out;
}

// Joint classification of all 54 stickers. A cube has exactly 9 of each color,
// so instead of matching stickers independently (fragile under glare and warm
// light), we solve a balanced assignment seeded by the 6 captured centers and
// refine the class centroids with two more balanced passes.
function classify() {
  const items = [];
  SCAN_STEPS.forEach((s) =>
    captured[s.letter].forEach((rgb, i) => items.push({ f: s.letter, i, lab: rgb2lab(rgb) }))
  );
  const pinned = new Map();
  items.forEach((it, idx) => {
    if (it.i === 4) pinned.set(idx, SCAN_STEPS.findIndex((s) => s.letter === it.f));
  });

  let cents = SCAN_STEPS.map((s) => rgb2lab(captured[s.letter][4]));
  let assign = null;
  for (let iter = 0; iter < 3; iter++) {
    assign = balancedAssign(items, cents, pinned);
    cents = cents.map((c, k) => {
      const members = items.filter((_, idx) => assign[idx] === k);
      if (!members.length) return c;
      const sum = members.reduce(
        (a, it) => [a[0] + it.lab[0], a[1] + it.lab[1], a[2] + it.lab[2]], [0, 0, 0]
      );
      return sum.map((v) => v / members.length);
    });
  }

  letters = {}; uncertain = {};
  SCAN_STEPS.forEach((s) => {
    letters[s.letter] = Array(9);
    uncertain[s.letter] = Array(9).fill(false);
  });
  items.forEach((it, idx) => {
    const k = assign[idx];
    letters[it.f][it.i] = SCAN_STEPS[k].letter;
    if (it.i !== 4) {
      const d1 = wdist(it.lab, cents[k]);
      let d2 = Infinity;
      cents.forEach((c, j) => { if (j !== k) d2 = Math.min(d2, wdist(it.lab, c)); });
      // close call, or far from every class → flag for human review
      uncertain[it.f][it.i] = d2 - d1 < 7 || d1 > 30;
    }
  });
}

/* ───────────────── review ───────────────── */
const NET_ORIGIN = { U: [1, 4], L: [4, 1], F: [4, 4], R: [4, 7], B: [4, 10], D: [7, 4] };

function renderNet() {
  const net = $('net');
  net.innerHTML = '';
  for (const f of FACE_ORDER) {
    const [gr, gc] = NET_ORIGIN[f];
    letters[f].forEach((letter, i) => {
      const b = document.createElement('button');
      const r = (i / 3) | 0, c = i % 3;
      b.style.gridRow = gr + r;
      b.style.gridColumn = gc + c;
      b.style.background = hex(PALETTE[letter]);
      b.dataset.face = f;
      b.dataset.i = i;
      b.dataset.testid = `cell-${f}${i}`;
      if (uncertain[f]?.[i]) b.classList.add('warn');
      if (i === 4) b.disabled = true;
      else b.addEventListener('click', () => {
        const cur = letters[f][i];
        const next = CYCLE[(CYCLE.indexOf(cur) + 1) % 6];
        letters[f][i] = next;
        b.style.background = hex(PALETTE[next]);
        b.classList.remove('warn'); // human decided — trust them
        renderCounts();
      });
      net.appendChild(b);
    });
  }
  renderCounts();
}

function renderCounts() {
  const counts = Object.fromEntries(FACE_ORDER.map((f) => [f, 0]));
  for (const f of FACE_ORDER) letters[f].forEach((l) => counts[l]++);
  $('counts').innerHTML = FACE_ORDER.map((f) => {
    const bad = counts[f] !== 9 ? 'bad' : '';
    return `<span class="${bad}"><i style="background:${hex(PALETTE[f])}"></i>${counts[f]}</span>`;
  }).join('');
  $('review-err').hidden = true;
  return FACE_ORDER.every((f) => counts[f] === 9);
}

const faceletString = () =>
  FACE_ORDER.map((f) => letters[f].join('')).join('');

/* ───────────────── solve screen ───────────────── */
let view = null;
let moves = [];
let mi = 0;          // moves applied so far
let busy = false;
let auto = false;
let startFacelets = '';

function fmtMove(m) {
  return `${m.replace('2', '')}${m.includes('2') ? '2' : ''}<span class="deg">${m.includes('2') ? '180°' : '90°'}</span>`;
}

function renderHud() {
  $('mv-count').textContent = `${mi} / ${moves.length}`;
  const label = $('mv-label');
  if (mi >= moves.length) {
    label.classList.add('done');
    label.innerHTML = `Solved in ${moves.length} moves`;
  } else {
    label.classList.remove('done');
    label.innerHTML = fmtMove(moves[mi]);
  }
  const strip = $('mv-strip');
  strip.querySelectorAll('span').forEach((s, i) => {
    s.className = i < mi ? 'done' : i === mi ? 'cur' : '';
  });
  strip.querySelector('.cur')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  $('btn-prev').disabled = busy || mi === 0;
  $('btn-next').disabled = busy || mi >= moves.length;
}

function buildStrip() {
  $('mv-strip').innerHTML = moves.map((m) => `<span>${m}</span>`).join('');
}

async function doNext() {
  if (busy || mi >= moves.length) return;
  busy = true; renderHud();
  await view.turn(moves[mi]);
  mi++; busy = false; renderHud();
  if (mi >= moves.length) stopAuto();
}
async function doPrev() {
  if (busy || mi === 0) return;
  stopAuto();
  busy = true; renderHud();
  mi--;
  await view.turn(invert(moves[mi]));
  busy = false; renderHud();
}
function stopAuto() {
  auto = false;
  $('btn-auto').checked = false;
}
async function autoLoop() {
  while (auto && mi < moves.length) {
    await doNext();
    await new Promise((r) => setTimeout(r, 180));
  }
}

const INVALID_HINTS = {
  pieces: "at least one corner or edge has an impossible color combination — find the cubie that couldn't exist on a real cube",
  twist: 'one corner looks twisted — the three stickers around a single corner are misread',
  flip: 'one edge looks flipped — the two stickers of an edge piece are swapped',
  parity: 'two stickers appear swapped somewhere',
};
const SOLVE_TIMEOUT = 15000;

async function enterSolve(facelets) {
  const btn = $('btn-solve');
  const btnHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Solving…';
  setChipSolving(true);
  try {
    await solverReady;
    const sol = await Promise.race([
      rpc('solve', facelets),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), SOLVE_TIMEOUT)),
    ]);
    moves = sol.split(/\s+/).filter(Boolean);
    setChipSolving(false);
  } catch (err) {
    let msg;
    if (err.message === 'timeout') {
      // Recover the stuck worker with a fresh one (rebuilds tables).
      worker.terminate();
      spawnWorker();
      msg = 'The solver got stuck — that usually means a misread sticker slipped through. Re-check the colors (corners especially), then try again.';
    } else if (err.message.startsWith('invalid:')) {
      msg = `This scan can't be a real cube: ${INVALID_HINTS[err.message.slice(8)] || 'a sticker is misread'}. Tap stickers in the net to fix it, then try again.`;
      setChipSolving(false);
    } else {
      msg = `Solver error (${err.message}). Check the sticker colors and try again.`;
      setChipSolving(false);
    }
    $('review-err').textContent = msg;
    $('review-err').hidden = false;
    btn.disabled = false;
    btn.innerHTML = btnHTML;
    return;
  }
  btn.disabled = false;
  btn.innerHTML = btnHTML;

  startFacelets = facelets;
  mi = 0; busy = false; stopAuto();
  show('s-solve');
  if (!view) view = new CubeView($('c3d'));
  view.setState(facelets);
  buildStrip();
  renderHud();

  try { navigator.wakeLock?.request('screen'); } catch {}
}
function setChipSolving(on) {
  if (on) setChip('warming', 'solver: thinking…');
  else setChip('', 'solver: ready');
}

/* ───────────────── wiring ───────────────── */
$('btn-scan').addEventListener('click', async () => {
  $('home-err').hidden = true;
  try {
    await startCamera();
  } catch (err) {
    $('home-err').textContent =
      `Camera unavailable (${err.name || err.message}). On phones this page must be served over HTTPS. You can still try the demo scramble.`;
    $('home-err').hidden = false;
    return;
  }
  scanIdx = 0; captured = {};
  renderThumbs(); updateScanUI(); startLive();
  show('s-scan');
});

$('btn-capture').addEventListener('click', async () => {
  if (!stream || capBusy) return;
  capBusy = true;
  $('btn-capture').disabled = true;
  try {
    captured[SCAN_STEPS[scanIdx].letter] = await sampleFace();
  } finally {
    capBusy = false;
    $('btn-capture').disabled = false;
  }
  navigator.vibrate?.(30);
  scanIdx++;
  renderThumbs();
  if (scanIdx >= 6) {
    stopLive(); stopCamera();
    classify();
    renderNet();
    show('s-review');
  } else {
    updateScanUI();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && $('s-scan').classList.contains('active')) {
    e.preventDefault();
    $('btn-capture').click();
  }
});

$('btn-retake').addEventListener('click', () => {
  if (scanIdx === 0) return;
  scanIdx--;
  delete captured[SCAN_STEPS[scanIdx].letter];
  renderThumbs(); updateScanUI();
});
$('btn-cancel').addEventListener('click', () => { stopLive(); stopCamera(); show('s-home'); });

$('btn-demo').addEventListener('click', async () => {
  const facelets = await rpc('random');
  letters = {}; uncertain = {};
  FACE_ORDER.forEach((f, fi) => {
    letters[f] = facelets.slice(fi * 9, fi * 9 + 9).split('');
  });
  renderNet();
  show('s-review');
});

$('btn-solve').addEventListener('click', () => {
  if (!renderCounts()) {
    $('review-err').textContent =
      'Each color must appear exactly 9 times — fix the highlighted counts below the net.';
    $('review-err').hidden = false;
    return;
  }
  enterSolve(faceletString());
});
$('btn-rescan').addEventListener('click', () => $('btn-scan').click());

$('btn-next').addEventListener('click', () => { stopAuto(); doNext(); });
$('btn-prev').addEventListener('click', doPrev);
$('btn-auto').addEventListener('change', (e) => {
  auto = e.target.checked;
  if (auto) autoLoop();
});
$('btn-restart').addEventListener('click', () => {
  if (busy) return;
  stopAuto();
  mi = 0;
  view.setState(startFacelets);
  renderHud();
});
$('btn-new').addEventListener('click', () => {
  stopAuto();
  show('s-home');
});

// Dev/debug hook (also handy in the console on your phone).
window.__cubesight = {
  get view() { return view; },
  get moves() { return moves; },
  get mi() { return mi; },
  _test: {
    setCaptured(c) { captured = c; },
    classify,
    solve: (s) => rpc('solve', s),
    get letters() { return letters; },
    get uncertain() { return uncertain; },
  },
};
