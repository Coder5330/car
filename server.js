// server.js
// Single Render web service: serves the game (public/) and the small API
// that stores physics-scored "wheel examples" the AI opponent learns from.
// Storage is Neon Postgres (set DATABASE_URL) so data survives redeploys —
// no persistent disk needed on Render.

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const { runTrial, pickWheel, TERRAIN_TYPES } = require('./lib/autotrainSim');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Storage: Neon Postgres via DATABASE_URL.
// Get this from your Neon project dashboard -> Connection Details ->
// "Pooled connection" string (looks like
// postgres://user:pass@ep-xxxx-pooler.region.aws.neon.tech/dbname?sslmode=require).
// Set it as an environment variable on the Render service.
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Running in DB-less (local test) mode.');
}

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon requires SSL; this is the standard Node pg setting for it
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', (err) => {
    console.error('Postgres pool error (idle client closed, likely by Neon autosuspend/pooler) — pool recovers automatically on next query:', err.message);
  });
}

async function initDb() {
  if (!pool) {
    console.warn('initDb: no database configured, skipping schema setup.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS examples (
      id SERIAL PRIMARY KEY,
      player_id TEXT NOT NULL,
      terrain_type TEXT NOT NULL,
      terrain_features JSONB NOT NULL,
      wheel_points JSONB NOT NULL,
      wheel_features JSONB NOT NULL,
      score REAL NOT NULL,
      source TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_terrain ON examples(terrain_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_player ON examples(player_id, terrain_type);`);
}

// ---------------------------------------------------------------------------
// Anti dataset-poisoning:
// 1. Score is NEVER accepted from the client as a label - it's recomputed
//    server-side from the raw telemetry the client measured during the run.
// 2. Each player (human OR the autotrain bot — see below) is capped on how
//    many examples they can contribute per terrain type, so nothing can
//    flood the dataset. Oldest-scoring example gets evicted once a
//    (player, terrain) pair is at the cap, which naturally keeps a rolling
//    "hall of fame" of the best examples seen so far.
// 3. Basic sanity bounds on telemetry reject physically impossible runs.
// This is not fully server-authoritative physics (that would mean re-running
// Matter.js on the server) - it's a pragmatic middle ground for an MVP. See
// README "Hardening ideas" for how to close the remaining gap.
//
// Self-play training (see the autotrain section below) writes into this
// same table with source='ai'. GET /api/examples used to only return
// source='human' rows — the idea being "the AI shouldn't learn from itself".
// That guard makes sense against an unverified self-reported label, but
// every score here is a real physics measurement (the wheel actually
// climbed the actual stairs, or it didn't), not a model's own guess about
// quality — so AI-sourced examples are exactly as trustworthy as human
// ones, and letting both compete purely on score is what actually lets
// self-play improve the pool over time (this is standard self-play/
// reinforcement learning, not the "AI grades its own homework" pattern the
// original guard was protecting against).
// ---------------------------------------------------------------------------
const MAX_EXAMPLES_PER_PLAYER_PER_TERRAIN = 60;

function scoreFromTelemetry(t) {
  // t: { distance, segmentLength, timeMs, avgSpeed, stuckMs, maxTiltDeg, flippedOver }
  if (
    typeof t !== 'object' || t === null ||
    !Number.isFinite(t.distance) || !Number.isFinite(t.segmentLength) ||
    !Number.isFinite(t.timeMs) || !Number.isFinite(t.avgSpeed) ||
    !Number.isFinite(t.stuckMs) || !Number.isFinite(t.maxTiltDeg) ||
    t.segmentLength <= 0 || t.timeMs <= 0
  ) return null;

  const completion = Math.max(0, Math.min(1, t.distance / t.segmentLength));
  if (t.flippedOver) return Math.round(5 * completion); // capped low, still informative

  const IDEAL_PX_PER_SEC = 300; // reference "good" traversal speed for a 900px segment (~3s)
  const idealTimeMs = (t.segmentLength / IDEAL_PX_PER_SEC) * 1000;
  const speedScore = Math.max(0, Math.min(1, idealTimeMs / t.timeMs));
  const stuckPenalty = Math.max(0, 1 - t.stuckMs / Math.max(1, t.timeMs));
  const stabilityScore = Math.max(0, 1 - Math.min(1, t.maxTiltDeg / 90));

  const raw =
    completion * 45 +
    speedScore * 30 +
    stuckPenalty * 15 +
    stabilityScore * 10;

  return Math.round(Math.max(0, Math.min(100, raw)));
}

// Shared by the human-facing POST /api/examples handler and the internal
// autotrain loop, so the cap/eviction logic only lives in one place.
async function insertExample({ playerId, terrainType, terrainFeatures, wheelPoints, wheelFeatures, score, source }) {
  if (!pool) {
    console.info(`insertExample (DB disabled) — ${source}/${terrainType} score=${score}`);
    return;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int c FROM examples WHERE player_id = $1 AND terrain_type = $2`,
    [playerId, terrainType]
  );
  if (rows[0].c >= MAX_EXAMPLES_PER_PLAYER_PER_TERRAIN) {
    await pool.query(
      `DELETE FROM examples WHERE id = (
         SELECT id FROM examples WHERE player_id = $1 AND terrain_type = $2
         ORDER BY score ASC LIMIT 1
       )`,
      [playerId, terrainType]
    );
  }
  await pool.query(
    `INSERT INTO examples (player_id, terrain_type, terrain_features, wheel_points, wheel_features, score, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      playerId, terrainType,
      JSON.stringify(terrainFeatures || []),
      JSON.stringify(wheelPoints),
      JSON.stringify(wheelFeatures || []),
      score, source, Date.now()
    ]
  );
}

app.post('/api/examples', async (req, res) => {
  try {
    const { playerId, terrainType, terrainFeatures, wheelPoints, wheelFeatures, telemetry, source } = req.body;

    if (!playerId || typeof playerId !== 'string' || playerId.length > 64) {
      return res.status(400).json({ error: 'invalid playerId' });
    }
    if (!terrainType || typeof terrainType !== 'string') {
      return res.status(400).json({ error: 'invalid terrainType' });
    }
    if (!Array.isArray(wheelPoints) || wheelPoints.length < 4 || wheelPoints.length > 60) {
      return res.status(400).json({ error: 'invalid wheelPoints' });
    }
    const score = scoreFromTelemetry(telemetry);
    if (score === null) return res.status(400).json({ error: 'invalid telemetry' });

    const src = source === 'ai' ? 'ai' : 'human';
    await insertExample({ playerId, terrainType, terrainFeatures, wheelPoints, wheelFeatures, score, source: src });

    res.json({ score });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Return the best-known examples for a terrain type, for the AI to imitate.
// Both human and 'ai' (autotrain self-play) sources compete purely on
// score — see the design note above insertExample for why that's safe here.
app.get('/api/examples', async (req, res) => {
  try {
    const terrainType = String(req.query.terrainType || '');
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit) || 8));
    if (!terrainType) return res.status(400).json({ error: 'terrainType required' });
    if (!pool) return res.json([]);

    const { rows } = await pool.query(
      `SELECT terrain_features, wheel_points, wheel_features, score, source
       FROM examples
       WHERE terrain_type = $1
       ORDER BY score DESC
       LIMIT $2`,
      [terrainType, limit]
    );

    res.json(rows.map(r => ({
      terrainFeatures: r.terrain_features,
      wheelPoints: r.wheel_points,
      wheelFeatures: r.wheel_features,
      score: r.score,
      source: r.source
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    if (!pool) return res.json({ total: 0, byTerrain: [] });
    const totalRes = await pool.query(`SELECT COUNT(*)::int c FROM examples`);
    const byTerrainRes = await pool.query(`
      SELECT terrain_type, COUNT(*)::int n, ROUND(AVG(score)::numeric,1) as "avgScore", MAX(score) as "maxScore"
      FROM examples GROUP BY terrain_type ORDER BY terrain_type
    `);
    res.json({ total: totalRes.rows[0].c, byTerrain: byTerrainRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true, note: 'no-db' });
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database not reachable' });
  }
});

// ---------------------------------------------------------------------------
// Autotrain: headless self-play. Runs entirely inside this same process
// (single Render web service, no separate worker) using lib/autotrainSim —
// a pure Matter.js physics harness with no rendering, so a trial that would
// take ~10-20 simulated seconds to watch finishes in well under a second of
// real wall-clock time. Loops forever once started, picking a random
// terrain each trial, imitating-and-mutating (or cold-starting) from the
// current best examples for that terrain — same procedure the in-browser
// AI opponent uses — then writing the result back with insertExample so it
// becomes available for the NEXT trial to build on, and for the live game's
// AI opponent to imitate too (see the design note above insertExample).
// ---------------------------------------------------------------------------
const AUTOTRAIN_PLAYER_ID = 'autotrain_bot';
// Pace between trials. A single trial is only tens of milliseconds of
// actual physics work, and Render's free tier spins the service down after
// ~15min with no incoming HTTP traffic — this loop goes down with it and
// can't hold the service awake by itself. So even at a tight interval the
// realistic worst case is a short burst of cheap work after each visit,
// not a background process quietly eating instance-hours. Set
// AUTOTRAIN_ENABLED=false to turn it off entirely.
const AUTOTRAIN_TRIAL_DELAY_MS = 1200;
const AUTOTRAIN_CANDIDATE_LIMIT = 10;

const autotrainStatus = {
  enabled: false,
  running: false,
  startedAt: null,
  totalTrials: 0,
  trialsByTerrain: Object.fromEntries(TERRAIN_TYPES.map(t => [t, 0])),
  lastTrial: null, // { terrainType, score, reason, at }
  lastError: null
};

async function fetchCandidates(terrainType) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT wheel_points, score FROM examples
     WHERE terrain_type = $1
     ORDER BY score DESC
     LIMIT $2`,
    [terrainType, AUTOTRAIN_CANDIDATE_LIMIT]
  );
  return rows.map(r => ({ wheelPoints: r.wheel_points, score: r.score }));
}

async function autotrainStep() {
  const terrainType = TERRAIN_TYPES[Math.floor(Math.random() * TERRAIN_TYPES.length)];
  const candidates = await fetchCandidates(terrainType);
  const { points, reason } = pickWheel(candidates);
  const result = await runTrial(terrainType, points);

  await insertExample({
    playerId: AUTOTRAIN_PLAYER_ID,
    terrainType: result.terrainType,
    terrainFeatures: [],
    wheelPoints: result.wheelPoints.map(p => [p.x, p.y]),
    wheelFeatures: [result.wheelFeatures.maxR, result.wheelFeatures.widthRatio, result.wheelFeatures.protrusions, result.wheelFeatures.irregularity],
    score: result.score,
    source: 'ai'
  });

  autotrainStatus.totalTrials++;
  autotrainStatus.trialsByTerrain[terrainType] = (autotrainStatus.trialsByTerrain[terrainType] || 0) + 1;
  autotrainStatus.lastTrial = { terrainType, score: result.score, reason, at: Date.now() };
}

let autotrainStopRequested = false;
async function autotrainLoop() {
  autotrainStatus.enabled = true;
  autotrainStatus.running = true;
  autotrainStatus.startedAt = Date.now();
  console.log('autotrain: starting self-play loop');
  while (!autotrainStopRequested) {
    try {
      await autotrainStep();
    } catch (err) {
      console.error('autotrain: trial failed:', err.message);
      autotrainStatus.lastError = { message: err.message, at: Date.now() };
    }
    await new Promise(r => setTimeout(r, AUTOTRAIN_TRIAL_DELAY_MS));
  }
  autotrainStatus.running = false;
}

app.get('/api/autotrain/status', (req, res) => {
  res.json(autotrainStatus);
});

// Time-bucketed avg/max score for the autotrain bot's own history on one
// terrain — the "is it actually improving" chart. Bucketed rather than raw
// rows since the examples table is a rolling top-N per (player, terrain),
// not a full history log.
app.get('/api/autotrain/history', async (req, res) => {
  try {
    const terrainType = String(req.query.terrainType || '');
    if (!terrainType) return res.status(400).json({ error: 'terrainType required' });
    if (!pool) return res.json([]);
    const bucketMs = Math.max(10000, Math.min(600000, parseInt(req.query.bucketMs) || 60000));

    const { rows } = await pool.query(
      `SELECT
         FLOOR(created_at / $3) * $3 AS bucket,
         ROUND(AVG(score)::numeric, 1) AS "avgScore",
         MAX(score) AS "maxScore",
         COUNT(*)::int AS n
       FROM examples
       WHERE terrain_type = $1 AND player_id = $2
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [terrainType, AUTOTRAIN_PLAYER_ID, bucketMs]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/autotrain', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'autotrain.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`AI Wheel Racing listening on :${PORT}`));
    if (!pool) {
      console.warn('autotrain: no DATABASE_URL configured, skipping self-play loop.');
    } else if (process.env.AUTOTRAIN_ENABLED === 'false') {
      console.log('autotrain: disabled via AUTOTRAIN_ENABLED=false.');
    } else {
      autotrainLoop();
    }
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    console.error('Check that DATABASE_URL is set to a valid Neon connection string.');
    process.exit(1);
  });