# CubeSight - Scan and solve your rubiks cube

**Point your camera at a scrambled Rubik's Cube. Get a near-optimal solution, walked move-by-move on an interactive 3D cube. Runs entirely in the browser (no app, no backend, no build step).**

🔗 **Live:** [rmagdaleena2508-01.github.io/cubesolver](https://rmagdaleena2508-01.github.io/cubesolver/)


---


## Why this exists

I had a cube that had been sitting scrambled on my desk for weeks. I went down the YouTube-tutorial rabbit hole trying to learn it manually, got lost in algorithm notation, and decided to build the thing instead of memorizing 40 cases I'd forget by next week.

This was built end-to-end with **Claude Code** — planning and scaffolding with **Fable 5**, and the harder passes (the color-classification rework, cube-validity math, and the WebGL failure handling) with **Opus 4.8**. I write about how that split played out below, in [Building it with Claude Code](#building-it-with-claude-code).


## What it actually does

1. **Scan** — hold your cube up to the camera, six times, once per face. A grid overlay guides placement and a live per-cell color readout shows you what the camera sees *before* you commit to a capture.
2. **Review** — every detected sticker renders as an unfolded cube net. Anything the classifier wasn't confident about gets an amber ring. Tap any sticker to cycle its color by hand.
3. **Solve** — the app computes a solution (usually 18–22 moves) and renders it as an interactive 3D cube. Step through move-by-move, auto-play through the whole thing, or scrub backward with full inverse-move undo.

No sign-in required ,no data leaves your device - the camera frames never go anywhere but a `<canvas>` in memory.


---

## Architecture

Five files, no bundler, no npm install to run it:

| File | Role |
|---|---|
| `index.html` | Screen shell — home / scan / review / solve, all in one page, toggled by CSS class |
| `app.js` | Camera capture, color classification, review-net UI, solve-screen state machine |
| `cube3d.js` | Three.js scene: builds 26 cubies from a facelet string, animates layer turns |
| `worker.js` | Web Worker — owns the Kociemba solver, validity checks, and scan auto-repair |
| `vendor/` | three.js, OrbitControls, and [`cubejs`](https://github.com/ldez/cubejs) — vendored, so the app works fully offline once loaded |

Everything talks over `postMessage` RPC to the worker (see `rpc()` in `app.js`) so the solver's table-generation and search never touch the main thread — the UI stays responsive even while it's computing.



### The scan → solve pipeline

```
camera frame ──▶ sample 9 cells (median of 3 frames)
                        │
                        ▼
              balanced-assignment color classification
                        │
                        ▼
         54-character facelet string (URFDLB order)
                        │
                        ▼
        structural validity check (Web Worker)
          │                        │
     invalid, unrepairable    valid (or auto-repaired)
          │                        │
   specific error shown     Kociemba two-phase solve
                                    │
                                    ▼
                       move list → animated on 3D cube
```


### Color classification — the actual hard part

Solving a cube is a solved problem (literally , `cubejs` ships Kociemba's algorithm as a library). The genuinely hard part of a project like this is reading 54 stickers off a webcam accurately, because:

- Auto white-balance shifts colors between captures
- Warm indoor lighting pushes orange toward red
- Glare on the plastic can wash a sticker toward white
- Cheap cubes have color pairs (orange/red, especially) that sit close together in naive RGB space

**What didn't work well:** classifying each sticker independently by nearest-center RGB distance. Too fragile — a couple of misclassified stickers per scan, always the same pairs (orange↔red, white↔yellow under warm light).



**What the app does instead** (`classify()` in `app.js`):

1. Convert every sampled RGB to **CIELAB**, and weight the L-channel down relative to a/b. Auto-exposure moves lightness around a lot between frames; hue/chroma (a, b) is where the actual color signal lives.

2. Treat classification as a **balanced assignment problem**, not 54 independent lookups: a cube has *exactly* 9 stickers of each color, so solve for the assignment that respects that constraint. Center stickers pin their face's color (ground truth — they never move on a 3×3), then a greedy min-distance matcher fills the other 48 slots, capped at 9 per class.

3. Refine the six class centroids from their assigned members and repeat the assignment twice more — each pass re-centers on *this specific cube's* actual sticker colors instead of the initial guess from the centers alone.

4. Flag anything close to a decision boundary (or far from every class) as **uncertain** — shown with an amber ring in review, so you know exactly which stickers to double-check instead of hunting through all 54.


This turns "which color is this pixel" into "which assignment of colors to positions is most consistent," which is a meaningfully different (and much more robust) problem.



### Solvability validation & auto-repair

A scan can have all the right colors — 9 of each — and still describe a cube that **cannot physically exist**: a corner twisted in place, an edge flipped, two pieces swapped. Kociemba's algorithm has no way to detect that; it just searches forever for a solution that doesn't exist.

`worker.js` validates the cube's actual piece permutation before ever calling the solver:

- Corner and edge permutations must each be a valid permutation (no duplicate or out-of-range cubie)
- Corner orientation sum must be `≡ 0 (mod 3)` — else a corner is twisted
- Edge orientation sum must be `≡ 0 (mod 2)` — else an edge is flipped
- Corner and edge permutation parity must match — else two pieces are swapped

If invalid, before giving up, it tries one specific repair: the U (white) and D (yellow) faces are the two captured by *tilting* the cube toward/away from the camera, which is the easiest way to accidentally introduce a rotation offset even when every color is read correctly. The worker searches the 16 combinations of U/D face rotation and accepts a fix **only if exactly one** makes the cube valid — an ambiguous match (more than one rotation "works") is treated as a real error, not guessed at, so a genuine misread never gets silently repaired into a valid-but-wrong cube.


Anything past that gets a specific, actionable message ("one corner looks twisted," "one edge looks flipped") instead of a generic failure — and a 15-second timeout respawns the solver worker if anything ever does get stuck, so the UI can never hang indefinitely.



### 3D rendering

`cube3d.js` builds the cube from scratch as 26 individually-materialed `BoxGeometry` cubies (no imported cube model) — each of a cubie's up-to-3 visible faces gets its own `MeshStandardMaterial` colored from the facelet string, everything else gets a dark plastic material. A move animates by re-parenting the affected layer's cubies onto a temporary pivot `Group`, rotating the pivot with an eased tween, then snapping cubie positions back to the nearest lattice point to eliminate any floating-point drift before the next move.

WebGL context creation is wrapped defensively: if it fails outright (rare, but happens on machines with hardware acceleration disabled), the app catches it, shows a clear explanation instead of a silent blank canvas, and falls back to the text move-list — Next / Prev / Auto-play all keep working without the 3D view.


---


## Running it

No build step. It's just static files.

```bash
git clone https://github.com/rmagdaleena2508-01/cubesolver.git
cd cubesolver
python3 -m http.server 5182
# → http://localhost:5182
```

`localhost` counts as a secure context, so camera access works there without HTTPS.

**On a phone**, camera access requires real HTTPS — that's what the GitHub Pages deployment is for. Serving over plain `http://<lan-ip>:port` will load the page but the browser will block `getUserMedia`.



## Stack

- Vanilla JS, ES modules — no framework, no bundler
- [three.js](https://threejs.org/) r160 for the 3D cube + `OrbitControls` for drag-to-rotate
- [`cubejs`](https://github.com/ldez/cubejs) for Kociemba's two-phase solving algorithm, run inside a Web Worker
- Web APIs used directly: `getUserMedia`, `Canvas2D` (color sampling), `Worker`, `ResizeObserver`, `Screen Wake Lock`



## Honest limitations

- **Not truly optimal.** God's Number is 20 — any cube state has a 20-move-or-fewer solution — but finding the *provably shortest* solution needs enormous precomputed tables that aren't practical in a browser. Kociemba's two-phase algorithm (what this uses) returns 18–22 move solutions in well under a second, which is the same tradeoff every real-time cube solver makes.
- **Lighting still matters.** The balanced-assignment classifier is much more robust than naive per-sticker matching, but strong glare or very warm light can still push a reading past the amber-warning threshold. The tap-to-fix review step exists because of this, by design — not as an afterthought.
- **Camera-dependent.** Detection quality depends on your webcam/phone camera. Not tested against every device; if you hit a scan that won't classify cleanly, the sticker-by-sticker fix in review is the safety net.



## Project structure

```
cubesolver/
├── index.html      screens: home, scan, review, solve
├── style.css        all styling — dark, minimal, mobile-first
├── app.js           camera, classification, review, solve-screen logic
├── cube3d.js        three.js cube model + move animation
├── worker.js        solver worker: init, validate, repair, solve
└── vendor/
    ├── three.module.js
    ├── OrbitControls.js
    ├── cube.js       cubejs — cube state model
    └── solve.js      cubejs — Kociemba two-phase solver
```



## Building it with Claude Code


This was built in a single extended session with Claude Code, split across two models: **Fable 5** did the initial scaffolding and UI shell, and **Opus 4.8** took over for the harder correctness work — the balanced-assignment color classifier (after the naive per-sticker version kept confusing orange/red), the cube-validity math, and the auto-repair logic for rotated face captures.

The most useful part of the process wasn't the first draft — it was the iteration loop after real-world testing surfaced actual bugs: a scan that hung forever (missing solvability validation), colors that looked right but still failed (rotated face capture, fixed with the U/D auto-repair search), and a blank 3D view on one machine (WebGL failing silently, now surfaced with a real error message). Every one of those got caught by testing the deployed app, not by reading the code — which is the same way I'd want a human engineer to close out a project like this.



## License

MIT 
