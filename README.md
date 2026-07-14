# CubeSight — scan & solve your Rubik's Cube

Point your camera at a Rubik's Cube: CubeSight reads all six faces, computes a
near-optimal solution (Kociemba two-phase via `cubejs`, usually ~18–22 moves),
and walks you through every turn on an interactive 3-D cube.

Plain static files — no build step. Works on laptop and phone browsers.

## Run locally (laptop)

```bash
# from this folder
python3 -m http.server 5182
# → http://localhost:5182   (localhost is a secure context, so the camera works)
```

## Phone

Phones require **HTTPS** for camera access — serve via GitHub Pages / any
HTTPS host, or a local HTTPS tunnel. Plain `http://<laptop-ip>:5182` will load
but the camera will be blocked.

## How scanning works

- Faces are captured in a fixed order (green → red → blue → orange → white →
  yellow) with prescribed holding orientations, so each snapshot maps directly
  onto the Kociemba facelet layout — no rotation math, no ambiguity.
- Colors are classified by nearest-center distance in CIELAB: each face's
  *center* sticker defines its color class, so detection self-calibrates to
  your cube and lighting. Anything misread can be fixed with a tap in review.
- Front cameras (laptops) get a mirrored *preview* for natural alignment, but
  sampling always reads the raw frame — the camera is the "outside viewer"
  that cube notation expects, so the mapping stays correct on any camera.

## Files

| File | What it is |
| --- | --- |
| `index.html` | UI shell — home / scan / review / solve screens |
| `app.js` | Camera, sampling, CIELAB classification, review net, flow |
| `cube3d.js` | Three.js cube: builds 26 cubies from facelets, animates turns |
| `worker.js` | Web Worker wrapping the cubejs solver (no UI jank) |
| `vendor/` | three.js + OrbitControls + cubejs (vendored, works offline) |

## Honest note on "20 moves"

God's Number (20) is the *optimal* bound. A true optimal solver needs huge
tables — impractical in a phone browser. The two-phase algorithm used here
returns ~18–22 move solutions in under a second, which is what the viral apps
actually ship too.
