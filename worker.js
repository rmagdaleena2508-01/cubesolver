// Solver worker — keeps cubejs' heavy table generation and solving off the UI thread.
importScripts('vendor/cube.js', 'vendor/solve.js');

let ready = false;

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
      const sol = c.solve(22); // two-phase, near-optimal (~18–22 moves)
      if (!sol) throw new Error('no solution found');
      reply(sol.trim());
    }
  } catch (err) {
    reply(null, (err && err.message) ? err.message : String(err));
  }
};
