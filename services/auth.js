import bcrypt from 'bcrypt'
import db from '../db.js'
import config from '../config.js'

export function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next()
  res.status(401).json({ error: 'Unauthorised' })
}

export function googleConfigured() {
  return !!(config.google.clientId && config.google.clientSecret && config.adminEmails.length)
}

export function isEmailAllowed(email) {
  return config.adminEmails.includes((email || '').toLowerCase())
}

export function passwordConfigured() {
  return !!db.prepare("SELECT 1 FROM settings WHERE key = 'admin_password_hash'").get()
}

export async function bootstrapAdminPassword() {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password_hash')
  if (existing) return

  const raw = config.adminPassword
  if (!raw) {
    // Google sign-in alone is enough — no shared password needed
    if (googleConfigured()) {
      console.log('No ADMIN_PASSWORD set — using Google sign-in only.')
      return
    }
    console.error('Set ADMIN_PASSWORD, or configure Google sign-in (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAILS).')
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
