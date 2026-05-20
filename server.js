import express from 'express'
import session from 'express-session'
import SqliteStore from 'better-sqlite3-session-store'
import config from './config.js'
import db from './db.js'
import { bootstrapAdminPassword } from './services/auth.js'
import apiRouter from './router/api.js'
import adminRouter from './router/admin.js'
import siteRouter from './router/site.js'

const SessionStore = SqliteStore(session)
const app = express()

// Behind nginx: trust X-Forwarded-Proto so secure cookies work and req.protocol
// is https (used to build the Google OAuth redirect URI).
app.set('trust proxy', 1)

app.use(express.json())
app.use(express.urlencoded({ extended: false }))

app.use(session({
  store: new SessionStore({ client: db }),
  secret: config.sessionSecret || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'lax' (not 'strict') so the session cookie is sent on the top-level
    // redirect back from Google — required for the OAuth state check.
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}))

app.use('/api', apiRouter)
app.use('/admin', adminRouter)
app.use('/', siteRouter)

await bootstrapAdminPassword()
seedDefaultContent()

app.listen(config.port, () => {
  console.log(`Semantic CMS running on port ${config.port}`)
  console.log(`Admin: http://localhost:${config.port}/admin`)
})

function seedDefaultContent() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM pages').get()
  if (existing.n > 0) return

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO pages (id, slug, title, nav_order, format_version, created_at, updated_at)
    VALUES ('page_01', 'home', 'Home', 1, '0.1', ?, ?)
  `).run(now, now)

  const contactBlock = JSON.stringify([{
    id: 'b_01',
    type: 'contact-form',
    content: {
      heading: [{ text: 'Get in Touch' }],
      fields: [
        { id: 'field_name',    type: 'text',     label: [{ text: 'Your name' }],     required: true,  placeholder: 'Jane Smith' },
        { id: 'field_email',   type: 'email',    label: [{ text: 'Email address' }], required: true,  placeholder: 'jane@example.com' },
        { id: 'field_message', type: 'textarea', label: [{ text: 'Message' }],       required: true,  placeholder: 'How can I help?' },
      ],
      submit_label: [{ text: 'Send Message' }],
    },
    meta: {},
  }])

  db.prepare(`
    INSERT INTO page_versions (page_id, block_json, rendered_html, description, created_at)
    VALUES ('page_01', ?, NULL, 'Page created', ?)
  `).run(contactBlock, now)

  const settingsInsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  settingsInsert.run('site_name', '')
  settingsInsert.run('site_description', '')

  console.log('Semantic CMS ready. Visit http://localhost:' + config.port + '/admin to set up your site.')
}
