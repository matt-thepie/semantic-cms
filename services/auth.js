import bcrypt from 'bcrypt'
import db from '../db.js'
import config from '../config.js'

export function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next()
  res.status(401).json({ error: 'Unauthorised' })
}

export async function bootstrapAdminPassword() {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash')
  if (existing) return

  const raw = config.adminPassword
  if (!raw) {
    console.error('ADMIN_PASSWORD environment variable is required on first run')
    process.exit(1)
  }
  const hash = await bcrypt.hash(raw, 12)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password_hash', hash)
}

export async function checkAdminPassword(password) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash')
  if (!row) return false
  return bcrypt.compare(password, row.value)
}

export async function changeAdminPassword(newPassword) {
  const hash = await bcrypt.hash(newPassword, 12)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password_hash', hash)
}
