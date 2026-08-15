// script.js — AI Wheel Racing
//
// Design notes (read this before extending):
// - Stairs / Rocks / Steep / Ice terrain performance comes from REAL rigid-body
//   physics: the drawn shape is turned into an actual Matter.js polygon wheel,
//   so a bigger or toothed shape genuinely climbs a step better, and low
//   ground friction genuinely makes wheels slip on ice. No scripting there.
// - Sand and Water can't be done with rigid convex hulls alone (no fluid /
//   deformable-terrain sim), so those two use a small, clearly-labeled force
//   field driven by measurable wheel features (wideness, paddle-blade count).
//   Everything else — climbing, slipping, tipping over — is unscripted.

const { Engine, World, Bodies, Body, Constraint, Vertices, Events } = Matter;

// Without this, Bodies.fromVertices has no way to handle a concave polygon
// (spikes, teeth, notches) and silently falls back to Vertices.hull — which
// is exactly what was smoothing every drawn spike into a convex blob.
if (typeof decomp !== 'undefined' && Matter.Common && Matter.Common.setDecomp) {
  Matter.Common.setDecomp(decomp);
} else {
  console.warn('poly-decomp not loaded — concave wheel shapes (spikes/teeth) will be flattened to their convex hull.');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PLAYER_GROUND_Y = 420;
const LANE_GAP = 210; // vertical world-space separation between the two lanes
const AI_GROUND_Y = PLAYER_GROUND_Y + LANE_GAP;
const SEG_LEN = 900;
const BUFFER_LEN = 160;
const BASE_DRIVE_SPEED = 0.5; // wheel angular velocity target
const PHYSICS_SUBSTEPS = 4; // see loop() — physics runs in smaller steps to avoid tunneling through thin ground
const DRIVE_RESPONSE = 0.16; // how fast the wheel's spin ramps toward its target, per animation frame
const MAX_CHASSIS_ANGULAR_VELOCITY = 0.03; // hard cap on chassis spin rate, per animation frame — see onBeforeUpdate
const CHASSIS_ANGULAR_DAMPING = 0.9; // fraction of chassis spin kept each animation frame
const MIN_WHEEL_R = 22;
const MAX_WHEEL_R = 42; // was 34 (and 46 before that) — too small to read as actually touching the ground under a 96-long chassis
const REFERENCE_WHEEL_R = (MIN_WHEEL_R + MAX_WHEEL_R) / 2; // see onBeforeUpdate — drive speed is normalized against this

// Two separate physical lanes: the AI's terrain and your terrain never touch
// or collide with each other — each car only has a collision mask for its
// own lane's ground. Same segment layout on both, so it's a fair race, but
// genuinely "AI on one track, you on another."
const CAT_PLAYER_GROUND = 0x0002;
const CAT_AI_GROUND = 0x0004;

// --- 3D presentation ---
// Physics stays flat 2D (that's what makes a drawn wheel genuinely climb a
// step); this just maps that 2D simulation into a real 3D scene instead of
// faking depth with a 2D shear. Mapping convention, used everywhere below:
//   physics x (progress)      -> scene -Z (forward, away from camera)
//   physics y (height)        -> scene  Y (up), relative to that car's own ground line
//   which lane (player vs AI) -> a FIXED scene X offset (not physics-derived)
const LANE_X_OFFSET = 170;      // how far apart the two lanes sit, left/right
const LANE_VISUAL_WIDTH = 190;  // how wide each lane's terrain looks
const TRACK_HALF_WIDTH = 34;    // left/right wheel spacing, purely visual
const WHEEL_THICKNESS = 16;
const TERRAIN_COLOR3D = {
  flat: 0x8fd66b, finish: 0x8fd66b, stairs: 0xc9a17a, sand: 0xe9d18c,
  water: 0x5fb3e0, ice: 0xdbeeff, rocks: 0x9a9a95, steep: 0xc9a17a
};

const TERRAIN_TYPES = ['stairs', 'sand', 'water', 'ice', 'rocks', 'steep'];
const TERRAIN_LABEL = {
  flat: 'OPEN ROAD', stairs: 'STAIRCASE', sand: 'SAND DUNES', water: 'WATER CROSSING',
  ice: 'ICE SHEET', rocks: 'ROCK FIELD', steep: 'STEEP CLIMB', finish: 'FINISH STRETCH'
};

const playerId = (() => {
  let id = localStorage.getItem('awr_player_id');
  if (!id) { id = 'p_' + Math.random().toString(36).slice(2, 12); localStorage.setItem('awr_player_id', id); }
  return id;
})();

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const worldCanvas = document.getElementById('world');
const drawCanvas = document.getElementById('drawCanvas');
const dctx = drawCanvas.getContext('2d');

const statDist = document.getElementById('statDist');
const statSpeed = document.getElementById('statSpeed');
const statScore = document.getElementById('statScore');
const btnStart = document.getElementById('btnStart');
const btnRestart = document.getElementById('btnRestart');
const btnClear = document.getElementById('btnClear');
const btnUseWheel = document.getElementById('btnUseWheel');
const incomingBanner = document.getElementById('incomingBanner');
const incomingType = document.getElementById('incomingType');
const resultPanel = document.getElementById('resultPanel');
const resultBody = document.getElementById('resultBody');
const aiLogBody = document.getElementById('aiLogBody');
const bpRadius = document.getElementById('bpRadius');
const bpWidth = document.getElementById('bpWidth');
const bpTread = document.getElementById('bpTread');
const bpIrreg = document.getElementById('bpIrreg');

// ---------------------------------------------------------------------------
// 3D scene (Three.js) — persists across races; only the terrain/car meshes
// inside it get rebuilt each time initWorld() runs.
// ---------------------------------------------------------------------------
const three = {};

function initThreeScene() {
  three.renderer = new THREE.WebGLRenderer({ canvas: worldCanvas, antialias: true });
  three.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  three.scene = new THREE.Scene();
  three.scene.background = new THREE.Color(0x8ec9f0);
  three.scene.fog = new THREE.Fog(0x8ec9f0, 1600, 4600);

  three.camera = new THREE.PerspectiveCamera(58, 1, 1, 6000);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x33424f, 0.9);
  three.scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 0.9);
  sun.position.set(-300, 500, 200);
  three.scene.add(sun);
  three.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
}

// ---------------------------------------------------------------------------
// Sand dust particles — small pooled grains kicked up while driving over
// sand. Purely cosmetic and world-space (not attached to the car group), so
// it doesn't touch physics. Created once at startup (not rebuilt per race,
// like the terrain/car meshes are) since the pool itself doesn't depend on
// anything race-specific.
// ---------------------------------------------------------------------------
const DUST_POOL_SIZE = 50;
const dustPools = { player: null, ai: null };

function createDustPool(count) {
  const pool = [];
  const geo = new THREE.TetrahedronGeometry(2.2, 0);
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xe0c98a, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    three.scene.add(mesh);
    pool.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
  }
  return pool;
}

// Reuses whichever pooled particle has the least life left instead of
// tracking a separate free-list — cheap enough at DUST_POOL_SIZE=50 and
// naturally recycles the oldest-looking grain first.
function spawnDust(pool, sceneX, sceneY, sceneZ) {
  let p = pool[0];
  for (let i = 1; i < pool.length; i++) if (pool[i].life < p.life) p = pool[i];
  p.mesh.position.set(
    sceneX + (Math.random() - 0.5) * 16,
    sceneY + Math.random() * 3,
    sceneZ + (Math.random() - 0.5) * 16
  );
  p.vx = (Math.random() - 0.5) * 40;
  p.vy = 30 + Math.random() * 55;
  p.vz = (Math.random() - 0.5) * 40;
  p.maxLife = 0.35 + Math.random() * 0.35;
  p.life = p.maxLife;
  p.mesh.visible = true;
  p.mesh.material.opacity = 0.85;
  p.mesh.scale.setScalar(0.6 + Math.random() * 0.8);
}

function updateDust(pool, dt) {
  if (!pool) return;
  for (const p of pool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.vy -= 140 * dt; // gravity pulls each grain back down
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    const t = Math.max(0, p.life / p.maxLife);
    p.mesh.material.opacity = 0.85 * t;
    p.mesh.scale.setScalar(0.3 + 0.7 * t);
  }
}

function resizeWorldCanvas() {
  if (!three.renderer) return;
  const w = worldCanvas.clientWidth, h = worldCanvas.clientHeight;
  three.renderer.setSize(w, h, false);
  three.camera.aspect = w / h;
  three.camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeWorldCanvas);

// ---------------------------------------------------------------------------
// Track generation
// ---------------------------------------------------------------------------
function buildTrackPlan() {
  const shuffled = [...TERRAIN_TYPES].sort(() => Math.random() - 0.5);
  const plan = [{ type: 'flat', len: BUFFER_LEN }];
  for (const t of shuffled) {
    plan.push({ type: t, len: SEG_LEN });
    plan.push({ type: 'flat', len: BUFFER_LEN });
  }
  plan.push({ type: 'finish', len: 400 });

  let x = 0;
  const segments = plan.map(p => {
    const seg = { type: p.type, x0: x, x1: x + p.len, len: p.len };
    x += p.len;
    return seg;
  });
  return { segments, totalLength: x };
}

function segmentAt(segments, x) {
  for (const s of segments) if (x >= s.x0 && x < s.x1) return s;
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------------
// Per-race terrain conditions. Without this, the single best answer to every
// terrain converges on "draw the biggest smoothest circle you can" — size
// alone bulldozes stairs/rocks and a plain circle is never actively bad at
// anything, so shape stops mattering and the AI has nothing left to learn
// besides "circle, max radius". Rolling fresh conditions each race (same
// roll for both lanes, so it's still a fair race) means the max-size circle
// that wins today's staircase can be the wrong answer for today's water
// viscosity or tomorrow's steeper slope — so drawing FOR the terrain ahead
// stays the actual skill, and the AI's imitation data has to generalize
// across conditions instead of memorizing one shape.
function rollRaceConditions() {
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  return {
    stairs: { stepH: rand(16, 34), stepW: rand(55, 90) },
    sand: { friction: rand(0.9, 1.4), wideBias: rand(0.65, 1.05) },
    water: { friction: rand(0.15, 0.45), buoyancy: rand(0.0006, 0.0014), densityFactor: rand(0.7, 1.6) },
    ice: { friction: rand(0.01, 0.05) },
    rocks: { bumpAmp: rand(16, 34) },
    steep: { angle: rand(0.22, 0.42) } // radians, climbing
  };
}

function describeRaceConditions(c) {
  const stairPct = Math.round((c.stairs.stepH / 34) * 100);
  const waterPct = Math.round((c.water.densityFactor / 1.6) * 100);
  const slopeDeg = Math.round(c.steep.angle * 180 / Math.PI);
  return `Conditions: stairs ${Math.round(c.stairs.stepH)}px risers (${stairPct}% max) · water viscosity ${waterPct}% · slope ${slopeDeg}°`;
}

function buildGroundBodies(world, segments, baseY, category, conditions) {
  const bodies = [];
  const waterZones = [];
  const sandZones = [];
  const filter = { category };

  // Creates a ground box AND tags it with the raw dimensions/angle used to
  // build it, so the 3D layer can reconstruct an exactly matching mesh
  // later without re-deriving geometry from Matter's world-space vertices.
  function addBox(x, y, w, h, angle, friction, groundType) {
    const b = Bodies.rectangle(x, y, w, h, {
      isStatic: true, friction, angle: angle || 0, collisionFilter: filter, render: {}
    });
    b.groundType = groundType;
    b._w = w; b._h = h; b._angle = angle || 0;
    bodies.push(b);
    return b;
  }

  for (const seg of segments) {
    const w = seg.len;
    const cx = seg.x0 + w / 2;

    switch (seg.type) {
      case 'flat':
      case 'finish':
        addBox(cx, baseY + 20, w, 40, 0, 0.7, seg.type);
        break;
      case 'stairs': {
        // Riser height needs real headroom under MAX_WHEEL_R (42) so a
        // normal, roundish, treaded wheel can climb it through actual
        // rolling contact — not just a wheel drawn as a single long spike
        // used like a pogo leg to "glitch" over the steps. A wider tread
        // (stepW) also lowers the step's effective climb angle, which
        // matters more for a rolling wheel than raw riser height does.
        // Both rolled per race (see rollRaceConditions) so a max-size wheel
        // that cruises today's gentle risers can't just coast on size alone
        // every race.
        const { stepH, stepW } = conditions.stairs;
        const steps = Math.floor(w / stepW); // riser well under MAX_WHEEL_R so climbing is real, not a glitch
        for (let i = 0; i < steps; i++) {
          const rise = Math.min(i, 5) * stepH; // cap so it plateaus at 5 steps' worth
          const bx = seg.x0 + i * stepW + stepW / 2;
          // Box is centered at (x, y) with height h, so its top surface sits
          // at y - h/2. We want that top surface at (baseY - rise) so each
          // step's riser is exactly stepH tall. With h = 40 + rise, that
          // means y = (baseY - rise) + h/2 = baseY - rise/2 + 20 — NOT
          // baseY - rise + 20, which was putting the top surface at
          // baseY - 1.5*rise (a taller riser than intended and impossible
          // to climb).
          addBox(bx, baseY - rise / 2 + 20, stepW + 2, 40 + rise, 0, 0.95, 'stairs');
        }
        break;
      }
      case 'sand': {
        // One physics box for the whole segment (sand's collision behavior
        // is a uniform property), but tag it with everything the visual
        // dune layer needs to lay a dense field of dune mounds across it
        // (see build3DTerrain / addDuneDecor) instead of one flat-colored
        // slab. Dune height/size follows a smooth sine ridge line — its own
        // independently-seeded wavelength/phase, re-rolled every time the
        // track is built — so ripples read as coherent wind-blown dunes
        // instead of scattered random blobs.
        const b = addBox(cx, baseY + 20, w, 40, 0, conditions.sand.friction, 'sand');
        b._duneCount = 10 + Math.floor(w / 30);
        b._duneWaveLen = 90 + Math.random() * 90;
        b._dunePhase = Math.random() * Math.PI * 2;
        sandZones.push(seg);
        break;
      }
      case 'water':
        addBox(cx, baseY + 20, w, 40, 0, conditions.water.friction, 'water');
        waterZones.push(seg);
        break;
      case 'ice':
        addBox(cx, baseY + 20, w, 40, 0, conditions.ice.friction, 'ice');
        break;
      case 'rocks': {
        // Ground elevation genuinely rises and falls (real jolts, not a
        // flattened-out ride) but follows a smooth continuous sine wave
        // instead of independent per-chunk noise — adjacent chunks used to
        // jump around unpredictably, which read as random jitter rather than
        // terrain. Wavelength and phase are re-rolled with Math.random()
        // every time the track is built, so the hills are a different shape
        // every race, not one fixed wave.
        const amp = conditions.rocks.bumpAmp * 0.65;
        const waveLen = 140 + Math.random() * 140; // px per full up/down cycle
        const phase = Math.random() * Math.PI * 2;
        // The boulder cluster's left/right position also drifts as a smooth
        // sine wave along the segment (its own independently-seeded
        // wavelength/phase) instead of jumping to a random lateral bin every
        // chunk — a random left/center/right pick each chunk would look just
        // as jittery/fake sideways as the old per-chunk height noise did.
        const lateralWaveLen = 220 + Math.random() * 220;
        const lateralPhase = Math.random() * Math.PI * 2;
        let x = seg.x0;
        while (x < seg.x1) {
          const chunk = Math.min(22 + Math.random() * 18, seg.x1 - x);
          const bx = x + chunk / 2;
          const bump = Math.sin(((bx - seg.x0) / waveLen) * Math.PI * 2 + phase) * amp;
          const b = addBox(bx, baseY + 20 - bump, chunk + 2, Math.max(14, 40 + bump), 0, 0.95, 'rocks');
          // Tag for the decorative boulder layer (build3DTerrain). Corner
          // style is still an independent per-chunk coin flip so sharp/round
          // boulders mix throughout; lateral position follows the smooth
          // wave above.
          b._rockSharp = Math.random() < 0.5;
          b._rockLateral = Math.sin(((bx - seg.x0) / lateralWaveLen) * Math.PI * 2 + lateralPhase);
          x += chunk;
        }
        break;
      }
      case 'steep': {
        const angleAbs = conditions.steep.angle;
        const angle = -angleAbs; // radians, climbing
        const len = Math.hypot(w, w * Math.tan(angleAbs));
        const rise = w * Math.tan(angleAbs);
        addBox(cx, baseY + 20 - rise / 2, len, 40, angle, 0.95, 'steep');
        break;
      }
    }
  }
  World.add(world, bodies);
  return { bodies, waterZones, sandZones, baseY };
}

// ---------------------------------------------------------------------------
// Wheel geometry from drawn points
// ---------------------------------------------------------------------------
function computeWheelFeatures(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const rel = points.map(p => ({ x: p.x - cx, y: p.y - cy }));
  const radii = rel.map(p => Math.hypot(p.x, p.y));
  const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
  const maxR = Math.max(...radii);
  const variance = radii.reduce((s, r) => s + (r - meanR) ** 2, 0) / radii.length;
  const irregularity = meanR > 0 ? Math.sqrt(variance) / meanR : 0;

  const xs = rel.map(p => p.x), ys = rel.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const widthRatio = height > 0 ? width / height : 1;

  // protrusion count: sample radius by angle bin, count local bumps above mean
  const bins = 24, binMax = new Array(bins).fill(0);
  rel.forEach((p, i) => {
    let ang = Math.atan2(p.y, p.x); if (ang < 0) ang += Math.PI * 2;
    const b = Math.floor(ang / (Math.PI * 2) * bins) % bins;
    binMax[b] = Math.max(binMax[b], radii[i]);
  });
  let protrusions = 0;
  for (let i = 0; i < bins; i++) {
    const prev = binMax[(i - 1 + bins) % bins], next = binMax[(i + 1) % bins];
    if (binMax[i] > meanR * 1.15 && binMax[i] >= prev && binMax[i] >= next) protrusions++;
  }

  return { centroid: { x: cx, y: cy }, maxR, widthRatio, irregularity, protrusions };
}

function pointsToPhysicsVertices(points, features) {
  const targetR = Math.max(MIN_WHEEL_R, Math.min(MAX_WHEEL_R, features.maxR * 0.32));
  const scale = features.maxR > 0 ? targetR / features.maxR : 1;
  const verts = points.map(p => ({
    x: (p.x - features.centroid.x) * scale,
    y: (p.y - features.centroid.y) * scale
  }));
  // Keep the actual drawn outline (spikes, teeth, notches and all) instead
  // of forcing it through Vertices.hull, which discards any concave detail
  // and is exactly what was turning spikes into a smooth convex blob.
  // Bodies.fromVertices (in mountWheels) will decompose this into convex
  // parts using poly-decomp — the shape only falls back to its convex hull
  // if that decomposition genuinely fails (self-intersecting drawing etc).
  const vertices = Vertices.clockwiseSort(verts);
  // "radius" (farthest vertex from center) is only a good stand-in for how
  // far the wheel reaches DOWNWARD when the shape is roughly circular. A
  // hand-drawn wheel is usually lopsided — its farthest point might stick
  // out sideways or upward, not straight down — so using radius to work out
  // where the ground line should be leaves the actual lowest point of the
  // shape short of the ground, floating above it. bottomOffset is the real
  // lowest point of the hull (max local y, since y is down), and is what
  // ground-placement math should use instead.
  const bottomOffset = Math.max(...vertices.map(v => v.y));
  return { vertices, radius: targetR, bottomOffset };
}

function defaultWheelPoints(n = 16, r = 60) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------
const PLAYER_COLOR = '#e8e6df';
const AI_COLOR = '#5a6b7a';

function createCar(startX, color, group, laneGroundY, laneMask, laneSceneX) {
  const chassis = Bodies.rectangle(startX, laneGroundY - 60, 96, 26, {
    density: 0.0022, friction: 0.4, collisionFilter: { group, mask: laneMask },
    render: { fillStyle: color }
  });
  const car = { chassis, color, group, mask: laneMask, groundY: laneGroundY, laneSceneX,
    wheelA: null, wheelB: null, cA: null, cB: null, mesh3D: null,
    driveMul: 1, currentSegIndex: -1, telemetry: null, finished: false, finishTime: null,
    flippedSince: null, stuckAccum: 0 };

  build3DCarMeshes(car);
  mountWheels(car, defaultWheelPoints(), { maxR: 60, widthRatio: 1, irregularity: 0, protrusions: 0, centroid: { x: 0, y: 0 } });

  // Spawn the whole car seated right on the ground (tiny 3px gap for a
  // gentle settle) instead of floating ~25px above it — that gap was the
  // "is that meant to be starting?" free-fall at the start of every race.
  const bottomY = car.wheelA.position.y + car.wheelBottomOffset;
  const dy = (laneGroundY - 3) - bottomY;
  Body.translate(car.chassis, { x: 0, y: dy });
  Body.translate(car.wheelA, { x: 0, y: dy });
  Body.translate(car.wheelB, { x: 0, y: dy });
  sync3DCar(car);

  return car;
}

function mountWheels(car, points, features) {
  const world = physics.world;
  const prevVelocity = car.chassis ? car.chassis.velocity : { x: 0, y: 0 };
  const prevAngularVel = car.wheelA ? car.wheelA.angularVelocity : 0;
  if (car.wheelA) World.remove(world, [car.wheelA, car.wheelB, car.cA, car.cB]);

  const { vertices, radius, bottomOffset } = pointsToPhysicsVertices(points, features);
  const cx = car.chassis.position.x, cy = car.chassis.position.y;
  const offsets = [{ x: -32, y: 16 }, { x: 32, y: 16 }];
  const filter = { group: car.group, mask: car.mask };

  const wheels = offsets.map(off => {
    const w = Bodies.fromVertices(cx + off.x, cy + off.y, [vertices], {
      friction: 0.85, frictionStatic: 1.0, density: 0.0035, restitution: 0,
      collisionFilter: filter,
      render: { fillStyle: car.color === PLAYER_COLOR ? '#f2c14e' : '#3ddc97' }
    }, true);
    if (!w.parts || w.parts.length < 1) return Bodies.circle(cx + off.x, cy + off.y, radius, { collisionFilter: filter });
    return w;
  });

  // Match the chassis's current motion so hot-swapping wheels mid-race
  // doesn't yank the car (new bodies otherwise spawn at rest, and the rigid
  // constraint would snap them into sync with a violent impulse).
  wheels.forEach(w => {
    Body.setVelocity(w, prevVelocity);
    Body.setAngularVelocity(w, prevAngularVel);
  });

  // Fully rigid pin, not a spring. A spring (any stiffness under 1) fights a
  // losing battle against how the wheel is driven below — since the wheel's
  // spin is forced every frame regardless of load, it acts like an infinite-
  // power motor, and any spring eventually gets stretched out by it. That's
  // what caused the wheels to visibly tear away from the chassis. A rigid
  // pin physically cannot stretch, so this failure mode is gone entirely.
  const constraints = offsets.map((off, i) => Constraint.create({
    bodyA: car.chassis, pointA: off,
    bodyB: wheels[i], pointB: { x: 0, y: 0 },
    stiffness: 1, length: 0
  }));

  World.add(world, [...wheels, ...constraints]);
  car.wheelA = wheels[0]; car.wheelB = wheels[1];
  car.cA = constraints[0]; car.cB = constraints[1];
  car.wheelFeatures = features;
  car.wheelRadius = radius;
  car.wheelBottomOffset = bottomOffset;

  // Record when/where this wheel was installed so telemetry scoring can
  // attribute performance to the active wheel from the moment it was set
  // until it changes again.
  try {
    car.wheelSetAt = performance.now();
    car.wheelSetX = car.chassis ? car.chassis.position.x : 0;
    car.wheelSetStuckBaseline = car.telemetry ? car.telemetry.stuckMs || 0 : 0;
  } catch (e) {
    car.wheelSetAt = Date.now();
    car.wheelSetX = car.chassis ? car.chassis.position.x : 0;
    car.wheelSetStuckBaseline = 0;
  }

  if (car.mesh3D) updateWheelMesh3D(car, vertices);
}

// ---------------------------------------------------------------------------
// 3D meshes for a car: a box chassis + 4 visual wheels (front/rear pairs,
// left+right of each). Physics only has one wheel per axle (side-view sim),
// so each physics wheel drives a symmetric left/right pair of meshes that
// share its rotation — gives a normal-looking 4-wheeled vehicle without
// adding a lateral dimension to the underlying 2D physics.
// ---------------------------------------------------------------------------
function build3DCarMeshes(car) {
  const bodyColor = new THREE.Color(car.color);
  const chassisMat = new THREE.MeshStandardMaterial({ color: bodyColor, flatShading: true, roughness: 0.6 });
  const cabMat = new THREE.MeshStandardMaterial({ color: bodyColor.clone().multiplyScalar(0.85), flatShading: true, roughness: 0.6 });

  const group = new THREE.Group();
  const chassisMesh = new THREE.Mesh(new THREE.BoxGeometry(58, 22, 96), chassisMat);
  group.add(chassisMesh);
  const cabMesh = new THREE.Mesh(new THREE.BoxGeometry(44, 20, 40), cabMat);
  cabMesh.position.set(0, 20, -10);
  group.add(cabMesh);

  const placeholderGeo = new THREE.CylinderGeometry(19, 19, WHEEL_THICKNESS, 12);
  placeholderGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: car.color === PLAYER_COLOR ? 0xf2c14e : 0x3ddc97, flatShading: true, roughness: 0.7
  });

  const wheelFL = new THREE.Mesh(placeholderGeo, wheelMat);
  const wheelFR = new THREE.Mesh(placeholderGeo, wheelMat);
  const wheelRL = new THREE.Mesh(placeholderGeo, wheelMat);
  const wheelRR = new THREE.Mesh(placeholderGeo, wheelMat);
  [wheelFL, wheelFR, wheelRL, wheelRR].forEach(m => group.add(m));

  three.scene.add(group);
  car.mesh3D = { group, chassisMesh, wheelFL, wheelFR, wheelRL, wheelRR };
}

// Rebuilds the wheel meshes' geometry from the same local vertices used for
// the physics body, so what you drew is exactly what climbs the terrain AND
// exactly what's shown — extruded sideways into a real 3D tire profile.
function updateWheelMesh3D(car, localVertices) {
  const shape = new THREE.Shape();
  localVertices.forEach((v, i) => i === 0 ? shape.moveTo(v.x, -v.y) : shape.lineTo(v.x, -v.y));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: WHEEL_THICKNESS, bevelEnabled: false, steps: 1 });
  geo.rotateY(Math.PI / 2);
  geo.translate(-WHEEL_THICKNESS / 2, 0, 0);

  const m = car.mesh3D;
  const oldGeo = m.wheelFL.geometry, oldGeo2 = m.wheelRL.geometry;
  [m.wheelFL, m.wheelFR].forEach(w => { w.geometry = geo; });
  const geo2 = geo.clone();
  [m.wheelRL, m.wheelRR].forEach(w => { w.geometry = geo2; });
  if (oldGeo && oldGeo.dispose) oldGeo.dispose();
  if (oldGeo2 && oldGeo2.dispose && oldGeo2 !== oldGeo) oldGeo2.dispose();
}

// Copies live physics transforms onto the 3D meshes. Mapping convention:
// physics x (progress) -> scene -Z, physics y (height, relative to this
// car's own ground line) -> scene Y, lane -> fixed scene X.
function sync3DCar(car) {
  const m = car.mesh3D;
  if (!m) return;
  const gx = car.laneSceneX;
  const toScene = (body) => ({
    x: gx, y: -(body.position.y - car.groundY), z: -body.position.x
  });

  const cp = toScene(car.chassis);
  m.group.position.set(cp.x, cp.y, cp.z);
  m.group.rotation.x = -car.chassis.angle;

  if (car.wheelA && car.wheelB) {
    // wheelA/B positions are already relative to the chassis via the pin
    // constraint, but they carry their own angle (spin) — apply that spin
    // in the chassis' local frame. mountWheels puts wheelA (rear) at
    // physics offset x=-32 and wheelB (front) at x=+32; since the global
    // mapping is scene-Z = -physics-x, the LOCAL z offsets are the mirror
    // of those physics offsets (rear -> +Z, front -> -Z).
    const localOffsetRear = 32, localOffsetFront = -32;
    [m.wheelRL, m.wheelRR].forEach(w => {
      w.position.set(w === m.wheelRL ? -TRACK_HALF_WIDTH : TRACK_HALF_WIDTH, -16, localOffsetRear);
      w.rotation.x = -car.wheelA.angle;
    });
    [m.wheelFL, m.wheelFR].forEach(w => {
      w.position.set(w === m.wheelFL ? -TRACK_HALF_WIDTH : TRACK_HALF_WIDTH, -16, localOffsetFront);
      w.rotation.x = -car.wheelB.angle;
    });
  }
}

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------
const physics = {};
let track = null;
let raceConditions = null;
let ground = null;
let player = null;
let ai = null;
let raceRunning = false;
const threeGroups = { terrainPlayer: null, terrainAI: null, decor: [] };

// A small procedural mottled-gray canvas texture, generated once and reused
// on every rock surface (collision boxes and boulders alike) — otherwise
// rocks are just flat-shaded solid color, which reads as plastic, not stone.
// Three distinct variants (different base tone + speckle mix), picked
// per-rock, so a dense field of boulders doesn't look like the same rock
// copy-pasted hundreds of times.
const ROCK_TEXTURE_VARIANTS = [
  { base: [140, 137, 128], speckleLo: [80, 76, 68], speckleHi: [190, 184, 168] },  // pale grey granite
  { base: [110, 96, 82], speckleLo: [60, 50, 40], speckleHi: [150, 128, 104] },    // warm brown sandstone
  { base: [96, 100, 102], speckleLo: [50, 54, 58], speckleHi: [140, 146, 150] }    // cool slate grey
];
const rockTextureCache = [];
function getRockTexture(variant) {
  const idx = ((variant | 0) % ROCK_TEXTURE_VARIANTS.length + ROCK_TEXTURE_VARIANTS.length) % ROCK_TEXTURE_VARIANTS.length;
  if (rockTextureCache[idx]) return rockTextureCache[idx];
  const { base, speckleLo, speckleHi } = ROCK_TEXTURE_VARIANTS[idx];
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = 0.6 + Math.random() * 3.2;
    const t = Math.random();
    const c = [0, 1, 2].map(ch => Math.round(speckleLo[ch] + (speckleHi[ch] - speckleLo[ch]) * t));
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.3 + Math.random() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  rockTextureCache[idx] = tex;
  return tex;
}

// A small procedural sandy-grain texture, generated once and reused on the
// base sand box and every dune mound — otherwise sand is just a flat tan
// slab, which doesn't read as granular.
let sandTextureCache = null;
function getSandTexture() {
  if (sandTextureCache) return sandTextureCache;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9d18c';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = 0.5 + Math.random() * 1.8;
    const shade = 190 + Math.random() * 60;
    ctx.fillStyle = `rgba(${shade},${Math.round(shade * 0.86)},${Math.round(shade * 0.55)},${0.25 + Math.random() * 0.35})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  sandTextureCache = tex;
  return tex;
}

function build3DTerrain(laneGround, laneSceneX) {
  const group = new THREE.Group();
  for (const b of laneGround.bodies) {
    const color = TERRAIN_COLOR3D[b.groundType] || 0x666666;
    const isRock = b.groundType === 'rocks';
    const isSand = b.groundType === 'sand';
    const mat = new THREE.MeshStandardMaterial({
      color, flatShading: true, roughness: 0.85,
      map: isRock ? getRockTexture(Math.floor(Math.random() * 3)) : (isSand ? getSandTexture() : undefined)
    });
    if (isRock) mat.map.repeat.set(Math.max(1, b._w / 30), 3);
    if (isSand) mat.map.repeat.set(Math.max(1, b._w / 40), 2);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_VISUAL_WIDTH, b._h, b._w), mat);
    mesh.position.set(laneSceneX, -(b.position.y - laneGround.baseY), -b.position.x);
    mesh.rotation.x = -b._angle;
    group.add(mesh);

    // Purely cosmetic detail on top of the exact collision box above — the
    // box stays what you actually stand/climb on, these just make it read
    // as real terrain instead of a flat colored slab.
    if (isRock) addRockDecor(group, b, laneGround, laneSceneX);
    else if (b.groundType === 'sand') addDuneDecor(group, b, laneGround, laneSceneX);
  }
  three.scene.add(group);
  return group;
}

// The ground itself is kept close to flat (see buildGroundBodies) — the
// difficulty and the look of "rocks" terrain both come from sheer boulder
// density instead: 8-15 boulders per chunk, roughly 3-5x the old count, mixing
// angular low-poly ("sharp") and smooth higher-detail ("round") shapes, each
// picking one of 3 stone texture variants, scattered at randomized left/
// center/right lateral positions (b._rockLateral, rolled in
// buildGroundBodies) so a rocks segment reads as a dense, varied field
// instead of one repeated prop marching down the middle.
function addRockDecor(group, b, laneGround, laneSceneX) {
  const topY = -(b.position.y - laneGround.baseY) + b._h / 2;
  const z = -b.position.x;
  const count = 8 + Math.floor(Math.random() * 8);
  for (let k = 0; k < count; k++) {
    const sharp = (k === 0 && b._rockSharp !== undefined) ? b._rockSharp : Math.random() < 0.5;
    const baseR = 5 + Math.random() * 15;
    const geo = sharp ? new THREE.IcosahedronGeometry(baseR, 0) : new THREE.IcosahedronGeometry(baseR, 1);
    const grey = 0.5 + Math.random() * 0.28;
    const warmth = Math.random() * 0.14;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(grey + warmth, grey * 0.9, grey * 0.78),
      flatShading: sharp, roughness: 0.92, map: getRockTexture(Math.floor(Math.random() * 3))
    });
    const mesh = new THREE.Mesh(geo, mat);
    const lateral = (k === 0 && b._rockLateral !== undefined) ? b._rockLateral : (Math.random() * 2 - 1);
    const lateralPx = lateral * (LANE_VISUAL_WIDTH / 2 - baseR - 6);
    const along = (Math.random() - 0.5) * Math.max(0, b._w - baseR);
    mesh.position.set(laneSceneX + lateralPx, topY + baseR * 0.3, z + along);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    group.add(mesh);
  }
}

// Lays down a dense field of dune mounds across a sand segment (10+, was
// 3-6) instead of one flat tan box. Each mound's height/size tracks a smooth
// sine "ridge line" along the segment (b._duneWaveLen/b._dunePhase, rolled
// in buildGroundBodies) so the field reads as coherent wind-blown ripples —
// alternating taller ridges and shallow troughs — rather than random blobs,
// textured with the same procedural grain map used on the base sand box.
function addDuneDecor(group, b, laneGround, laneSceneX) {
  const topY = -(b.position.y - laneGround.baseY) + b._h / 2;
  const z = -b.position.x;
  const count = b._duneCount || 10;
  const waveLen = b._duneWaveLen || 120;
  const phase = b._dunePhase || 0;
  for (let k = 0; k < count; k++) {
    const along = (Math.random() - 0.5) * Math.max(0, b._w);
    const ridge = 0.5 + 0.5 * Math.sin((along / waveLen) * Math.PI * 2 + phase); // 0..1
    const radius = 14 + ridge * 34 + Math.random() * 10;
    const geo = new THREE.SphereGeometry(radius, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const shade = 0.8 + Math.random() * 0.16;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.91 * shade, 0.8 * shade, 0.52 * shade),
      flatShading: true, roughness: 1, map: getSandTexture()
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.y = 0.22 + ridge * 0.22 + Math.random() * 0.08;
    const lateral = (Math.random() * 2 - 1) * Math.max(0, LANE_VISUAL_WIDTH / 2 - radius * 0.5);
    mesh.position.set(laneSceneX + lateral, topY - 1, z + along);
    group.add(mesh);
  }
}

function clearGroup(group) {
  if (!group) return;
  three.scene.remove(group);
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

function initWorld() {
  // Higher-than-default solver iterations: with a fully rigid wheel-axle
  // constraint (stiffness 1) plus driven torque plus the heavier gravity
  // below, Matter's default iteration counts (6 position / 4 velocity /
  // 2 constraint) aren't enough to resolve contact + constraint together in
  // one step. That under-resolution is what shows up as wheels spinning
  // fast with no forward traction and the chassis bouncing vertically —
  // the ground contact keeps getting resolved *after* the constraint pulls
  // the wheel back into the ground, instead of together.
  physics.engine = Engine.create({
    positionIterations: 12,
    velocityIterations: 10,
    constraintIterations: 4
  });
  physics.world = physics.engine.world;
  physics.world.gravity.y = 3.4; // was 2.2, still felt floaty

  track = buildTrackPlan();
  raceConditions = rollRaceConditions();
  const groundPlayer = buildGroundBodies(physics.world, track.segments, PLAYER_GROUND_Y, CAT_PLAYER_GROUND, raceConditions);
  const groundAI = buildGroundBodies(physics.world, track.segments, AI_GROUND_Y, CAT_AI_GROUND, raceConditions);
  ground = { player: groundPlayer, ai: groundAI, bodies: [...groundPlayer.bodies, ...groundAI.bodies] };

  // Clear the previous race's 3D scene objects before building fresh ones
  clearGroup(threeGroups.terrainPlayer);
  clearGroup(threeGroups.terrainAI);
  threeGroups.decor.forEach(m => { three.scene.remove(m); if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
  threeGroups.decor = [];
  if (player && player.mesh3D) clearGroup(player.mesh3D.group);
  if (ai && ai.mesh3D) clearGroup(ai.mesh3D.group);
  threeGroups.terrainPlayer = build3DTerrain(groundPlayer, -LANE_X_OFFSET);
  threeGroups.terrainAI = build3DTerrain(groundAI, LANE_X_OFFSET);
  addStaticSceneDecor();

  const prevPlayerFeatures = player ? player.wheelFeatures : null;
  const prevPlayerPoints = prevPlayerFeatures ? prevPlayerFeatures.rawPoints : null;

  player = createCar(60, PLAYER_COLOR, -1, PLAYER_GROUND_Y, CAT_PLAYER_GROUND, -LANE_X_OFFSET);
  ai = createCar(60, AI_COLOR, -2, AI_GROUND_Y, CAT_AI_GROUND, LANE_X_OFFSET);

  // Keep whatever wheel the player already drew (e.g. before hitting Start,
  // or from a previous race) instead of resetting to the default circle.
  if (prevPlayerPoints) {
    mountWheels(player, prevPlayerPoints, computeWheelFeaturesFromRaw(prevPlayerPoints));
  }

  // onBeforeUpdate is called manually, once per animation frame, from
  // loop() below — not hooked to Matter's 'beforeUpdate' event, which
  // would now fire once per physics sub-step (see PHYSICS_SUBSTEPS) and
  // re-run all of this 4x a frame instead of once.
}

function computeWheelFeaturesFromRaw(points) {
  const f = computeWheelFeatures(points);
  f.rawPoints = points;
  return f;
}

function terrainDriveMultiplier(seg, features, conditions) {
  if (!seg) return 1;
  if (seg.type === 'sand') {
    // wider/flatter shapes float over sand better. wideBias (rolled per
    // race) shifts how much width is needed before it starts paying off —
    // a race with loose/deep sand demands a genuinely wide wheel, a race
    // with firmer sand is more forgiving.
    const bias = (conditions && conditions.sand) ? conditions.sand.wideBias : 0.8;
    const wideness = Math.max(0, Math.min(1, (features.widthRatio - bias) / 1.2));
    return 0.35 + wideness * 0.65;
  }
  if (seg.type === 'water') {
    // densityFactor (rolled per race) is how many paddle-blades it takes to
    // hit full effect — thick/viscous water needs more paddles than thin
    // water, so a smooth wheel (0 protrusions) never has a "safe" default:
    // it's always near the 0.15 floor here regardless of size.
    const densityFactor = (conditions && conditions.water) ? conditions.water.densityFactor : 1;
    const paddle = Math.max(0, Math.min(1, features.protrusions / (6 * densityFactor)));
    return 0.15 + paddle * 1.1;
  }
  if (seg.type === 'ice') {
    // fine tread teeth restore a bit of grip on top of the low base friction
    return 0.7 + Math.max(0, Math.min(1, features.protrusions / 8)) * 0.5;
  }
  if (seg.type === 'stairs' || seg.type === 'rocks') {
    // The step/rock geometry already does most of the work (a smooth
    // circle genuinely can climb a small enough step in real physics) —
    // this tops that up so actual tread/teeth give a real, measurable
    // edge over a plain circle of the same size, instead of size alone
    // being the whole story.
    const tread = Math.max(0, Math.min(1, features.protrusions / 6));
    return 0.55 + tread * 0.7;
  }
  return 1;
}

function onBeforeUpdate() {
  if (!raceRunning) return;
  for (const car of [player, ai]) {
    if (car.finished) continue;
    const seg = segmentAt(track.segments, car.chassis.position.x);
    const mul = terrainDriveMultiplier(seg, car.wheelFeatures || {}, raceConditions);
    // targetSpeed here is angular velocity, and actual ground speed is
    // angularVelocity * radius — so without this correction, a bigger wheel
    // gets more real speed for free on every terrain, before shape or grip
    // even come into it. That's what was making large wheels win regardless
    // of terrain, which defeats the "draw the right shape" premise of the
    // game. Scaling by REFERENCE_WHEEL_R / actual radius holds ground speed
    // roughly constant across wheel sizes by default — a bigger wheel's real
    // advantage (rolling over a step more easily, per the terrain legend)
    // still comes through on its own from the rigid-body geometry, it's just
    // no longer stacked with a free speed bonus everywhere else too.
    const radiusCorrection = REFERENCE_WHEEL_R / (car.wheelRadius || REFERENCE_WHEEL_R);
    const targetSpeed = BASE_DRIVE_SPEED * mul * radiusCorrection;

    // Drive by directly commanding each wheel's spin speed, ramped smoothly
    // toward the target. (I briefly replaced this with a torque-limited
    // motor to fix the stair-flipping bug below — that was the right idea
    // in principle, but the gain/torque values I picked were tuned purely
    // for "doesn't flip" and killed real driving speed everywhere, then my
    // attempt to bring speed back reintroduced tipping. Reverted to this,
    // since it's what actually drove correctly on every terrain except
    // stairs — the fix for stairs belongs in chassis stability below, not
    // in how the wheel spin itself is commanded.)
    for (const wheel of [car.wheelA, car.wheelB]) {
      const newAV = wheel.angularVelocity + (targetSpeed - wheel.angularVelocity) * DRIVE_RESPONSE;
      Body.setAngularVelocity(wheel, newAV);
    }

    // Stair assist: when traversing stairs, apply wheel-level forward+up
    // forces and temporarily boost wheel friction so teeth/wide treads can
    // convert spin into forward progress instead of slipping. Restore
    // original friction when leaving stairs.
    if (seg && seg.type === 'stairs') {
      try {
        const protrusionFactor = Math.max(0, Math.min(1, ((car.wheelFeatures || {}).protrusions || 0) / 6));
        const widenessFactor = Math.max(0, Math.min(1, (((car.wheelFeatures || {}).widthRatio || 1) - 0.8) / 1.2));
        // Tuned assist scaling: base + contributions from protrusions/wideness.
        // Floor raised from 0.5 to 0.7 so a plain roundish wheel with only
        // modest tread — not a glitchy spike shape — still gets over a step
        // with the riser/tread geometry above; protrusions/wideness still
        // give a real, measurable edge on top of that.
        // This runs once per animation frame, but Engine.update() below
        // runs PHYSICS_SUBSTEPS times per frame and Matter clears a body's
        // applied force after each Engine.update() call — so an unscaled
        // force here is only actually live for 1 of every 4 physics steps,
        // making it 4x weaker than it looks. Scale by PHYSICS_SUBSTEPS to
        // compensate, same as it'd be if reapplied every sub-step.
        const baseAssist = 0.002 * PHYSICS_SUBSTEPS;
        const pushScale = baseAssist * (0.7 + 0.7 * protrusionFactor + 0.5 * widenessFactor);
        const lift = 0.0006 * PHYSICS_SUBSTEPS;
        for (const wheel of [car.wheelA, car.wheelB]) {
          if (!wheel) continue;
          // remember original friction so we can restore later
          if (wheel._origFriction === undefined) wheel._origFriction = wheel.friction || 0.85;
          const boosted = wheel._origFriction * 1.8;
          wheel.friction = boosted;
          // Apply a forward (x) and small upward (y) force at the wheel
          const forward = pushScale * (targetSpeed >= 0 ? 1 : -1);
          Body.applyForce(wheel, wheel.position, { x: forward * wheel.mass, y: -lift * wheel.mass });
        }
      } catch (e) {
        console.warn('stair assist failed', e);
      }
    } else {
      // Restore wheel friction when not on stairs
      for (const wheel of [car.wheelA, car.wheelB]) {
        if (!wheel) continue;
        if (wheel._origFriction !== undefined) {
          wheel.friction = wheel._origFriction;
          delete wheel._origFriction;
        }
      }
    }

    // Chassis has nothing else damping its rotation, so any bump (a stair
    // edge, a wheel suddenly grabbing traction) has nothing to stop it
    // building into a full flip. Damping alone (multiplying by
    // CHASSIS_ANGULAR_DAMPING) wasn't enough on its own — a stair riser can
    // inject enough angular velocity in one substep that even a 10%/frame
    // decay doesn't catch up before it's already flipped. Clamping the
    // chassis's angular velocity to a hard cap after damping (confirmed via
    // simulation: keeps stair-climbing pitch under ~30° and lets it recover
    // to level, instead of tumbling past 90° and never coming back) stops
    // that — it doesn't touch position/speed, only how fast the car can
    // rotate in a single frame.
    let chassisAV = car.chassis.angularVelocity * CHASSIS_ANGULAR_DAMPING;
    chassisAV = Math.max(-MAX_CHASSIS_ANGULAR_VELOCITY, Math.min(MAX_CHASSIS_ANGULAR_VELOCITY, chassisAV));
    Body.setAngularVelocity(car.chassis, chassisAV);

    // sand extra drag
    if (seg && seg.type === 'sand') {
      const bias = (raceConditions && raceConditions.sand) ? raceConditions.sand.wideBias : 0.8;
      const wideness = Math.max(0, Math.min(1, ((car.wheelFeatures || {}).widthRatio - bias) / 1.2));
      const drag = 0.985 - 0.01 * (1 - wideness);
      Body.setVelocity(car.chassis, { x: car.chassis.velocity.x * drag, y: car.chassis.velocity.y });

      // Kick up dust while actually moving through sand — a stalled wheel
      // shouldn't be throwing grain, only real travel should.
      if (Math.abs(car.chassis.velocity.x) > 0.6) {
        const pool = car === player ? dustPools.player : dustPools.ai;
        const sceneX = car.laneSceneX;
        const sceneY = -(car.wheelA.position.y - car.groundY);
        const sceneZ = -car.chassis.position.x;
        const burst = 2 + Math.floor(Math.random() * 3);
        for (let d = 0; d < burst; d++) spawnDust(pool, sceneX, sceneY, sceneZ);
      }
    }
    // water buoyancy-ish force — strength rolled per race (see raceConditions)
    if (seg && seg.type === 'water') {
      const buoyancy = (raceConditions && raceConditions.water) ? raceConditions.water.buoyancy : 0.0009;
      Body.applyForce(car.chassis, car.chassis.position, { x: 0, y: -buoyancy * car.chassis.mass });
    }

    trackTelemetry(car, seg);
    handleStuckAndFlip(car);

    // If the AI is genuinely stuck (not just slow) on the current obstacle,
    // let it try a different wheel instead of staying frozen for the rest
    // of the race. Cooldown prevents spamming the API with retries.
    if (car === ai && seg && seg.type !== 'flat' && seg.type !== 'finish' &&
        car.telemetry && car.telemetry.stuckMs > 3200) {
      const now = performance.now();
      if (!car.lastRetryAt || now - car.lastRetryAt > 3500) {
        car.lastRetryAt = now;
        car.telemetry.stuckMs = 0; // give the new wheel a clean slate
        updateAIWheelForSegment(seg);
      }
    }
  }
  updateCameraAndHud();
  checkFinish();
}

function trackTelemetry(car, seg) {
  const segIndex = track.segments.indexOf(seg);
  if (segIndex !== car.currentSegIndex) {
    finalizeSegment(car); // scores the segment we're leaving (if any)
    car.currentSegIndex = segIndex;
    car.telemetry = {
      seg, enterTime: performance.now(), enterX: car.chassis.position.x,
      stuckMs: 0, maxTiltDeg: 0, lastTick: performance.now()
    };
    if (car === player && seg.type !== 'flat' && seg.type !== 'finish') {
      showIncoming(seg.type);
    }
  }
  if (car.telemetry) {
    const t = car.telemetry;
    const now = performance.now();
    const dt = now - t.lastTick; t.lastTick = now;
    const speed = Math.hypot(car.chassis.velocity.x, car.chassis.velocity.y);
    if (speed < 0.25) t.stuckMs += dt;
    const tiltDeg = Math.abs(car.chassis.angle * 180 / Math.PI) % 360;
    const normTilt = tiltDeg > 180 ? 360 - tiltDeg : tiltDeg;
    t.maxTiltDeg = Math.max(t.maxTiltDeg, normTilt);
  }
}

function finalizeSegment(car) {
  const t = car.telemetry;
  if (!t || !t.seg || t.seg.type === 'flat' || t.seg.type === 'finish') { car.telemetry = null; return; }
  // Use wheel-set time/position if the wheel was mounted after entering
  // the segment — this attributes the measured telemetry to the active
  // wheel from the moment it was installed until it changed.
  const startTime = Math.max(t.enterTime || 0, car.wheelSetAt || 0);
  const startX = Math.max(t.enterX || 0, car.wheelSetX || 0);
  const distance = Math.max(0, car.chassis.position.x - startX);
  const timeMs = Math.max(1, performance.now() - startTime);
  // Adjust stuckMs to subtract any accumulated stuck time prior to wheel set
  const stuckMs = Math.max(0, (t.stuckMs || 0) - (car.wheelSetStuckBaseline || 0));
  const telemetry = {
    distance, segmentLength: t.seg.len, timeMs,
    avgSpeed: distance / (timeMs / 1000), stuckMs,
    maxTiltDeg: t.maxTiltDeg, flippedOver: t.maxTiltDeg > 100
  };
  const score = scoreFromTelemetry(telemetry);
  submitExample(car, t.seg.type, telemetry, score);
  if (car === player) {
    statScore.textContent = score + '/100';
    logLine(`${t.seg.type.toUpperCase()}: ${score}/100 (you)`);
  } else {
    logLine(`${t.seg.type.toUpperCase()}: ${score}/100 (AI)`);
  }
}

// Mirrors server.js scoreFromTelemetry — server re-derives the authoritative
// score from the same telemetry, this copy is just for instant UI feedback.
function scoreFromTelemetry(t) {
  const completion = Math.max(0, Math.min(1, t.distance / t.segmentLength));
  if (t.flippedOver) return Math.round(5 * completion);
  const IDEAL_PX_PER_SEC = 300;
  const idealTimeMs = (t.segmentLength / IDEAL_PX_PER_SEC) * 1000;
  const speedScore = Math.max(0, Math.min(1, idealTimeMs / t.timeMs));
  const stuckPenalty = Math.max(0, 1 - t.stuckMs / Math.max(1, t.timeMs));
  const stabilityScore = Math.max(0, 1 - Math.min(1, t.maxTiltDeg / 90));
  const raw = completion * 45 + speedScore * 30 + stuckPenalty * 15 + stabilityScore * 10;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function handleStuckAndFlip(car) {
  const tiltDeg = Math.abs(((car.chassis.angle * 180 / Math.PI) % 360 + 360) % 360);
  const normTilt = tiltDeg > 180 ? 360 - tiltDeg : tiltDeg;
  if (normTilt > 100) {
    if (!car.flippedSince) car.flippedSince = performance.now();
    else if (performance.now() - car.flippedSince > 1400) {
      Body.setAngle(car.chassis, 0);
      Body.setPosition(car.chassis, { x: car.chassis.position.x, y: car.groundY - 80 });
      Body.setVelocity(car.chassis, { x: 1, y: 0 });
      Body.setAngularVelocity(car.chassis, 0);
      car.flippedSince = null;
    }
  } else car.flippedSince = null;

  if (car.telemetry && car.telemetry.stuckMs > 4500) {
    Body.applyForce(car.chassis, car.chassis.position, { x: 0.02 * car.chassis.mass, y: -0.03 * car.chassis.mass });
    car.telemetry.stuckMs = 0;
  }
}

function checkFinish() {
  for (const car of [player, ai]) {
    if (!car.finished && car.chassis.position.x >= track.totalLength - 30) {
      car.finished = true;
      car.finishTime = performance.now();
    }
  }
  if (player.finished && ai.finished && raceRunning) endRace();
  else if (player.finished && !ai.finished && performance.now() - player.finishTime > 15000) endRace();
}

function endRace() {
  raceRunning = false;
  const winner = (!ai.finished || (player.finishTime && player.finishTime < ai.finishTime)) ? 'YOU' : 'THE AI';
  resultBody.innerHTML = `
    <div><b>${winner}</b> won the race</div>
    <div>Your time: ${player.finishTime ? ((player.finishTime - raceStartTime) / 1000).toFixed(1) + 's' : 'DNF'}</div>
    <div>AI time: ${ai.finishTime ? ((ai.finishTime - raceStartTime) / 1000).toFixed(1) + 's' : 'DNF'}</div>
  `;
  resultPanel.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Server communication (training data)
// ---------------------------------------------------------------------------
async function submitExample(car, terrainType, telemetry, localScore) {
  try {
    // Ensure we never send more than the server's 60-point limit by
    // resampling the drawn outline by arc-length (preserves shape).
    function resampleClosedPolyline(points, maxPts = 60) {
      if (!points || points.length === 0) return [];
      if (points.length <= maxPts) return points.slice();
      // Build a closed loop for sampling
      const closed = points.slice();
      const first = closed[0], last = closed[closed.length - 1];
      if (first.x !== last.x || first.y !== last.y) closed.push({ x: first.x, y: first.y });

      const segLens = new Array(closed.length - 1);
      let total = 0;
      for (let i = 0; i < closed.length - 1; i++) {
        const dx = closed[i + 1].x - closed[i].x;
        const dy = closed[i + 1].y - closed[i].y;
        const l = Math.hypot(dx, dy);
        segLens[i] = l;
        total += l;
      }
      if (total === 0) return [ { x: closed[0].x, y: closed[0].y } ];

      const step = total / maxPts;
      const out = [];
      let segIdx = 0, segAccum = 0;
      for (let i = 0; i < maxPts; i++) {
        const target = i * step;
        while (segIdx < segLens.length - 1 && segAccum + segLens[segIdx] < target) {
          segAccum += segLens[segIdx];
          segIdx++;
        }
        const a = closed[segIdx], b = closed[segIdx + 1];
        const along = Math.max(0, Math.min(1, (target - segAccum) / (segLens[segIdx] || 1)));
        out.push({ x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along });
      }
      return out;
    }

    const raw = (car.wheelFeatures && car.wheelFeatures.rawPoints) || defaultWheelPoints();
    const toSend = resampleClosedPolyline(raw, 60);

    const res = await fetch('/api/examples', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: car === player ? playerId : 'ai_' + playerId,
        terrainType,
        terrainFeatures: [],
        wheelPoints: toSend.map(p => [p.x, p.y]),
        wheelFeatures: [car.wheelFeatures.maxR, car.wheelFeatures.widthRatio, car.wheelFeatures.protrusions, car.wheelFeatures.irregularity],
        telemetry,
        source: car === player ? 'human' : 'ai'
      })
    });
    // The old version never looked at the response at all — fetch() only
    // rejects on a network-level failure, NOT on a 4xx/5xx from the server,
    // so a broken Neon connection (which shows up as a 500 from /api/examples)
    // was passing through here completely silently every single time.
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (_) { /* body wasn't JSON */ }
      console.error(`submitExample failed: ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''} (check /api/health for a DB connection issue)`);
      logLine(`⚠️ save failed (${res.status}) — this play wasn't recorded`);
    }
  } catch (e) {
    // This branch is only a real network/offline failure now, not a masked
    // server error.
    console.error('submitExample: network error', e);
    logLine('⚠️ save failed (offline?) — this play wasn\'t recorded');
  }
}

async function aiGenerateWheel(terrainType) {
  try {
    const res = await fetch(`/api/examples?terrainType=${terrainType}&limit=8`);
    if (!res.ok) {
      console.warn(`AI: /api/examples returned ${res.status} for ${terrainType} — check /api/health (likely a DB connection issue).`);
      return { points: coldStartWheel(terrainType), reason: `server error (${res.status}) — cold-start` };
    }
    const examples = await res.json();
    if (examples.length === 0) {
      return { points: coldStartWheel(terrainType), reason: 'no human data yet — cold-start' };
    }
    if (Math.random() <= 0.15) {
      return { points: coldStartWheel(terrainType), reason: `cold-start (random roll, ${examples.length} examples available)` };
    }
    // imitate a strong human example, weighted toward higher scores, with mutation
    const weights = examples.map(e => e.score * e.score + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, pick = examples[0];
    for (let i = 0; i < examples.length; i++) { r -= weights[i]; if (r <= 0) { pick = examples[i]; break; } }
    const jitter = 6;
    const points = pick.wheelPoints.map(([x, y]) => ({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter }));
    return { points, reason: `imitating score-${pick.score} human wheel (${examples.length} available)` };
  } catch (e) {
    console.warn('AI: /api/examples fetch failed — check network/console (falling back to cold-start):', e);
    return { points: coldStartWheel(terrainType), reason: 'fetch failed — cold-start' };
  }
}

function coldStartWheel(terrainType) {
  // Day-1 AI: mostly clueless, occasionally stumbles onto something sensible.
  const n = 10 + Math.floor(Math.random() * 6);
  const pts = [];
  const baseR = 30 + Math.random() * 40;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const noise = (Math.random() - 0.5) * baseR * 0.9;
    pts.push({ x: Math.cos(a) * (baseR + noise), y: Math.sin(a) * (baseR + noise) });
  }
  return pts;
}

async function updateAIWheelForSegment(seg) {
  if (!seg || seg.type === 'flat' || seg.type === 'finish') return;
  const { points, reason } = await aiGenerateWheel(seg.type);
  logLine(`${seg.type.toUpperCase()}: ${reason}`);
  const features = computeWheelFeatures(points);
  features.rawPoints = points;
  mountWheels(ai, points, features);
}

function logLine(text) {
  const div = document.createElement('div');
  div.textContent = text;
  aiLogBody.prepend(div);
  while (aiLogBody.children.length > 12) aiLogBody.removeChild(aiLogBody.lastChild);
}

// ---------------------------------------------------------------------------
// Drawing panel
// ---------------------------------------------------------------------------
let strokePoints = [];
let drawing = false;

function drawStroke() {
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (strokePoints.length < 2) return;
  const ox = drawCanvas.width / 2, oy = drawCanvas.height / 2;
  dctx.strokeStyle = '#3ddc97';
  dctx.lineWidth = 3;
  dctx.beginPath();
  dctx.moveTo(strokePoints[0].x + ox, strokePoints[0].y + oy);
  for (const p of strokePoints) dctx.lineTo(p.x + ox, p.y + oy);
  if (strokePoints.length > 3) dctx.closePath();
  dctx.stroke();
}

function canvasPoint(evt) {
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = drawCanvas.width / rect.width, scaleY = drawCanvas.height / rect.height;
  const cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
  const cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
  return { x: cx * scaleX - drawCanvas.width / 2, y: cy * scaleY - drawCanvas.height / 2 };
}

function updateBlueprintReadout() {
  if (strokePoints.length < 4) {
    bpRadius.textContent = bpWidth.textContent = bpTread.textContent = bpIrreg.textContent = '--';
    return;
  }
  const f = computeWheelFeatures(strokePoints);
  bpRadius.textContent = Math.round(f.maxR) + 'px';
  bpWidth.textContent = f.widthRatio.toFixed(2) + 'x';
  bpTread.textContent = f.protrusions;
  bpIrreg.textContent = (f.irregularity * 100).toFixed(0) + '%';
}

drawCanvas.addEventListener('pointerdown', e => { drawing = true; strokePoints = [canvasPoint(e)]; });
drawCanvas.addEventListener('pointermove', e => { if (drawing) { strokePoints.push(canvasPoint(e)); drawStroke(); updateBlueprintReadout(); } });
window.addEventListener('pointerup', () => { drawing = false; });

btnClear.addEventListener('click', () => { strokePoints = []; dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); updateBlueprintReadout(); });

btnUseWheel.addEventListener('click', () => {
  if (!player || strokePoints.length < 6) return;
  const features = computeWheelFeatures(strokePoints);
  features.rawPoints = strokePoints.slice();
  mountWheels(player, strokePoints, features);
  logLine('Mounted new wheel — measuring performance live.');
});

// ---------------------------------------------------------------------------
// Rendering — real 3D chase camera. Terrain/car meshes were already built
// (build3DTerrain / build3DCarMeshes); each frame we just sync mesh
// transforms from the physics bodies and move the camera to trail the
// player from behind and slightly above, angled down — a normal third-
// person racer camera, not a flat 2D view.
// ---------------------------------------------------------------------------
function addStaticSceneDecor() {
  // finish line banners for both lanes
  const bannerMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, flatShading: true });
  [{ x: -LANE_X_OFFSET, y: PLAYER_GROUND_Y }, { x: LANE_X_OFFSET, y: AI_GROUND_Y }].forEach(({ x }) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(8, 120, 8), bannerMat);
    post.position.set(x - LANE_VISUAL_WIDTH / 2, 60, -(track.totalLength - 30));
    three.scene.add(post);
    threeGroups.decor.push(post);
    const post2 = post.clone();
    post2.position.x = x + LANE_VISUAL_WIDTH / 2;
    three.scene.add(post2);
    threeGroups.decor.push(post2);
    const banner = new THREE.Mesh(new THREE.BoxGeometry(LANE_VISUAL_WIDTH + 16, 20, 4), bannerMat);
    banner.position.set(x, 110, -(track.totalLength - 30));
    three.scene.add(banner);
    threeGroups.decor.push(banner);
  });

  // dashed centre divider between the two lanes, laid flat on the ground
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, flatShading: true });
  for (let x = 0; x < track.totalLength; x += 60) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 26), dashMat);
    dash.position.set(0, 1, -x);
    three.scene.add(dash);
    threeGroups.decor.push(dash);
  }

  // ground-level fill under everything so there's no gap between the two lanes
  const fillerMat = new THREE.MeshStandardMaterial({ color: 0x22303c, flatShading: true, roughness: 1 });
  const filler = new THREE.Mesh(new THREE.PlaneGeometry(6000, track.totalLength + 800), fillerMat);
  filler.rotation.x = -Math.PI / 2;
  filler.position.set(0, -140, -track.totalLength / 2);
  three.scene.add(filler);
  threeGroups.decor.push(filler);
}

// Diagonal (three-quarter) chase angle, in degrees, measured off dead-behind.
// 0 = straight behind (old behavior). Positive swings the camera out to the
// player's side while it keeps tracking forward motion.
const CAM_DIAGONAL_DEG = 55;
const CAM_DIST = 340;   // horizontal distance back from the look target
const CAM_HEIGHT = 260; // height above the car's own ground line

function updateCamera() {
  const px = player.chassis.position.x;
  const py = -(player.chassis.position.y - player.groundY);
  const targetZ = -px;

  // Same trailing distance as before, but rotated out to the side by
  // CAM_DIAGONAL_DEG instead of sitting dead-behind on the centerline —
  // gives a proper angled/three-quarter view instead of a straight rear view.
  const rad = CAM_DIAGONAL_DEG * Math.PI / 180;
  const desired = {
    x: -Math.sin(rad) * CAM_DIST,
    y: py + CAM_HEIGHT,
    z: targetZ + Math.cos(rad) * CAM_DIST
  };
  if (!camState.x) Object.assign(camState, desired);
  camState.x += (desired.x - camState.x) * 0.08;
  camState.y += (desired.y - camState.y) * 0.08;
  camState.z += (desired.z - camState.z) * 0.08;

  three.camera.position.set(camState.x, camState.y, camState.z);
  three.camera.lookAt(0, py + 20, targetZ - 260);
}

function renderWorld() {
  if (!physics.world || !three.renderer) return;
  sync3DCar(player);
  sync3DCar(ai);
  const now = performance.now();
  const dt = Math.min(0.05, (now - (renderWorld._lastT || now)) / 1000);
  renderWorld._lastT = now;
  updateDust(dustPools.player, dt);
  updateDust(dustPools.ai, dt);
  updateCamera();
  three.renderer.render(three.scene, three.camera);
}

const camState = { x: 0, y: 0, z: 0 };

function updateCameraAndHud() {
  statDist.textContent = Math.max(0, Math.round(player.chassis.position.x)) + 'm';
  statSpeed.textContent = Math.round(Math.abs(player.chassis.velocity.x) * 20);
}

function showIncoming(type) {
  incomingType.textContent = TERRAIN_LABEL[type] || type.toUpperCase();
  incomingBanner.classList.remove('hidden');
  clearTimeout(showIncoming._t);
  showIncoming._t = setTimeout(() => incomingBanner.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------------------
// AI trigger loop: watch which segment the AI is in, regenerate its wheel
// whenever it crosses into a new non-flat segment.
// ---------------------------------------------------------------------------
let lastAISeg = -1;
function watchAISegment() {
  if (!raceRunning) return;
  const seg = segmentAt(track.segments, ai.chassis.position.x);
  const idx = track.segments.indexOf(seg);
  if (idx !== lastAISeg) { lastAISeg = idx; updateAIWheelForSegment(seg); }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let raceStartTime = 0;
// Matter.js has no continuous collision detection, so a body moving far
// enough in a single step (a wheel with real speed, against ground boxes
// only ~40px thick) can end its step already past the floor with no
// overlap ever detected — that's the "glitching through floors". Splitting
// each frame into several smaller physics steps instead of one big one
// shrinks how far anything can travel between collision checks, without
// changing the simulated speed of anything.
function loop() {
  if (raceRunning) {
    onBeforeUpdate();
    for (let i = 0; i < PHYSICS_SUBSTEPS; i++) {
      Engine.update(physics.engine, (1000 / 60) / PHYSICS_SUBSTEPS);
    }
    watchAISegment();
  }
  renderWorld();
  requestAnimationFrame(loop);
}

function startRace() {
  resultPanel.classList.add('hidden');
  initWorld();
  raceRunning = true;
  raceStartTime = performance.now();
  lastAISeg = -1;
  btnStart.disabled = true;
  logLine('Race started.');
  // Terrain conditions are randomized per race (see rollRaceConditions) so
  // there's no single wheel shape that's always right — surface what got
  // rolled instead of leaving it as hidden RNG.
  logLine(describeRaceConditions(raceConditions));
}

btnStart.addEventListener('click', startRace);
btnRestart.addEventListener('click', () => { btnStart.disabled = false; startRace(); });

// Set up the 3D scene first, then build the physics world (which also
// creates the 3D meshes that live inside that scene) immediately on page
// load — not just on Start — so the player object exists right away and
// you can draw/mount a wheel before the race even begins.
initThreeScene();
dustPools.player = createDustPool(DUST_POOL_SIZE);
dustPools.ai = createDustPool(DUST_POOL_SIZE);
initWorld();
resizeWorldCanvas();
loop();
