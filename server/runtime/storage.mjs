import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ApiError } from './errors.mjs';

// All adapters implement read + atomic compare-and-swap. A single account write
// commits document, cursor, tombstone and idempotency receipt together.
export async function openStorage(config) {
  const type = config.type;
  let adapter;
  if (type === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const filename = config.filename === ':memory:' ? ':memory:' : resolve(config.filename || 'data/sync.sqlite');
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS mokidown_state (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
    adapter = {
      read: async (id) => db.prepare('SELECT revision, payload FROM mokidown_state WHERE id=?').get(id),
      insert: async (id, payload) => Number(db.prepare('INSERT OR IGNORE INTO mokidown_state VALUES (?,1,?)').run(id, payload).changes) === 1,
      update: async (id, revision, payload) => Number(db.prepare('UPDATE mokidown_state SET revision=revision+1,payload=? WHERE id=? AND revision=?').run(payload, id, revision).changes) === 1,
      close: async () => db.close(),
    };
  } else if (type === 'postgres') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.url, connectionTimeoutMillis: 10000, ...(config.tls ? { ssl: config.tls } : {}) });
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS mokidown_state (id VARCHAR(128) PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
    } catch (error) { await pool.end(); throw error; }
    adapter = {
      read: async (id) => (await pool.query('SELECT revision,payload FROM mokidown_state WHERE id=$1', [id])).rows[0],
      insert: async (id, payload) => (await pool.query('INSERT INTO mokidown_state VALUES ($1,1,$2) ON CONFLICT DO NOTHING', [id, payload])).rowCount === 1,
      update: async (id, revision, payload) => (await pool.query('UPDATE mokidown_state SET revision=revision+1,payload=$1 WHERE id=$2 AND revision=$3', [payload, id, revision])).rowCount === 1,
      close: () => pool.end(),
    };
  } else if (type === 'mysql' || type === 'mariadb') {
    const { default: mysql } = await import('mysql2/promise');
    const pool = mysql.createPool({ uri: config.url, connectTimeout: 10000, ...(config.tls ? { ssl: config.tls } : {}) });
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS mokidown_state (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, revision INT NOT NULL, payload LONGTEXT NOT NULL) ENGINE=InnoDB');
    } catch (error) { await pool.end(); throw error; }
    adapter = {
      read: async (id) => (await pool.execute('SELECT revision,payload FROM mokidown_state WHERE id=?', [id]))[0][0],
      insert: async (id, payload) => {
        try { await pool.execute('INSERT INTO mokidown_state VALUES (?,1,?)', [id, payload]); return true; }
        catch (error) { if (error.code === 'ER_DUP_ENTRY') return false; throw error; }
      },
      update: async (id, revision, payload) => (await pool.execute('UPDATE mokidown_state SET revision=revision+1,payload=? WHERE id=? AND revision=?', [payload, id, revision]))[0].affectedRows === 1,
      close: () => pool.end(),
    };
  } else if (type === 'mongodb') {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(config.url, { serverSelectionTimeoutMS: 10000 });
    try { await client.connect(); } catch (error) { await client.close(); throw error; }
    const collection = client.db(config.database || undefined).collection('mokidown_state');
    adapter = {
      read: (id) => collection.findOne({ _id: id }),
      insert: async (id, payload) => {
        try { await collection.insertOne({ _id: id, revision: 1, payload }); return true; }
        catch (error) { if (error.code === 11000) return false; throw error; }
      },
      update: async (id, revision, payload) => (await collection.updateOne({ _id: id, revision }, { $set: { payload }, $inc: { revision: 1 } })).modifiedCount === 1,
      close: () => client.close(),
    };
  } else if (type === 'mssql') {
    const { default: sql } = await import('mssql');
    const pool = await new sql.ConnectionPool(config.connection || config.url).connect();
    try {
      await pool.request().query("IF OBJECT_ID(N'dbo.mokidown_state', N'U') IS NULL CREATE TABLE dbo.mokidown_state (id VARCHAR(128) COLLATE Latin1_General_100_BIN2 PRIMARY KEY, revision INT NOT NULL, payload NVARCHAR(MAX) NOT NULL)");
    } catch (error) { await pool.close(); throw error; }
    const request = (id, revision, payload) => {
      const r = pool.request().input('id', sql.VarChar(128), id);
      if (revision !== undefined) r.input('revision', sql.Int, revision);
      if (payload !== undefined) r.input('payload', sql.NVarChar(sql.MAX), payload);
      return r;
    };
    adapter = {
      read: async (id) => (await request(id).query('SELECT revision,payload FROM dbo.mokidown_state WHERE id=@id')).recordset[0],
      insert: async (id, payload) => {
        try { await request(id, undefined, payload).query('INSERT INTO dbo.mokidown_state VALUES (@id,1,@payload)'); return true; }
        catch (error) { if ([2601, 2627].includes(error.number)) return false; throw error; }
      },
      update: async (id, revision, payload) => (await request(id, revision, payload).query('UPDATE dbo.mokidown_state SET revision=revision+1,payload=@payload WHERE id=@id AND revision=@revision')).rowsAffected[0] === 1,
      close: () => pool.close(),
    };
  } else {
    throw new Error(`Unsupported database type: ${type}`);
  }
  return new StateStore(adapter, config.maxStateBytes || (type === 'mongodb' ? 12 : 64) * 1024 * 1024);
}

export class StateStore {
  constructor(adapter, maxBytes) { this.adapter = adapter; this.maxBytes = maxBytes; }
  async get(key) {
    const row = await this.adapter.read(key);
    return row ? JSON.parse(row.payload) : null;
  }
  async mutate(key, initial, operation) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await this.adapter.read(key);
      const state = row ? JSON.parse(row.payload) : structuredClone(initial);
      const result = operation(state);
      const payload = JSON.stringify(state);
      if (Buffer.byteLength(payload) > this.maxBytes) throw new ApiError(413, 'ACCOUNT_STORAGE_LIMIT', 'Account storage limit exceeded');
      const saved = row
        ? await this.adapter.update(key, row.revision, payload)
        : await this.adapter.insert(key, payload);
      if (saved) return result;
    }
    throw new ApiError(503, 'STORAGE_BUSY', 'Concurrent writes; retry with the same mutationId');
  }
  close() { return this.adapter.close(); }
}
