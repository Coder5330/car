// game.js — AI Wheel Racing
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PLAYER_GROUND_Y = 420;
const LANE_GAP = 210; // vertical world-space separation between the two lanes
const AI_GROUND_Y = PLAYER_GROUND_Y + LANE_GAP;
const SEG_LEN = 900;
const BUFFER_LEN = 160;
const BASE_DRIVE_SPEED = 0.45; // wheel angular velocity target
const MIN_WHEEL_R = 15;
const MAX_WHEEL_R = 46;

// Two separate physical lanes: the AI's terrain and your terrain never touch
// or collide with each other — each car only has a collision mask for its
// own lane's ground. Same segment layout on both, so it's a fair race, but
// genuinely "AI on one track, you on another."
const CAT_PLAYER_GROUND = 0x0002;
const CAT_AI_GROUND = 0x0004;

// Camera "look": a diagonal third-person view instead of flat side-on.
// This is a classic pseudo-3D trick (shear + vertical squash) rather than
// true 3D — it keeps the 2D physics that makes drawn wheels genuinely climb
// terrain, while reading as an angled chase-cam instead of a flat 2D strip.
const VIEW_SKEW = 0.42;
const VIEW_SQUASH = 0.6;

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
const wctx = worldCanvas.getContext('2d');
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

function resizeWorldCanvas() {
  worldCanvas.width = worldCanvas.clientWidth;
  worldCanvas.height = worldCanvas.clientHeight;
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

function buildGroundBodies(world, segments, baseY, category) {
  const bodies = [];
  const waterZones = [];
  const sandZones = [];
  const filter = { category };

  for (const seg of segments) {
    const w = seg.len;
    const cx = seg.x0 + w / 2;
    const opts = { isStatic: true, friction: 0.8, render: {}, collisionFilter: filter };

    switch (seg.type) {
      case 'flat':
      case 'finish': {
        const b = Bodies.rectangle(cx, baseY + 20, w, 40, { ...opts, friction: 0.8 });
        b.groundType = seg.type; bodies.push(b);
        break;
      }
      case 'stairs': {
        const stepW = 60, stepH = 24, steps = Math.floor(w / stepW);
        for (let i = 0; i < steps; i++) {
          const rise = Math.min(i, 6) * stepH; // cap so it plateaus
          const bx = seg.x0 + i * stepW + stepW / 2;
          const by = baseY - rise + 20;
          const b = Bodies.rectangle(bx, by, stepW + 2, 40 + rise, { ...opts, friction: 0.95 });
          b.groundType = 'stairs'; bodies.push(b);
        }
        break;
      }
      case 'sand': {
        const b = Bodies.rectangle(cx, baseY + 20, w, 40, { ...opts, friction: 1.1 });
        b.groundType = 'sand'; bodies.push(b);
        sandZones.push(seg);
        break;
      }
      case 'water': {
        const b = Bodies.rectangle(cx, baseY + 20, w, 40, { ...opts, friction: 0.3 });
        b.groundType = 'water'; bodies.push(b);
        waterZones.push(seg);
        break;
      }
      case 'ice': {
        const b = Bodies.rectangle(cx, baseY + 20, w, 40, { ...opts, friction: 0.02 });
        b.groundType = 'ice'; bodies.push(b);
        break;
      }
      case 'rocks': {
        const chunk = 45, n = Math.floor(w / chunk);
        for (let i = 0; i < n; i++) {
          const bump = (Math.sin(i * 1.7) * 0.5 + (Math.random() - 0.5)) * 16;
          const bx = seg.x0 + i * chunk + chunk / 2;
          const by = baseY + 20 - bump;
          const b = Bodies.rectangle(bx, by, chunk + 2, 40 + bump, { ...opts, friction: 0.95 });
          b.groundType = 'rocks'; bodies.push(b);
        }
        break;
      }
      case 'steep': {
        const angle = -0.35; // radians, climbing
        const len = Math.hypot(w, w * Math.tan(0.35));
        const rise = w * Math.tan(0.35);
        const b = Bodies.rectangle(cx, baseY + 20 - rise / 2, len, 40, { ...opts, friction: 0.95, angle });
        b.groundType = 'steep'; bodies.push(b);
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
  return { vertices: Vertices.hull(verts), radius: targetR };
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
function createCar(startX, color, group, laneGroundY, laneMask) {
  const chassis = Bodies.rectangle(startX, laneGroundY - 60, 96, 26, {
    density: 0.0022, friction: 0.4, collisionFilter: { group, mask: laneMask },
    render: { fillStyle: color }
  });
  const car = { chassis, color, group, mask: laneMask, groundY: laneGroundY,
    wheelA: null, wheelB: null, cA: null, cB: null,
    driveMul: 1, currentSegIndex: -1, telemetry: null, finished: false, finishTime: null,
    flippedSince: null, stuckAccum: 0 };
  mountWheels(car, defaultWheelPoints(), { maxR: 60, widthRatio: 1, irregularity: 0, protrusions: 0, centroid: { x: 0, y: 0 } });

  // Spawn the whole car seated right on the ground (tiny 3px gap for a
  // gentle settle) instead of floating ~25px above it — that gap was the
  // "is that meant to be starting?" free-fall at the start of every race.
  const bottomY = car.wheelA.position.y + car.wheelRadius;
  const dy = (laneGroundY - 3) - bottomY;
  Body.translate(car.chassis, { x: 0, y: dy });
  Body.translate(car.wheelA, { x: 0, y: dy });
  Body.translate(car.wheelB, { x: 0, y: dy });

  return car;
}

function mountWheels(car, points, features) {
  const world = physics.world;
  const prevVelocity = car.chassis ? car.chassis.velocity : { x: 0, y: 0 };
  const prevAngularVel = car.wheelA ? car.wheelA.angularVelocity : 0;
  if (car.wheelA) World.remove(world, [car.wheelA, car.wheelB, car.cA, car.cB]);

  const { vertices, radius } = pointsToPhysicsVertices(points, features);
  const cx = car.chassis.position.x, cy = car.chassis.position.y;
  const offsets = [{ x: -32, y: 16 }, { x: 32, y: 16 }];
  const filter = { group: car.group, mask: car.mask };

  const wheels = offsets.map(off => {
    const w = Bodies.fromVertices(cx + off.x, cy + off.y, [vertices], {
      friction: 1.0, frictionStatic: 1.2, density: 0.0035, restitution: 0,
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

  // Small give, not a stretchy spring: stiffness 1 / length 0 (last version)
  // looked mechanically dead; stiffness 0.45 (previous fix) let the wheels
  // physically tear away from the chassis under constant drive torque —
  // that's the "wheels left behind" bug. This lands in between: enough
  // give to feel like suspension, stiff enough that it can't stretch out.
  const constraints = offsets.map((off, i) => Constraint.create({
    bodyA: car.chassis, pointA: off,
    bodyB: wheels[i], pointB: { x: 0, y: 0 },
    stiffness: 0.9, damping: 0.25, length: 3
  }));

  World.add(world, [...wheels, ...constraints]);
  car.wheelA = wheels[0]; car.wheelB = wheels[1];
  car.cA = constraints[0]; car.cB = constraints[1];
  car.wheelFeatures = features;
  car.wheelRadius = radius;
}

const PLAYER_COLOR = '#e8e6df';
const AI_COLOR = '#5a6b7a';

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------
const physics = {};
let track = null;
let ground = null;
let player = null;
let ai = null;
let raceRunning = false;
let cameraX = 0;

function initWorld() {
  physics.engine = Engine.create();
  physics.world = physics.engine.world;
  physics.world.gravity.y = 1;

  track = buildTrackPlan();
  const groundPlayer = buildGroundBodies(physics.world, track.segments, PLAYER_GROUND_Y, CAT_PLAYER_GROUND);
  const groundAI = buildGroundBodies(physics.world, track.segments, AI_GROUND_Y, CAT_AI_GROUND);
  ground = { player: groundPlayer, ai: groundAI, bodies: [...groundPlayer.bodies, ...groundAI.bodies] };

  const prevPlayerFeatures = player ? player.wheelFeatures : null;
  const prevPlayerPoints = prevPlayerFeatures ? prevPlayerFeatures.rawPoints : null;

  player = createCar(60, PLAYER_COLOR, -1, PLAYER_GROUND_Y, CAT_PLAYER_GROUND);
  ai = createCar(60, AI_COLOR, -2, AI_GROUND_Y, CAT_AI_GROUND);

  // Keep whatever wheel the player already drew (e.g. before hitting Start,
  // or from a previous race) instead of resetting to the default circle.
  if (prevPlayerPoints) {
    mountWheels(player, prevPlayerPoints, computeWheelFeaturesFromRaw(prevPlayerPoints));
  }

  Events.on(physics.engine, 'beforeUpdate', onBeforeUpdate);
}

function computeWheelFeaturesFromRaw(points) {
  const f = computeWheelFeatures(points);
  f.rawPoints = points;
  return f;
}

function terrainDriveMultiplier(seg, features) {
  if (!seg) return 1;
  if (seg.type === 'sand') {
    // wider/flatter shapes float over sand better
    const wideness = Math.max(0, Math.min(1, (features.widthRatio - 0.8) / 1.2));
    return 0.35 + wideness * 0.65;
  }
  if (seg.type === 'water') {
    const paddle = Math.max(0, Math.min(1, features.protrusions / 6));
    return 0.15 + paddle * 1.1;
  }
  if (seg.type === 'ice') {
    // fine tread teeth restore a bit of grip on top of the low base friction
    return 0.7 + Math.max(0, Math.min(1, features.protrusions / 8)) * 0.5;
  }
  return 1;
}

function onBeforeUpdate() {
  if (!raceRunning) return;
  for (const car of [player, ai]) {
    if (car.finished) continue;
    const seg = segmentAt(track.segments, car.chassis.position.x);
    const mul = terrainDriveMultiplier(seg, car.wheelFeatures || {});
    const speed = BASE_DRIVE_SPEED * mul;
    Body.setAngularVelocity(car.wheelA, speed);
    Body.setAngularVelocity(car.wheelB, speed);

    // sand extra drag
    if (seg && seg.type === 'sand') {
      const wideness = Math.max(0, Math.min(1, ((car.wheelFeatures || {}).widthRatio - 0.8) / 1.2));
      const drag = 0.985 - 0.01 * (1 - wideness);
      Body.setVelocity(car.chassis, { x: car.chassis.velocity.x * drag, y: car.chassis.velocity.y });
    }
    // water buoyancy-ish force
    if (seg && seg.type === 'water') {
      Body.applyForce(car.chassis, car.chassis.position, { x: 0, y: -0.0009 * car.chassis.mass });
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
  const distance = Math.max(0, car.chassis.position.x - t.enterX);
  const timeMs = Math.max(1, performance.now() - t.enterTime);
  const telemetry = {
    distance, segmentLength: t.seg.len, timeMs,
    avgSpeed: distance / (timeMs / 1000), stuckMs: t.stuckMs,
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
    await fetch('/api/examples', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: car === player ? playerId : 'ai_' + playerId,
        terrainType,
        terrainFeatures: [],
        wheelPoints: (car.wheelFeatures.rawPoints || defaultWheelPoints()).map(p => [p.x, p.y]),
        wheelFeatures: [car.wheelFeatures.maxR, car.wheelFeatures.widthRatio, car.wheelFeatures.protrusions, car.wheelFeatures.irregularity],
        telemetry,
        source: car === player ? 'human' : 'ai'
      })
    });
  } catch (e) { /* offline-safe: scoring UI already updated locally */ }
}

async function aiGenerateWheel(terrainType) {
  try {
    const res = await fetch(`/api/examples?terrainType=${terrainType}&limit=8`);
    const examples = await res.json();
    if (examples.length > 0 && Math.random() > 0.15) {
      // imitate a strong human example, weighted toward higher scores, with mutation
      const weights = examples.map(e => e.score * e.score + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total, pick = examples[0];
      for (let i = 0; i < examples.length; i++) { r -= weights[i]; if (r <= 0) { pick = examples[i]; break; } }
      const jitter = 6;
      return pick.wheelPoints.map(([x, y]) => ({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter }));
    }
  } catch (e) { /* fall through to cold-start */ }
  return coldStartWheel(terrainType);
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
  const points = await aiGenerateWheel(seg.type);
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
// Rendering — diagonal third-person "camera": world-space coordinates are
// unchanged (2D side-view physics still drives everything), but drawing is
// passed through a shear + vertical-squash transform so it reads like an
// angled chase-cam instead of a flat 2D strip. Player and AI each get their
// own lane (separated in world Y by LANE_GAP), which the shear renders as
// two parallel diagonal tracks.
// ---------------------------------------------------------------------------
function drawLaneGround(laneGround, segments) {
  const baseY = laneGround.baseY;
  wctx.fillStyle = 'rgba(61,220,151,0.16)';
  for (const seg of segments) {
    if (seg.type === 'water') wctx.fillRect(seg.x0, baseY - 34, seg.len, 34);
    if (seg.type === 'sand') { wctx.fillStyle = 'rgba(242,193,78,0.10)'; wctx.fillRect(seg.x0, baseY - 6, seg.len, 26); wctx.fillStyle = 'rgba(61,220,151,0.16)'; }
  }
  wctx.fillStyle = '#1b2128';
  wctx.strokeStyle = '#263140';
  for (const b of laneGround.bodies) {
    wctx.beginPath();
    b.vertices.forEach((v, i) => i === 0 ? wctx.moveTo(v.x, v.y) : wctx.lineTo(v.x, v.y));
    wctx.closePath(); wctx.fill(); wctx.stroke();
  }
}

function drawFinishLine(baseY) {
  const fx = track.totalLength - 30;
  wctx.fillStyle = '#f2c14e';
  for (let i = 0; i < 8; i++) wctx.fillRect(fx + (i % 2) * 8, baseY - i * 12 - 8, 8, 8);
}

function drawCar(car) {
  // soft ground-contact shadow first, so it sits under the wheels
  wctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (const wheel of [car.wheelA, car.wheelB]) {
    if (!wheel) continue;
    wctx.beginPath();
    wctx.ellipse(wheel.position.x, car.groundY + 21, car.wheelRadius * 0.9, 6, 0, 0, Math.PI * 2);
    wctx.fill();
  }
  for (const body of [car.wheelA, car.wheelB, car.chassis]) {
    if (!body) continue;
    wctx.fillStyle = body.render.fillStyle;
    wctx.beginPath();
    body.vertices.forEach((v, i) => i === 0 ? wctx.moveTo(v.x, v.y) : wctx.lineTo(v.x, v.y));
    wctx.closePath(); wctx.fill();
  }
}

function renderWorld() {
  const w = worldCanvas.width, h = worldCanvas.height;

  // Sky, drawn in flat screen space (unaffected by the world camera transform)
  const sky = wctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0b0d10');
  sky.addColorStop(1, '#14181d');
  wctx.fillStyle = sky;
  wctx.fillRect(0, 0, w, h);

  if (!physics.world) return;

  cameraX = player.chassis.position.x - w * 0.28 / VIEW_SQUASH; // pre-squash so the on-screen lead distance stays consistent
  const midLaneY = (PLAYER_GROUND_Y + AI_GROUND_Y) / 2;

  wctx.save();
  wctx.translate(w * 0.36, h * 0.5);
  wctx.transform(1, 0, VIEW_SKEW, VIEW_SQUASH, 0, 0);
  wctx.translate(-cameraX, -midLaneY);

  drawLaneGround(ground.ai, track.segments);
  drawLaneGround(ground.player, track.segments);

  // dashed divider between the two tracks
  wctx.strokeStyle = 'rgba(242,193,78,0.5)';
  wctx.setLineDash([14, 12]);
  wctx.lineWidth = 3;
  wctx.beginPath();
  wctx.moveTo(0, midLaneY);
  wctx.lineTo(track.totalLength, midLaneY);
  wctx.stroke();
  wctx.setLineDash([]);

  drawFinishLine(PLAYER_GROUND_Y);
  drawFinishLine(AI_GROUND_Y);

  drawCar(ai);
  drawCar(player);

  // lane labels, drawn in world space so they scroll with the track
  wctx.font = '20px "Rajdhani", sans-serif';
  wctx.fillStyle = 'rgba(232,230,223,0.55)';
  wctx.fillText('AI', cameraX + 24, AI_GROUND_Y - 90);
  wctx.fillStyle = 'rgba(242,193,78,0.75)';
  wctx.fillText('YOU', cameraX + 24, PLAYER_GROUND_Y - 90);

  wctx.restore();
}

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
function loop() {
  if (raceRunning) {
    Engine.update(physics.engine, 1000 / 60);
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
}

btnStart.addEventListener('click', startRace);
btnRestart.addEventListener('click', () => { btnStart.disabled = false; startRace(); });

// Build the world immediately on page load (not just on Start) so the player
// object exists right away — this is what lets you draw and mount a wheel
// before the race even begins, instead of erroring out on a null car.
initWorld();
resizeWorldCanvas();
renderWorld();
loop();