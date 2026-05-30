// Durable per-org cache for Sumble responses, backed by Render Postgres.
// Falls back to an in-memory Map when DATABASE_URL is absent (local dev), so
// the backend still runs without a database — it just won't survive restarts.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
const memory = new Map(); // key `${orgKey}::${section}` -> { payload, fetchedAt }

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Render-managed Postgres requires SSL; allow self-signed.
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[DB] pool error:', err.message));
}

async function init() {
  if (!pool) {
    console.log('[DB] No DATABASE_URL — using in-memory cache (non-durable).');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sumble_cache (
      org_key    text        NOT NULL,
      section    text        NOT NULL,
      payload    jsonb       NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_key, section)
    );
  `);
  console.log('[DB] sumble_cache ready (Postgres).');
}

// Returns the cached payload if present and younger than ttlMs, else null.
async function getCached(orgKey, section, ttlMs) {
  if (!orgKey) return null;
  if (!pool) {
    const hit = memory.get(`${orgKey}::${section}`);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.payload;
    return null;
  }
  const { rows } = await pool.query(
    'SELECT payload, fetched_at FROM sumble_cache WHERE org_key = $1 AND section = $2',
    [orgKey, section]
  );
  if (!rows.length) return null;
  const age = Date.now() - new Date(rows[0].fetched_at).getTime();
  if (age >= ttlMs) return null;
  return rows[0].payload;
}

async function setCached(orgKey, section, payload) {
  if (!orgKey) return;
  if (!pool) {
    memory.set(`${orgKey}::${section}`, { payload, fetchedAt: Date.now() });
    return;
  }
  await pool.query(
    `INSERT INTO sumble_cache (org_key, section, payload, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (org_key, section)
     DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [orgKey, section, JSON.stringify(payload)]
  );
}

module.exports = { init, getCached, setCached };
