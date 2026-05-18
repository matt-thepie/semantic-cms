import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import config from './config.js'

fs.mkdirSync(path.dirname(config.db.path), { recursive: true })

const db = new Database(config.db.path)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id            TEXT PRIMARY KEY,
    slug          TEXT UNIQUE NOT NULL,
    title         TEXT NOT NULL,
    nav_order     INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    format_version TEXT NOT NULL DEFAULT '0.1',
    deleted_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS page_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id      TEXT NOT NULL REFERENCES pages(id),
    block_json   TEXT NOT NULL,
    rendered_html TEXT,
    description  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id         TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    bucket_url TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_usage (
    asset_id TEXT NOT NULL REFERENCES assets(id),
    page_id  TEXT NOT NULL REFERENCES pages(id),
    PRIMARY KEY (asset_id, page_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)
// Sessions table is created automatically by better-sqlite3-session-store

// Migrations — idempotent ALTER TABLE statements
const migrations = [
  'ALTER TABLE pages ADD COLUMN purpose TEXT',
]
for (const m of migrations) {
  try { db.exec(m) } catch (e) {
    if (!e.message.includes('duplicate column')) throw e
  }
}

export default db
