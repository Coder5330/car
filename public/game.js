const { Engine, World, Bodies, Body, Constraint, Vertices, Events } = Matter;
const PLAYER_GROUND_Y = 420;
const LANE_GAP = 210; 
const AI_GROUND_Y = PLAYER_GROUND_Y + LANE_GAP;
const SEG_LEN = 900;
const BUFFER_LEN = 160;
const BASE_DRIVE_SPEED = 0.85; 
const PHYSICS_SUBSTEPS = 4; 
const WHEEL_HEIGHT = 0; 
const DRIVE_RESPONSE_PER_FRAME = 0.13; 
const DRIVE_RESPONSE = 1 - Math.pow(1 - DRIVE_RESPONSE_PER_FRAME, 1 / PHYSICS_SUBSTEPS);
const CHASSIS_ANGULAR_DAMPING_PER_FRAME = 0.9; 
const CHASSIS_ANGULAR_DAMPING = Math.pow(CHASSIS_ANGULAR_DAMPING_PER_FRAME, 1 / PHYSICS_SUBSTEPS);
const MIN_WHEEL_R = 15;
const MAX_WHEEL_R = 34; 
const CAT_PLAYER_GROUND = 0x0002;
const CAT_AI_GROUND = 0x0004;
const LANE_X_OFFSET = 170;      
const LANE_VISUAL_WIDTH = 190;  
const TRACK_HALF_WIDTH = 34;    
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

function resizeWorldCanvas() {
  if (!three.renderer) return;
  const w = worldCanvas.clientWidth, h = worldCanvas.clientHeight;
  three.renderer.setSize(w, h, false);
  three.camera.aspect = w / h;
  three.camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeWorldCanvas);

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
        addBox(cx, baseY + 20, w, 40, 0, 0.55, seg.type);
        break;
      case 'stairs': {
        const stepW = 60, stepH = 30, steps = Math.floor(w / stepW); 
        for (let i = 0; i < steps; i++) {
          const rise = Math.min(i, 6) * stepH; 
          const bx = seg.x0 + i * stepW + stepW / 2;
          addBox(bx, baseY - rise + 20, stepW + 2, 40 + rise, 0, 0.95, 'stairs');
        }
        break;
      }
      case 'sand':
        addBox(cx, baseY + 20, w, 40, 0, 1.1, 'sand');
        sandZones.push(seg);
        break;
      case 'water':
        addBox(cx, baseY + 20, w, 40, 0, 0.3, 'water');
        waterZones.push(seg);
        break;
      case 'ice':
        addBox(cx, baseY + 20, w, 40, 0, 0.02, 'ice');
        break;
      case 'rocks': {
        const chunk = 45, n = Math.floor(w / chunk);
        for (let i = 0; i < n; i++) {
          const bump = (Math.sin(i * 1.7) * 0.5 + (Math.random() - 0.5)) * 16;
          const bx = seg.x0 + i * chunk + chunk / 2;
          addBox(bx, baseY + 20 - bump, chunk + 2, 40 + bump, 0, 0.95, 'rocks');
        }
        break;
      }
      case 'steep': {
        const angle = -0.35; 
        const len = Math.hypot(w, w * Math.tan(0.35));
        const rise = w * Math.tan(0.35);
        addBox(cx, baseY + 20 - rise / 2, len, 40, angle, 0.95, 'steep');
        break;
      }
    }
  }
  World.add(world, bodies);
  return { bodies, waterZones, sandZones, baseY };
}

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

  
  
  
  const bottomY = car.wheelA.position.y + car.wheelRadius;
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

  const { vertices, radius } = pointsToPhysicsVertices(points, features);
  const cx = car.chassis.position.x, cy = car.chassis.position.y;
  const offsets = [{ x: -32, y: WHEEL_HEIGHT }, { x: 32, y: WHEEL_HEIGHT }];
  const filter = { group: car.group, mask: car.mask };

  const wheels = offsets.map(off => {
    const w = Bodies.fromVertices(cx + off.x, cy + off.y, [vertices], {
      friction: 0.6, frictionStatic: 0.7, density: 0.0035, restitution: 0,
      collisionFilter: filter,
      render: { fillStyle: car.color === PLAYER_COLOR ? '#f2c14e' : '#3ddc97' }
    }, true);
    if (!w.parts || w.parts.length < 1) return Bodies.circle(cx + off.x, cy + off.y, radius, { collisionFilter: filter });
    return w;
  });

  
  
  
  wheels.forEach(w => {
    Body.setVelocity(w, prevVelocity);
    Body.setAngularVelocity(w, prevAngularVel);
  });

  
  
  
  
  
  
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

  if (car.mesh3D) updateWheelMesh3D(car, vertices);
}








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
    
    
    
    
    
    
    const localOffsetRear = 32, localOffsetFront = -32;
    [m.wheelRL, m.wheelRR].forEach(w => {
      w.position.set(w === m.wheelRL ? -TRACK_HALF_WIDTH : TRACK_HALF_WIDTH, WHEEL_HEIGHT, localOffsetRear);
      w.rotation.x = -car.wheelA.angle;
    });
    [m.wheelFL, m.wheelFR].forEach(w => {
      w.position.set(w === m.wheelFL ? -TRACK_HALF_WIDTH : TRACK_HALF_WIDTH, WHEEL_HEIGHT, localOffsetFront);
      w.rotation.x = -car.wheelB.angle;
    });
  }
}




const physics = {};
let track = null;
let ground = null;
let player = null;
let ai = null;
let raceRunning = false;
const threeGroups = { terrainPlayer: null, terrainAI: null, decor: [] };

function build3DTerrain(laneGround, laneSceneX) {
  const group = new THREE.Group();
  for (const b of laneGround.bodies) {
    const color = TERRAIN_COLOR3D[b.groundType] || 0x666666;
    const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(LANE_VISUAL_WIDTH, b._h, b._w), mat);
    mesh.position.set(laneSceneX, -(b.position.y - laneGround.baseY), -b.position.x);
    mesh.rotation.x = -b._angle;
    group.add(mesh);
  }
  three.scene.add(group);
  return group;
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
  
  
  
  
  
  
  
  
  physics.engine = Engine.create({
    positionIterations: 12,
    velocityIterations: 10,
    constraintIterations: 4
  });
  physics.world = physics.engine.world;
  physics.world.gravity.y = 3.4; 

  track = buildTrackPlan();
  const groundPlayer = buildGroundBodies(physics.world, track.segments, PLAYER_GROUND_Y, CAT_PLAYER_GROUND);
  const groundAI = buildGroundBodies(physics.world, track.segments, AI_GROUND_Y, CAT_AI_GROUND);
  ground = { player: groundPlayer, ai: groundAI, bodies: [...groundPlayer.bodies, ...groundAI.bodies] };

  
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
    
    const wideness = Math.max(0, Math.min(1, (features.widthRatio - 0.8) / 1.2));
    return 0.35 + wideness * 0.65;
  }
  if (seg.type === 'water') {
    const paddle = Math.max(0, Math.min(1, features.protrusions / 6));
    return 0.15 + paddle * 1.1;
  }
  if (seg.type === 'ice') {
    
    return 0.7 + Math.max(0, Math.min(1, features.protrusions / 8)) * 0.5;
  }
  if (seg.type === 'stairs' || seg.type === 'rocks') {
    
    
    
    
    
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
    const mul = terrainDriveMultiplier(seg, car.wheelFeatures || {});
    const targetSpeed = BASE_DRIVE_SPEED * mul;

    
    
    
    
    
    
    
    
    
    
    for (const wheel of [car.wheelA, car.wheelB]) {
      const newAV = wheel.angularVelocity + (targetSpeed - wheel.angularVelocity) * DRIVE_RESPONSE;
      Body.setAngularVelocity(wheel, newAV);
    }

    
    
    
    
    
    
    Body.setAngularVelocity(car.chassis, car.chassis.angularVelocity * CHASSIS_ANGULAR_DAMPING);

    
    if (seg && seg.type === 'sand') {
      const wideness = Math.max(0, Math.min(1, ((car.wheelFeatures || {}).widthRatio - 0.8) / 1.2));
      const drag = 0.985 - 0.01 * (1 - wideness);
      Body.setVelocity(car.chassis, { x: car.chassis.velocity.x * drag, y: car.chassis.velocity.y });
    }
    
    if (seg && seg.type === 'water') {
      Body.applyForce(car.chassis, car.chassis.position, { x: 0, y: -0.0009 * car.chassis.mass });
    }

    trackTelemetry(car, seg);
    handleStuckAndFlip(car);

    
    
    
    if (car === ai && seg && seg.type !== 'flat' && seg.type !== 'finish' &&
        car.telemetry && car.telemetry.stuckMs > 3200) {
      const now = performance.now();
      if (!car.lastRetryAt || now - car.lastRetryAt > 3500) {
        car.lastRetryAt = now;
        car.telemetry.stuckMs = 0; 
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
    finalizeSegment(car); 
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
  } catch (e) {  }
}

async function aiGenerateWheel(terrainType) {
  try {
    const res = await fetch(`/api/examples?terrainType=${terrainType}&limit=8`);
    const examples = await res.json();
    if (examples.length > 0 && Math.random() > 0.15) {
      
      const weights = examples.map(e => e.score * e.score + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total, pick = examples[0];
      for (let i = 0; i < examples.length; i++) { r -= weights[i]; if (r <= 0) { pick = examples[i]; break; } }
      const jitter = 6;
      return pick.wheelPoints.map(([x, y]) => ({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter }));
    }
  } catch (e) {  }
  return coldStartWheel(terrainType);
}

function coldStartWheel(terrainType) {
  
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








function addStaticSceneDecor() {
  
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

  
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, flatShading: true });
  for (let x = 0; x < track.totalLength; x += 60) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 26), dashMat);
    dash.position.set(0, 1, -x);
    three.scene.add(dash);
    threeGroups.decor.push(dash);
  }

  
  const fillerMat = new THREE.MeshStandardMaterial({ color: 0x22303c, flatShading: true, roughness: 1 });
  const filler = new THREE.Mesh(new THREE.PlaneGeometry(6000, track.totalLength + 800), fillerMat);
  filler.rotation.x = -Math.PI / 2;
  filler.position.set(0, -140, -track.totalLength / 2);
  three.scene.add(filler);
  threeGroups.decor.push(filler);
}




const CAM_DIAGONAL_DEG = 34;
const CAM_DIST = 340;   
const CAM_HEIGHT = 260; 

function updateCamera() {
  const px = player.chassis.position.x;
  const py = -(player.chassis.position.y - player.groundY);
  const targetZ = -px;

  
  
  
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





let lastAISeg = -1;
function watchAISegment() {
  if (!raceRunning) return;
  const seg = segmentAt(track.segments, ai.chassis.position.x);
  const idx = track.segments.indexOf(seg);
  if (idx !== lastAISeg) { lastAISeg = idx; updateAIWheelForSegment(seg); }
}




let raceStartTime = 0;







function loop() {
  if (raceRunning) {
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
}

btnStart.addEventListener('click', startRace);
btnRestart.addEventListener('click', () => { btnStart.disabled = false; startRace(); });





initThreeScene();
initWorld();
resizeWorldCanvas();
loop();