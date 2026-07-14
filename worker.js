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
      const c = Cube.fromString(payload);
      const why = validate(c);
      if (why) { reply(null, 'invalid:' + why); return; }
      const sol = c.solve(22); // two-phase, near-optimal (~18–22 moves)
      if (!sol) throw new Error('no solution found');
      reply(sol.trim());
    }
  } catch (err) {
    reply(null, (err && err.message) ? err.message : String(err));
  }
};
