// Durable per-org cache for Sumble responses, backed by Render Postgres.
// Falls back to an in-memory Map when DATABASE_URL is absent (local dev), so
// the backend still runs without a database — it just won't survive restarts.

const { Pool } = require('pg');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
const memory = new Map(); // key `${orgKey}::${section}` -> { payload, fetchedAt }
const secretMemory = new Map(); // portalId -> encrypted blob (in-memory fallback)

// AES-256-GCM at-rest encryption for stored credentials (the per-portal Sumble
// key). Key derived from ENCRYPTION_KEY env via sha256 so any string works.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const encKey = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

function encrypt(plaintext) {
  if (!encKey) throw new Error('ENCRYPTION_KEY not configured on the backend — set it to store credentials securely.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(blob) {
  if (!encKey || !blob) return null;
  try {
    const [ivB, tagB, dataB] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[DB] secret decrypt failed:', err.message);
    return null;
  }
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      portal_id  text        PRIMARY KEY,
      secret_enc text        NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  console.log(`[DB] tables ready (Postgres). Encryption: ${encKey ? 'on' : 'OFF (set ENCRYPTION_KEY)'}`);
}

// ---- per-portal encrypted secret store (the Sumble API key) ----
async function setSecret(portalId, plaintext) {
  if (!portalId) throw new Error('Missing portalId');
  const enc = encrypt(plaintext); // throws if ENCRYPTION_KEY unset
  if (!pool) { secretMemory.set(String(portalId), { enc, updatedAt: Date.now() }); return; }
  await pool.query(
    `INSERT INTO app_secrets (portal_id, secret_enc, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (portal_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()`,
    [String(portalId), enc]
  );
}

// Returns { value, updatedAt } or null. value is the decrypted plaintext.
async function getSecret(portalId) {
  if (!portalId) return null;
  if (!pool) {
    const hit = secretMemory.get(String(portalId));
    return hit ? { value: decrypt(hit.enc), updatedAt: new Date(hit.updatedAt).toISOString() } : null;
  }
  const { rows } = await pool.query(
    'SELECT secret_enc, updated_at FROM app_secrets WHERE portal_id = $1', [String(portalId)]
  );
  if (!rows.length) return null;
  return { value: decrypt(rows[0].secret_enc), updatedAt: new Date(rows[0].updated_at).toISOString() };
}

async function deleteSecret(portalId) {
  if (!portalId) return;
  if (!pool) { secretMemory.delete(String(portalId)); return; }
  await pool.query('DELETE FROM app_secrets WHERE portal_id = $1', [String(portalId)]);
}

const encryptionEnabled = !!encKey;

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

module.exports = { init, getCached, setCached, setSecret, getSecret, deleteSecret, encryptionEnabled };
