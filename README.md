# AI Wheel Racing

A single-service game: you race a car that only moves forward, and your one
tool is drawing new wheels for whatever terrain is coming (stairs, sand,
water, ice, rocks, a steep climb). Your drawing becomes a real Matter.js
physics shape. An AI opponent races you and, over time, learns which wheel
shapes actually work by imitating the highest-scoring human-drawn wheels
stored in a small database — nobody can just tell it "this is good," the
score comes from measured physics telemetry.

## How it works

- **Physics is real, not scripted, for stairs / rocks / ice / steep terrain.**
  Your drawn polygon becomes an actual rigid body wheel; whether it climbs a
  step, grips ice, or tips over is standard Matter.js rigid-body simulation.
- **Sand and water use a small labeled force field** on top of that, because
  "sinking into sand" or "paddling through water" isn't something a rigid
  convex hull can do on its own. The force is driven by measurable features
  of your drawing (how wide/flat it is, how many paddle-like protrusions it
  has) — see `terrainDriveMultiplier` in `public/script.js`.
- **Scoring is server-authoritative.** The client sends raw telemetry
  (distance covered, time, time spent stuck, max tilt, whether it flipped) —
  never a score — and `server.js` recomputes the score itself. See
  `scoreFromTelemetry` in `server.js`.
- **Anti dataset-poisoning, MVP-level:** scores can't be self-reported, and
  each player is capped at 60 stored examples per terrain type so one person
  can't flood the dataset. This is a pragmatic middle ground, not full
  server-side replay verification — see "Hardening ideas" below.
- **The AI opponent** re-generates its wheel every time it enters a new
  terrain segment. It fetches the current best human-drawn examples for that
  terrain from `/api/examples`, imitates one (weighted toward higher scores)
  with a little mutation, and — about 15% of the time, or always at first
  when no data exists yet — draws a random blob instead. That's the "Day 1 it's
  bad, later it gets specialized" progression: early on there's no data so
  it's mostly guessing; as people play, its picks converge on what's actually
  measured to work.

## Database: Neon Postgres

Training examples (terrain, drawn wheel shape, physics-measured score) are
stored in Postgres via [Neon](https://neon.tech). Using Neon instead of a
local file means the AI's learned data survives Render redeploys/restarts
with zero extra Render config — no persistent disk needed, and it's still
just one Render web service (Neon is an external managed connection, not a
second service you have to run).

### 1. Create the Neon database

1. Sign up / log in at neon.tech, create a project (any region).
2. In the project dashboard, go to **Connection Details** and copy the
   **pooled connection string** (it has `-pooler` in the hostname — use this
   one, not the direct one, since Render will open many short-lived
   connections). It looks like:
   ```
   postgres://<user>:<password>@ep-xxxx-pooler.<region>.aws.neon.tech/<dbname>?sslmode=require
   ```
3. That's it — you don't need to create the table yourself. The server runs
   `CREATE TABLE IF NOT EXISTS` on startup.

### 2. Run locally

```bash
npm install
export DATABASE_URL="postgres://...-pooler..."   # paste your Neon connection string
npm start
# open http://localhost:3000
```

(Or copy `.env.example` to `.env` and use a tool like `dotenv`/`dotenv-cli`
if you prefer not to export it manually each time.)

### 3. Deploy to Render (one web service)

1. Push this folder to a GitHub repo.
2. In Render: **New → Web Service**, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Under **Environment**, add `DATABASE_URL` = your Neon pooled connection
   string.
6. Deploy.

Check `/api/health` on the deployed URL after it's up — it runs `SELECT 1`
against Neon and tells you immediately if the connection string is wrong,
rather than you having to dig through logs.

## Hardening ideas (not in this MVP)

- Re-simulate the reported run server-side (send the full input/telemetry
  timeline, replay it headlessly with the same physics engine) instead of
  trusting client-measured telemetry — closes the last gap in anti-cheat.
- Rate-limit `/api/examples` by IP in addition to player id.
- Track win/loss outcomes per AI "generation" to show a visible skill curve.
- Neon's free tier scales to zero when idle — the first request after a
  quiet period will be slightly slower while it wakes up. Fine for a hobby
  deploy; worth knowing about before a launch/demo.
