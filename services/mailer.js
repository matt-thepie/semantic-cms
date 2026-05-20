import nodemailer from 'nodemailer'
import config from '../config.js'
import db from '../db.js'

// Resolve SMTP settings from the admin UI (stored in the DB), falling back to
// environment variables. Sensible defaults: send-from defaults to the username,
// send-to defaults to the contact address or the from address.
function smtpConfig() {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'smtp_%' OR key = 'contact_email'"
  ).all()
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]).filter(([, v]) => v))

  const host = s.smtp_host || config.smtp.host
  const port = parseInt(s.smtp_port || config.smtp.port || 587, 10)
  const user = s.smtp_user || config.smtp.user
  const pass = s.smtp_password || config.smtp.password
  const from = s.smtp_from || config.smtp.from || user
  const to   = s.smtp_to || s.contact_email || config.smtp.to || from

  return { host, port, user, pass, from, to }
}

function createTransport(cfg) {
  if (!cfg.host) {
    throw new Error('No mail server is set up yet. Add your SMTP details under Settings, then try again.')
  }
  return nodemailer.createTransport({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.port === 465,
    auth:   cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  })
}

export async function sendContactEmail(fields) {
  const cfg = smtpConfig()
  if (!cfg.to) throw new Error('No destination address is set for contact form submissions.')
  const transport = createTransport(cfg)
  const lines = Object.entries(fields)
    .filter(([k]) => k !== '_honeypot')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  await transport.sendMail({
    from:    cfg.from,
    to:      cfg.to,
    subject: 'New contact form submission',
    text:    lines,
  })
}

export async function sendTestEmail() {
  const cfg = smtpConfig()
  if (!cfg.to) {
    throw new Error('Add a “Send contact form submissions to” address before sending a test.')
  }
  const transport = createTransport(cfg)
  await transport.sendMail({
    from:    cfg.from,
    to:      cfg.to,
    subject: 'Website — email test',
    text:    'If you received this, your email settings are working correctly.',
  })
}
