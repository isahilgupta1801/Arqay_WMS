// Database connection + versioned migrations.
// Every schema change is added to MIGRATIONS as a new entry (never edit old ones).
// Migrations run once, in order, inside a transaction, guarded by a lock so two
// servers starting together can't run them twice.

const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('FATAL: DATABASE_URL is not set. Add it in Render → Environment.');
  process.exit(1);
}

// External hostnames (with a dot, e.g. *.render.com, *.neon.tech) need SSL.
// Render's internal hostname (dpg-xxxx-a) has no dot and doesn't.
const host = new URL(url).hostname;
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === 'true'
  : host.includes('.') && host !== 'localhost' && host !== '127.0.0.1';

const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('Unexpected database error:', err.message));

// Run fn(client) inside one transaction: all of it saves, or none of it does.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = [
  {
    id: 1,
    name: 'warehouses, zones, audit log',
    sql: `
      CREATE TABLE warehouses (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
        name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
        walk_order  INTEGER CHECK (walk_order BETWEEN 1 AND 999),
        address     TEXT NOT NULL DEFAULT '' CHECK (length(address) <= 200),
        notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 300),
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by  TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX warehouses_code_uq ON warehouses (code);
      CREATE UNIQUE INDEX warehouses_name_uq ON warehouses (lower(btrim(name)));

      CREATE TABLE zones (
        id             SERIAL PRIMARY KEY,
        warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        code           TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
        name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
        zone_type      TEXT NOT NULL CHECK (zone_type IN
                         ('FG_STORAGE','RM_STORAGE','RECEIVING','QC_HOLD','STAGING','RETURNS')),
        pick_sequence  INTEGER CHECK (pick_sequence BETWEEN 1 AND 999),
        notes          TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 300),
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        version        INTEGER NOT NULL DEFAULT 1,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by     TEXT NOT NULL,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX zones_code_uq ON zones (warehouse_id, code);
      CREATE UNIQUE INDEX zones_name_uq ON zones (warehouse_id, lower(btrim(name)));
      CREATE INDEX zones_warehouse_idx ON zones (warehouse_id);

      CREATE TABLE audit_log (
        id         BIGSERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor      TEXT NOT NULL,
        entity     TEXT NOT NULL,
        entity_id  INTEGER NOT NULL,
        action     TEXT NOT NULL,
        before     JSONB,
        after      JSONB
      );
      CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, at DESC);
      CREATE INDEX audit_at_idx ON audit_log (at DESC);
    `,
  },
];

async function migrate() {
  await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const { rows } = await c.query('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      console.log(`Applying migration ${m.id}: ${m.name}`);
      await c.query(m.sql);
      await c.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    }
  });
}

module.exports = { pool, withTx, migrate };
