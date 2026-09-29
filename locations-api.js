// Warehouses (your godowns / sites) and Zones (areas inside each warehouse).
// Rules enforced here AND in the database:
//  - codes and names are unique (warehouse codes globally; zone codes within their warehouse)
//  - nothing is ever hard-deleted: records are archived and can be restored
//  - every change is written to audit_log in the same transaction
//  - edits carry a version number; if someone else saved first, the edit is rejected (409)

const express = require('express');
const { pool, withTx } = require('./db');

const router = express.Router();

const ZONE_TYPES = ['FG_STORAGE', 'RM_STORAGE', 'RECEIVING', 'QC_HOLD', 'STAGING', 'RETURNS'];

class AppError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// ---------- validation ----------

function text(v, field, label, { required = false, max }) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v == null ? '' : null;
  if (s === null) throw new AppError(400, `${label} must be text.`, field);
  if (required && !s) throw new AppError(400, `${label} is required.`, field);
  if (s.length > max) throw new AppError(400, `${label} can be at most ${max} characters.`, field);
  return s;
}

function code(v, field, label) {
  if (v == null || String(v).trim() === '') return null; // auto-generate
  const s = String(v).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(s)) {
    throw new AppError(400, `${label} must be 1–6 letters or numbers, no spaces or symbols.`, field);
  }
  return s;
}

function order(v, field, label) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    throw new AppError(400, `${label} must be a whole number from 1 to 999.`, field);
  }
  return n;
}

function version(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'Missing record version. Reload the page and try again.');
  return n;
}

function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, 'Record not found.');
  return n;
}

function validateWarehouse(b) {
  return {
    name: text(b.name, 'name', 'Warehouse name', { required: true, max: 60 }),
    code: code(b.code, 'code', 'Warehouse code'),
    walk_order: order(b.walk_order, 'walk_order', 'Walking order'),
    address: text(b.address, 'address', 'Address', { max: 200 }),
    notes: text(b.notes, 'notes', 'Notes', { max: 300 }),
  };
}

function validateZone(b) {
  const zone_type = String(b.zone_type || '');
  if (!ZONE_TYPES.includes(zone_type)) throw new AppError(400, 'Choose a zone type.', 'zone_type');
  return {
    name: text(b.name, 'name', 'Zone name', { required: true, max: 60 }),
    code: code(b.code, 'code', 'Zone code'),
    zone_type,
    pick_sequence: order(b.pick_sequence, 'pick_sequence', 'Pick sequence'),
    notes: text(b.notes, 'notes', 'Notes', { max: 300 }),
  };
}

// ---------- helpers ----------

async function audit(c, actor, entity, entityId, action, before, after) {
  await c.query(
    `INSERT INTO audit_log (actor, entity, entity_id, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor, entity, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

// Next free code like WH01, WH02… or Z01, Z02… (never reuses archived codes)
async function nextCode(c, prefix, table, whereSql = '', params = []) {
  const { rows } = await c.query(
    `SELECT COALESCE(MAX(substring(code FROM '^${prefix}([0-9]+)$')::int), 0) AS n
       FROM ${table} WHERE code ~ '^${prefix}[0-9]+$' ${whereSql}`,
    params
  );
  const n = rows[0].n + 1;
  const width = Math.max(2, String(n).length);
  const result = prefix + String(n).padStart(width, '0');
  if (result.length > 6) throw new AppError(409, 'Automatic codes are exhausted. Enter a code manually.', 'code');
  return result;
}

// Turn database uniqueness errors into plain messages
function translatePgError(err) {
  if (err.code === '23505') {
    const map = {
      warehouses_code_uq: ['code', 'Another warehouse already uses this code (it may be archived).'],
      warehouses_name_uq: ['name', 'Another warehouse already has this name (it may be archived — restore it instead).'],
      zones_code_uq: ['code', 'Another zone in this warehouse already uses this code (it may be archived).'],
      zones_name_uq: ['name', 'Another zone in this warehouse already has this name (it may be archived — restore it instead).'],
    };
    const hit = map[err.constraint];
    if (hit) return new AppError(409, hit[1], hit[0]);
  }
  if (err.code === '23514' || err.code === '22P02') return new AppError(400, 'Some values are not valid.');
  return err;
}

async function lockRow(c, table, rowId) {
  const { rows } = await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [rowId]);
  if (!rows[0]) throw new AppError(404, table === 'zones' ? 'Zone not found.' : 'Warehouse not found.');
  return rows[0];
}

function checkVersion(row, v) {
  if (row.version !== v) {
    throw new AppError(409, `Someone else changed this record (by ${row.updated_by}). Reload to see the latest, then try again.`);
  }
}

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((e) => next(translatePgError(e)));

// ---------- read ----------

router.get('/locations', wrap(async (req, res) => {
  const { rows: warehouses } = await pool.query(
    `SELECT * FROM warehouses ORDER BY is_active DESC, walk_order NULLS LAST, code`
  );
  const { rows: zones } = await pool.query(
    `SELECT * FROM zones ORDER BY is_active DESC, pick_sequence NULLS LAST, code`
  );
  const byWh = new Map(warehouses.map((w) => [w.id, { ...w, zones: [] }]));
  for (const z of zones) byWh.get(z.warehouse_id)?.zones.push(z);
  res.json({ warehouses: [...byWh.values()], zoneTypes: ZONE_TYPES });
}));

router.get('/audit', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.at, a.actor, a.entity, a.entity_id, a.action, a.before, a.after
       FROM audit_log a ORDER BY a.at DESC, a.id DESC LIMIT 30`
  );
  res.json({ entries: rows });
}));

// ---------- warehouses ----------

router.post('/warehouses', wrap(async (req, res) => {
  const d = validateWarehouse(req.body || {});
  const row = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(1001)'); // serialise auto-code generation
    const codeVal = d.code || (await nextCode(c, 'WH', 'warehouses'));
    const { rows } = await c.query(
      `INSERT INTO warehouses (code, name, walk_order, address, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [codeVal, d.name, d.walk_order, d.address, d.notes, req.user]
    );
    await audit(c, req.user, 'warehouse', rows[0].id, 'create', null, rows[0]);
    return rows[0];
  });
  res.status(201).json(row);
}));

router.put('/warehouses/:id', wrap(async (req, res) => {
  const whId = id(req.params.id);
  const d = validateWarehouse(req.body || {});
  const v = version(req.body.version);
  const row = await withTx(async (c) => {
    const before = await lockRow(c, 'warehouses', whId);
    checkVersion(before, v);
    const { rows } = await c.query(
      `UPDATE warehouses SET code=$1, name=$2, walk_order=$3, address=$4, notes=$5,
              version=version+1, updated_at=NOW(), updated_by=$6
        WHERE id=$7 RETURNING *`,
      [d.code || before.code, d.name, d.walk_order, d.address, d.notes, req.user, whId]
    );
    await audit(c, req.user, 'warehouse', whId, 'update', before, rows[0]);
    return rows[0];
  });
  res.json(row);
}));

router.post('/warehouses/:id/:action(archive|restore)', wrap(async (req, res) => {
  const whId = id(req.params.id);
  const v = version((req.body || {}).version);
  const archive = req.params.action === 'archive';
  const row = await withTx(async (c) => {
    const before = await lockRow(c, 'warehouses', whId);
    checkVersion(before, v);
    if (archive) {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM zones WHERE warehouse_id=$1 AND is_active', [whId]);
      if (rows[0].n > 0) {
        throw new AppError(409, `Archive the ${rows[0].n} active zone(s) in this warehouse first.`);
      }
    }
    const { rows } = await c.query(
      `UPDATE warehouses SET is_active=$1, version=version+1, updated_at=NOW(), updated_by=$2
        WHERE id=$3 RETURNING *`, [!archive, req.user, whId]);
    await audit(c, req.user, 'warehouse', whId, req.params.action, before, rows[0]);
    return rows[0];
  });
  res.json(row);
}));

// ---------- zones ----------

router.post('/warehouses/:id/zones', wrap(async (req, res) => {
  const whId = id(req.params.id);
  const d = validateZone(req.body || {});
  const row = await withTx(async (c) => {
    const wh = await lockRow(c, 'warehouses', whId); // also serialises auto-codes per warehouse
    if (!wh.is_active) throw new AppError(409, 'This warehouse is archived. Restore it before adding zones.');
    const codeVal = d.code || (await nextCode(c, 'Z', 'zones', 'AND warehouse_id = $1', [whId]));
    const { rows } = await c.query(
      `INSERT INTO zones (warehouse_id, code, name, zone_type, pick_sequence, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [whId, codeVal, d.name, d.zone_type, d.pick_sequence, d.notes, req.user]
    );
    await audit(c, req.user, 'zone', rows[0].id, 'create', null, rows[0]);
    return rows[0];
  });
  res.status(201).json(row);
}));

router.put('/zones/:id', wrap(async (req, res) => {
  const zId = id(req.params.id);
  const d = validateZone(req.body || {});
  const v = version(req.body.version);
  const row = await withTx(async (c) => {
    const before = await lockRow(c, 'zones', zId);
    checkVersion(before, v);
    const { rows } = await c.query(
      `UPDATE zones SET code=$1, name=$2, zone_type=$3, pick_sequence=$4, notes=$5,
              version=version+1, updated_at=NOW(), updated_by=$6
        WHERE id=$7 RETURNING *`,
      [d.code || before.code, d.name, d.zone_type, d.pick_sequence, d.notes, req.user, zId]
    );
    await audit(c, req.user, 'zone', zId, 'update', before, rows[0]);
    return rows[0];
  });
  res.json(row);
}));

router.post('/zones/:id/:action(archive|restore)', wrap(async (req, res) => {
  const zId = id(req.params.id);
  const v = version((req.body || {}).version);
  const restore = req.params.action === 'restore';
  const row = await withTx(async (c) => {
    const before = await lockRow(c, 'zones', zId);
    checkVersion(before, v);
    if (restore) {
      const { rows } = await c.query('SELECT is_active FROM warehouses WHERE id=$1 FOR UPDATE', [before.warehouse_id]);
      if (!rows[0].is_active) throw new AppError(409, 'Restore the warehouse first.');
    }
    const { rows } = await c.query(
      `UPDATE zones SET is_active=$1, version=version+1, updated_at=NOW(), updated_by=$2
        WHERE id=$3 RETURNING *`, [restore, req.user, zId]);
    await audit(c, req.user, 'zone', zId, req.params.action, before, rows[0]);
    return rows[0];
  });
  res.json(row);
}));

module.exports = { router, AppError };
