// 3-D cube view: builds 26 cubies from a facelet string and animates face turns.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const SP = 1.06; // cubie spacing

// Sticker colors by face letter (letters follow the scan convention:
// U=white, D=yellow, F=green, B=blue, R=red, L=orange).
export const PALETTE = {
  U: 0xf0f1f3, D: 0xf2c94c, F: 0x2fbf71, B: 0x2f6fd0, R: 0xd94a4a, L: 0xf58a3c,
};
const PLASTIC = 0x14171e;

// For each face: material slot on BoxGeometry (+x,-x,+y,-y,+z,-z) and a
// mapping from (row, col) of the facelet grid to the cubie's grid position.
// Derived from the standard Kociemba facelet layout (viewed from outside).
const FACE_DEFS = {
  U: { mat: 2, pos: (r, c) => [-1 + c,  1, -1 + r] },
  D: { mat: 3, pos: (r, c) => [-1 + c, -1,  1 - r] },
  F: { mat: 4, pos: (r, c) => [-1 + c,  1 - r,  1] },
  B: { mat: 5, pos: (r, c) => [ 1 - c,  1 - r, -1] },
  R: { mat: 0, pos: (r, c) => [ 1,  1 - r,  1 - c] },
  L: { mat: 1, pos: (r, c) => [-1,  1 - r, -1 + c] },
};
const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B']; // facelet string order

// Rotation per move letter: axis + layer; clockwise (from outside) sign = -layer.
const MOVE_DEFS = {
  U: ['y',  1], D: ['y', -1],
  R: ['x',  1], L: ['x', -1],
  F: ['z',  1], B: ['z', -1],
};

export function parseMove(m) {
  const [axis, layer] = MOVE_DEFS[m[0]];
  const half = m.includes('2');
  const prime = m.includes("'");
  const sign = -layer * (prime ? -1 : 1);
  return { axis, layer, angle: sign * (half ? Math.PI : Math.PI / 2), half };
}

const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export class CubeView {
  constructor(canvas) {
    this.canvas = canvas;
    // Some machines fail to create an antialiased context (old GPUs, or
    // hardware acceleration disabled) — retry without AA before giving up,
    // and throw a clear error instead of leaving a silently blank canvas.
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e1) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
      } catch (e2) {
        throw new Error('WebGL unavailable — ' + (e2?.message || e2));
      }
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(4.6, 4.1, 6.2);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(6, 9, 7);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5); fill.position.set(-7, -4, -6);
    this.scene.add(key, fill);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 5.5;
    this.controls.maxDistance = 24;

    this.cubies = [];
    this.animating = false;

    const resize = () => {
      const w = canvas.clientWidth || canvas.parentElement.clientWidth;
      const h = canvas.clientHeight || canvas.parentElement.clientHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // Keep the whole cube in frame on narrow (portrait) viewports:
      // pull the camera back proportionally when width is the limiting side.
      const d = 8.8 * Math.max(1, 0.82 / this.camera.aspect);
      this.camera.position.setLength(d);
    };
    resize();
    new ResizeObserver(resize).observe(canvas);

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  // Build the 26 cubies, stickered from a 54-char facelet string (URFDLB order).
  setState(facelets) {
    this.cubies.forEach((c) => {
      this.scene.remove(c);
      c.geometry.dispose();
      c.material.forEach((m) => m.dispose());
    });
    this.cubies = [];

    // sticker lookup: "x,y,z|matSlot" → color
    const stickers = new Map();
    FACE_ORDER.forEach((f, fi) => {
      const def = FACE_DEFS[f];
      for (let i = 0; i < 9; i++) {
        const letter = facelets[fi * 9 + i];
        const p = def.pos((i / 3) | 0, i % 3);
        stickers.set(`${p[0]},${p[1]},${p[2]}|${def.mat}`, PALETTE[letter] ?? PLASTIC);
      }
    });

    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue;
      const mats = [];
      for (let slot = 0; slot < 6; slot++) {
        const col = stickers.get(`${x},${y},${z}|${slot}`);
        mats.push(new THREE.MeshStandardMaterial({
          color: col ?? PLASTIC,
          roughness: col ? 0.35 : 0.75,
          metalness: 0.05,
        }));
      }
      const mesh = new THREE.Mesh(geo.clone(), mats);
      mesh.position.set(x * SP, y * SP, z * SP);
      this.scene.add(mesh);
      this.cubies.push(mesh);
    }
  }

  // Animate one move ("R", "U'", "F2"). Resolves when the turn completes.
  turn(moveStr, base = 300) {
    if (this.animating) return Promise.resolve();
    const { axis, layer, angle, half } = parseMove(moveStr);
    const dur = half ? base * 1.6 : base;

    const picked = this.cubies.filter(
      (c) => Math.round(c.position[axis] / SP) === layer
    );
    const pivot = new THREE.Group();
    this.scene.add(pivot);
    picked.forEach((c) => pivot.attach(c));

    this.animating = true;
    return new Promise((res) => {
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        pivot.rotation[axis] = angle * easeInOut(t);
        if (t < 1) { requestAnimationFrame(step); return; }
        pivot.rotation[axis] = angle; // exact, no drift
        pivot.updateMatrixWorld(true);
        picked.forEach((c) => {
          this.scene.attach(c);
          c.position.set(
            Math.round(c.position.x / SP) * SP,
            Math.round(c.position.y / SP) * SP,
            Math.round(c.position.z / SP) * SP
          );
        });
        this.scene.remove(pivot);
        this.animating = false;
        res();
      };
      requestAnimationFrame(step);
    });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

// Inverse of a move, for stepping backwards.
export function invert(m) {
  if (m.includes('2')) return m;
  return m.includes("'") ? m[0] : m[0] + "'";
}
