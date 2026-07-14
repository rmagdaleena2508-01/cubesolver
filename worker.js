// Solver worker — keeps cubejs' heavy table generation and solving off the UI thread.
importScripts('vendor/cube.js', 'vendor/solve.js');

let ready = false;

// Structural solvability check, using the piece arrays cubejs builds in
// fromString: cp/co = corner permutation/orientation, ep/eo = edges.
// A facelet string can pass the "9 of each color" test and still describe a
// physically impossible cube — which would send the solver searching forever.
function validate(c) {
  const isPerm = (arr, n) => {
    if (!arr || arr.length !== n) return false;
    const seen = new Array(n).fill(false);
    for (const v of arr) {
      if (typeof v !== 'number' || v < 0 || v >= n || seen[v]) return false;
      seen[v] = true;
    }
    return true;
  };
  if (!isPerm(c.cp, 8) || !isPerm(c.ep, 12)) return 'pieces'; // impossible / duplicate cubie
  if (c.co.reduce((a, b) => a + b, 0) % 3 !== 0) return 'twist'; // corner twisted
  if (c.eo.reduce((a, b) => a + b, 0) % 2 !== 0) return 'flip';  // edge flipped
  const parity = (p) => {
    let s = 0;
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) s ^= 1;
    return s;
  };
  if (parity(c.cp) !== parity(c.ep)) return 'parity'; // two pieces swapped
  return null;
}

// Rotate a face's 9 facelets k quarter-turns clockwise (as viewed head-on).
function rotFace(f, k) {
  let a = f.split('');
  k = ((k % 4) + 4) % 4;
  while (k--) {
    const b = a.slice();
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) b[3 * r + c] = a[3 * (2 - c) + r];
    a = b;
  }
  return a.join('');
}

// If every color is right but the U (white) or D (yellow) face was captured
// rotated — the tilt steps are the easy ones to get wrong — the true cube is
// a U/D rotation combo of the scan. Only these two faces are searched, and a
// repair is accepted only if EXACTLY ONE combo validates: both restrictions
// keep a genuine color misread from being silently "repaired" into a valid
// but wrong cube. (Side faces are anchored by "white on top" during capture.)
function repairSearchUD(s54) {
  const uFace = s54.slice(0, 9);        // U is face 0 in URFDLB order
  const dFace = s54.slice(27, 36);      // D is face 3
  const hits = [];
  for (let kU = 0; kU < 4; kU++) for (let kD = 0; kD < 4; kD++) {
    if (!kU && !kD) continue; // identity already failed validation
    const cand =
      rotFace(uFace, kU) + s54.slice(9, 27) + rotFace(dFace, kD) + s54.slice(36);
    try {
      if (!validate(Cube.fromString(cand))) {
        hits.push({ cand, changes: (kU ? 1 : 0) + (kD ? 1 : 0) });
        if (hits.length > 1) return null; // ambiguous → don't guess
      }
    } catch { /* impossible pieces — not a repair */ }
  }
  return hits.length === 1 ? hits[0] : null;
}

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  const reply = (result, error) => self.postMessage({ id, result, error: error || null });

  try {
    if (type === 'init') {
      if (!ready) { Cube.initSolver(); ready = true; }
      reply(true);

    } else if (type === 'random') {
      // Random scramble from solved — always a valid, solvable state.
      const faces = ['U', 'R', 'F', 'D', 'L', 'B'];
      const mods = ['', "'", '2'];
      const moves = [];
      let last = '';
      while (moves.length < 25) {
        const f = faces[(Math.random() * 6) | 0];
        if (f === last) continue;
        last = f;
        moves.push(f + mods[(Math.random() * 3) | 0]);
      }
      const c = new Cube();
      c.move(moves.join(' '));
      reply(c.asString());

    } else if (type === 'solve') {
      if (!ready) { Cube.initSolver(); ready = true; }
      let s = payload, repaired = 0;
      let c = Cube.fromString(s);
      let why = validate(c);

      if (why) {
        // Colors may be right but the white/yellow face captured rotated —
        // try the unique U/D rotation repair before declaring it invalid.
        const fix = repairSearchUD(s);
        if (fix) {
          s = fix.cand; repaired = fix.changes;
          c = Cube.fromString(s); why = null;
        }
      }
      if (why) { reply(null, 'invalid:' + why); return; }

      let sol = c.solve(22); // two-phase, near-optimal (~18–22 moves)
      if (!sol) throw new Error('no solution found');
      reply({ solution: sol.trim(), facelets: s, repaired });
    }
  } catch (err) {
    reply(null, (err && err.message) ? err.message : String(err));
  }
};
