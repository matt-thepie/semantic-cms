import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import config from '../config.js'
import db from '../db.js'
import { requireAdmin, checkAdminPassword, changeAdminPassword, googleConfigured, isEmailAllowed, passwordConfigured } from '../services/auth.js'
import { describeChange, nextPageId, nextAssetId } from '../services/versions.js'
import { uploadAsset, deleteAsset } from '../services/storage.js'
import { semanticPass, helpPass, cssAudit, designPass, suggestImageQueries } from '../services/llm.js'
import { sendContactEmail, sendTestEmail } from '../services/mailer.js'
import { searchPhotos, trackDownload, isConfigured as unsplashConfigured } from '../services/imagesearch.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const contactLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })
const unlockLimit  = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })

function now() { return new Date().toISOString() }

function getSiteSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

function getSitePages() {
  return db.prepare(`
    SELECT slug, title, purpose FROM pages
    WHERE deleted_at IS NULL
    ORDER BY nav_order ASC, created_at ASC
  `).all()
}

function getAssetMap(blockJson) {
  const ids = new Set()
  const collect = (blocks) => {
    for (const b of blocks) {
      if (b.content?.asset) ids.add(b.content.asset)
      if (b.content?.items) for (const item of b.content.items) if (item.asset) ids.add(item.asset)
    }
  }
  collect(blockJson)
  if (!ids.size) return {}
  const placeholders = [...ids].map(() => '?').join(',')
  const assets = db.prepare(`SELECT id, filename, bucket_url, credit, credit_url FROM assets WHERE id IN (${placeholders})`).all(...ids)
  return Object.fromEntries(assets.map(a => [a.id, {
    url: a.bucket_url, filename: a.filename, credit: a.credit || null, creditUrl: a.credit_url || null,
  }]))
}

function updateAssetUsage(pageId, blockJson) {
  const ids = new Set()
  const collect = (blocks) => {
    for (const b of blocks) {
      if (b.content?.asset) ids.add(b.content.asset)
      if (b.content?.items) for (const item of b.content.items) if (item.asset) ids.add(item.asset)
    }
  }
  collect(blockJson)
  db.prepare('DELETE FROM asset_usage WHERE page_id = ?').run(pageId)
  const insert = db.prepare('INSERT OR IGNORE INTO asset_usage (asset_id, page_id) VALUES (?, ?)')
  for (const id of ids) insert.run(id, pageId)
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Download a remote image, process it through sharp (resize + WebP variant),
// upload via the storage adapter, and create an asset row. Returns the asset.
async function importImageFromUrl({ url, filename, credit, creditUrl }) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`)
  const buffer = Buffer.from(await res.arrayBuffer())

  const base = slugify(filename || 'image').slice(0, 60) || 'image'
  const id = nextAssetId(db)
  const ts = now()

  const processed = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()
  const webpBuffer = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()

  await uploadAsset(webpBuffer, `${base}.webp`, 'image/webp')
  const { url: bucketUrl } = await uploadAsset(processed, `${base}.jpg`, 'image/jpeg')

  db.prepare('INSERT INTO assets (id, filename, bucket_url, mime, size, credit, credit_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${base}.jpg`, bucketUrl, 'image/jpeg', processed.length, credit || null, creditUrl || null, ts)

  return { id, filename: `${base}.jpg`, url: bucketUrl, credit, creditUrl }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Password required' })
  const ok = await checkAdminPassword(password)
  if (!ok) return res.status(401).json({ error: 'Incorrect password' })
  req.session.admin = true
  res.json({ ok: true })
})

router.post('/auth/logout', (req, res) => {
  req.session.destroy()
  res.json({ ok: true })
})

router.get('/auth/status', (req, res) => {
  res.json({ authenticated: req.session?.admin === true, email: req.session?.adminEmail || null })
})

// Which sign-in methods are available (for the login page to show the right options)
router.get('/auth/methods', (req, res) => {
  res.json({ google: googleConfigured(), password: passwordConfigured() })
})

// ─── Google sign-in (OAuth) ────────────────────────────────────────────────────

function googleRedirectUri(req) {
  // Behind nginx, trust proxy makes req.protocol reflect the real https scheme
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`
}

router.get('/auth/google', (req, res) => {
  if (!googleConfigured()) return res.status(404).send('Google sign-in is not configured')
  const state = crypto.randomBytes(16).toString('hex')
  req.session.oauthState = state
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  })
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString())
})

router.get('/auth/google/callback', async (req, res) => {
  if (!googleConfigured()) return res.redirect('/admin/login')
  const { code, state } = req.query
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/admin/login?error=auth')
  }
  delete req.session.oauthState

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`)
    const tokens = await tokenRes.json()

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const info = await infoRes.json()
    const email = (info.email || '').toLowerCase()

    if (!info.verified_email || !isEmailAllowed(email)) {
      return res.redirect('/admin/login?error=denied')
    }

    req.session.admin = true
    req.session.adminEmail = email
    res.redirect('/admin/')
  } catch (err) {
    console.error('Google sign-in failed:', err.message)
    res.redirect('/admin/login?error=auth')
  }
})

// ─── Pages ───────────────────────────────────────────────────────────────────

router.get('/pages', requireAdmin, (req, res) => {
  const pages = db.prepare(`
    SELECT id, slug, title, nav_order, parent_id, purpose, password_hash IS NOT NULL AS protected, updated_at
    FROM pages WHERE deleted_at IS NULL ORDER BY nav_order ASC, created_at ASC
  `).all()
  res.json(pages.map(p => ({ ...p, protected: !!p.protected })))
})

// Public navigation list (no sensitive fields) — includes hierarchy
router.get('/nav', (req, res) => {
  const pages = db.prepare(`
    SELECT slug, title, parent_id, id FROM pages WHERE deleted_at IS NULL
    ORDER BY nav_order ASC, created_at ASC
  `).all()
  res.json(pages)
})

// Public site metadata (only safe, public fields)
router.get('/site-meta', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('site_name','site_description','image_credits','nav_layout','header_image')").all()
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]))
  let imageCredits = []
  try { imageCredits = JSON.parse(s.image_credits || '[]') } catch {}
  let headerImage = null
  try { headerImage = s.header_image ? JSON.parse(s.header_image) : null } catch {}
  res.json({
    site_name: s.site_name || '',
    site_description: s.site_description || '',
    image_credits: imageCredits,
    nav_layout: s.nav_layout || 'topbar-dropdown',
    header_image: headerImage,
  })
})

router.get('/pages/:slug', (req, res) => {
  const page = db.prepare('SELECT id, slug, title, password_hash FROM pages WHERE slug = ? AND deleted_at IS NULL').get(req.params.slug)
  if (!page) return res.status(404).json({ error: 'Not found' })

  if (page.password_hash) {
    const sessionKey = `page_unlocked_${page.id}`
    if (!req.session[sessionKey]) return res.status(401).json({ error: 'Password required', protected: true })
  }

  const version = db.prepare('SELECT rendered_html FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(page.id)
  res.json({ id: page.id, slug: page.slug, title: page.title, rendered_html: version?.rendered_html || '' })
})

router.post('/pages', requireAdmin, async (req, res) => {
  const { title, slug, password, parent_id } = req.body
  if (!title) return res.status(400).json({ error: 'Title required' })

  const id = nextPageId(db)
  const finalSlug = slug || slugify(title) || id
  const navOrder = (db.prepare('SELECT MAX(nav_order) AS m FROM pages WHERE deleted_at IS NULL').get().m || 0) + 1
  const ts = now()

  const passwordHash = password ? await bcrypt.hash(password, 12) : null
  // Only allow a top-level page as a parent (enforce two-level cap)
  const parent = parent_id ? db.prepare('SELECT id, parent_id FROM pages WHERE id = ? AND deleted_at IS NULL').get(parent_id) : null
  const finalParent = parent && !parent.parent_id ? parent.id : null

  db.prepare(`
    INSERT INTO pages (id, slug, title, nav_order, parent_id, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, finalSlug, title, navOrder, finalParent, passwordHash, ts, ts)

  res.status(201).json({ id, slug: finalSlug })
})

router.put('/pages/:id', requireAdmin, (req, res) => {
  const { title, nav_order, purpose, parent_id } = req.body
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const updates = []
  const values = []
  if (title !== undefined)     { updates.push('title = ?');     values.push(title) }
  if (nav_order !== undefined) { updates.push('nav_order = ?'); values.push(nav_order) }
  if (purpose !== undefined)   { updates.push('purpose = ?');   values.push(purpose || null) }
  if (parent_id !== undefined) {
    // Enforce two-level cap: parent must exist, be top-level, not self, and
    // the page being moved must not itself have children.
    let finalParent = null
    if (parent_id) {
      const parent = db.prepare('SELECT id, parent_id FROM pages WHERE id = ? AND deleted_at IS NULL').get(parent_id)
      const hasChildren = db.prepare('SELECT 1 FROM pages WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1').get(req.params.id)
      if (parent && !parent.parent_id && parent.id !== req.params.id && !hasChildren) finalParent = parent.id
    }
    updates.push('parent_id = ?'); values.push(finalParent)
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

  updates.push('updated_at = ?')
  values.push(now(), req.params.id)
  db.prepare(`UPDATE pages SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  res.json({ ok: true })
})

router.delete('/pages/:id', requireAdmin, (req, res) => {
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE pages SET deleted_at = ? WHERE id = ?').run(now(), req.params.id)
  res.json({ ok: true })
})

// ─── Page unlock (password-protected pages) ──────────────────────────────────

router.post('/pages/:slug/unlock', unlockLimit, async (req, res) => {
  const page = db.prepare('SELECT id, password_hash FROM pages WHERE slug = ? AND deleted_at IS NULL').get(req.params.slug)
  if (!page) return res.status(404).json({ error: 'Not found' })
  if (!page.password_hash) return res.json({ ok: true })

  const ok = await bcrypt.compare(req.body.password || '', page.password_hash)
  if (!ok) return res.status(401).json({ error: 'Incorrect password' })

  req.session[`page_unlocked_${page.id}`] = true
  res.json({ ok: true })
})

// ─── Page content (current state) ────────────────────────────────────────────

router.get('/pages/:id/content', requireAdmin, (req, res) => {
  const page = db.prepare('SELECT id, slug, title, purpose FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const version = db.prepare('SELECT block_json, rendered_html FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(page.id)
  res.json({
    id: page.id,
    slug: page.slug,
    title: page.title,
    purpose: page.purpose || '',
    block_json: version ? JSON.parse(version.block_json) : [],
    rendered_html: version?.rendered_html || '',
  })
})

// ─── Page content (save flow) ─────────────────────────────────────────────────

router.post('/pages/:id/save', requireAdmin, async (req, res) => {
  const { block_json } = req.body
  if (!Array.isArray(block_json)) return res.status(400).json({ error: 'block_json must be an array' })

  const page = db.prepare('SELECT id, slug, title, purpose FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const previousVersion = db.prepare('SELECT block_json, rendered_html FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(page.id)
  const previousBlocks = previousVersion ? JSON.parse(previousVersion.block_json) : []
  const previousHtml   = previousVersion?.rendered_html || ''

  const assetMap = getAssetMap(block_json)
  const siteSettings = getSiteSettings()
  const sitePages = getSitePages()

  let renderedHtml = null
  try {
    renderedHtml = await semanticPass({
      blockJson: block_json,
      pageTitle: page.title,
      pageSlug:  page.slug,
      pagePurpose: page.purpose,
      previousHtml,
      assetMap,
      siteSettings,
      sitePages,
    })
  } catch (err) {
    console.error('LLM semantic pass failed:', err.message)
  }

  const description = describeChange(previousBlocks, block_json)
  const ts = now()

  const versionId = db.prepare(`
    INSERT INTO page_versions (page_id, block_json, rendered_html, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(page.id, JSON.stringify(block_json), renderedHtml, description, ts).lastInsertRowid

  db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?').run(ts, page.id)
  updateAssetUsage(page.id, block_json)

  res.json({ version_id: versionId, rendered_html: renderedHtml, description })
})

// ─── Plain-English help ───────────────────────────────────────────────────────

router.post('/pages/:id/help', requireAdmin, async (req, res) => {
  const { complaint, block_json, current_html } = req.body
  if (!complaint) return res.status(400).json({ error: 'complaint required' })

  const page = db.prepare('SELECT id, slug, title, purpose FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const siteSettings = getSiteSettings()
  const sitePages = getSitePages()

  try {
    const adjustedHtml = await helpPass({
      complaint,
      blockJson: block_json,
      currentHtml: current_html,
      pageTitle: page.title,
      pageSlug: page.slug,
      pagePurpose: page.purpose,
      siteSettings,
      sitePages,
    })
    res.json({ adjusted_html: adjustedHtml })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Store HTML directly (used by "Apply this fix" — keeps the help-adjusted HTML
// instead of re-running the semantic pass, which would discard the adjustment).
router.post('/pages/:id/apply-html', requireAdmin, (req, res) => {
  const { block_json, rendered_html } = req.body
  if (!Array.isArray(block_json) || typeof rendered_html !== 'string') {
    return res.status(400).json({ error: 'block_json and rendered_html required' })
  }
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const ts = now()
  const versionId = db.prepare(`
    INSERT INTO page_versions (page_id, block_json, rendered_html, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(page.id, JSON.stringify(block_json), rendered_html, 'Layout fix applied', ts).lastInsertRowid

  db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?').run(ts, page.id)
  updateAssetUsage(page.id, block_json)

  res.json({ version_id: versionId })
})

// ─── Versions ─────────────────────────────────────────────────────────────────

router.get('/pages/:id/versions', requireAdmin, (req, res) => {
  const versions = db.prepare(`
    SELECT id, description, created_at FROM page_versions WHERE page_id = ? ORDER BY id DESC
  `).all(req.params.id)
  res.json(versions)
})

router.post('/pages/:id/versions/:vid/restore', requireAdmin, async (req, res) => {
  const version = db.prepare('SELECT block_json FROM page_versions WHERE id = ? AND page_id = ?').get(req.params.vid, req.params.id)
  if (!version) return res.status(404).json({ error: 'Not found' })

  req.body = { block_json: JSON.parse(version.block_json) }
  // Delegate to the save flow by calling it inline
  const page = db.prepare('SELECT id, slug, title, purpose FROM pages WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!page) return res.status(404).json({ error: 'Not found' })

  const block_json = JSON.parse(version.block_json)
  const previousVersion = db.prepare('SELECT block_json, rendered_html FROM page_versions WHERE page_id = ? ORDER BY id DESC LIMIT 1').get(page.id)
  const previousBlocks = previousVersion ? JSON.parse(previousVersion.block_json) : []
  const previousHtml = previousVersion?.rendered_html || ''
  const assetMap = getAssetMap(block_json)
  const siteSettings = getSiteSettings()
  const sitePages = getSitePages()

  let renderedHtml = null
  try {
    renderedHtml = await semanticPass({ blockJson: block_json, pageTitle: page.title, pageSlug: page.slug, pagePurpose: page.purpose, previousHtml, assetMap, siteSettings, sitePages })
  } catch (err) {
    console.error('LLM semantic pass failed on restore:', err.message)
  }

  const description = `Restored version from ${version.created_at ? new Date(version.created_at).toLocaleDateString() : 'earlier'}`
  const ts = now()

  const versionId = db.prepare(`
    INSERT INTO page_versions (page_id, block_json, rendered_html, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(page.id, JSON.stringify(block_json), renderedHtml, description, ts).lastInsertRowid

  db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?').run(ts, page.id)
  updateAssetUsage(page.id, block_json)

  res.json({ version_id: versionId, rendered_html: renderedHtml, description })
})

// ─── Assets ───────────────────────────────────────────────────────────────────

router.get('/assets', requireAdmin, (req, res) => {
  const assets = db.prepare('SELECT a.*, GROUP_CONCAT(au.page_id) AS used_by FROM assets a LEFT JOIN asset_usage au ON a.id = au.asset_id GROUP BY a.id ORDER BY a.created_at DESC').all()
  res.json(assets.map(a => ({
    ...a,
    used_by_pages: a.used_by ? a.used_by.split(',') : [],
  })))
})

// ─── AI image search (Unsplash) ───────────────────────────────────────────────

router.get('/images/search', requireAdmin, async (req, res) => {
  if (!unsplashConfigured()) return res.status(503).json({ error: 'Image search is not configured' })
  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'query required' })
  try {
    const results = await searchPhotos(q, 12)
    res.json({ results })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.post('/images/import', requireAdmin, async (req, res) => {
  const { fullUrl, description, creditName, creditUrl, downloadLocation } = req.body
  if (!fullUrl) return res.status(400).json({ error: 'fullUrl required' })

  // Unsplash API terms require: (1) hotlinking to their image URL — we must NOT
  // download and re-host; (2) triggering the download endpoint when a photo is
  // used; (3) attributing the photographer + Unsplash.
  trackDownload(downloadLocation)

  const id = nextAssetId(db)
  const ts = now()
  const filename = (description ? slugify(description).slice(0, 50) : 'unsplash-photo') || 'unsplash-photo'
  const credit = `Photo by ${creditName || 'Unknown'} on Unsplash`

  db.prepare('INSERT INTO assets (id, filename, bucket_url, mime, size, credit, credit_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, filename, fullUrl, 'image/jpeg', 0, credit, creditUrl || 'https://unsplash.com', ts)

  res.status(201).json({ id, filename, url: fullUrl, credit, creditUrl })
})

router.get('/images/status', requireAdmin, (req, res) => {
  res.json({ configured: unsplashConfigured() })
})

// ─── Header background photo (a managed setting, not LLM-controlled) ───────────

router.put('/header-image', requireAdmin, (req, res) => {
  const { url, creditName, creditUrl, downloadLocation } = req.body
  if (!url) return res.status(400).json({ error: 'url required' })
  if (downloadLocation) trackDownload(downloadLocation) // Unsplash usage ping
  const value = JSON.stringify({
    url,
    credit: creditName ? `Photo by ${creditName} on Unsplash` : null,
    creditUrl: creditUrl || null,
  })
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('header_image', value)
  res.json({ ok: true })
})

router.delete('/header-image', requireAdmin, (req, res) => {
  db.prepare("DELETE FROM settings WHERE key = 'header_image'").run()
  res.json({ ok: true })
})

router.post('/assets', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  const { buffer, originalname, mimetype } = req.file
  const isImage = mimetype.startsWith('image/')
  const id = nextAssetId(db)
  const ts = now()

  let uploadBuffer = buffer
  let finalFilename = slugify(path.parse(originalname).name)
  let finalMime = mimetype

  if (isImage) {
    const ext = path.parse(originalname).ext.toLowerCase()
    finalFilename = `${finalFilename}${ext}`

    // Process: strip EXIF, resize to max 1920px
    uploadBuffer = await sharp(buffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .toBuffer()

    // Also create WebP version
    const webpFilename = `${slugify(path.parse(originalname).name)}.webp`
    const webpBuffer = await sharp(buffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer()

    await uploadAsset(webpBuffer, webpFilename, 'image/webp')
  } else {
    finalFilename = `${finalFilename}${path.parse(originalname).ext.toLowerCase()}`
  }

  const { url } = await uploadAsset(uploadBuffer, finalFilename, finalMime)

  db.prepare('INSERT INTO assets (id, filename, bucket_url, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, originalname, url, finalMime, buffer.length, ts)

  res.status(201).json({ id, filename: originalname, url })
})

router.delete('/assets/:id', requireAdmin, async (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)
  if (!asset) return res.status(404).json({ error: 'Not found' })

  const usage = db.prepare('SELECT page_id FROM asset_usage WHERE asset_id = ?').all(req.params.id)
  if (usage.length) return res.status(409).json({ error: 'Asset is in use', pages: usage.map(u => u.page_id) })

  const filename = path.basename(asset.bucket_url)
  await deleteAsset(filename)

  // Also try to delete WebP variant
  const webpFilename = filename.replace(/\.[^.]+$/, '.webp')
  if (webpFilename !== filename) {
    try { await deleteAsset(webpFilename) } catch {}
  }

  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ─── CSS Audit ────────────────────────────────────────────────────────────────

// Split CSS into top-level rules (selector + full body), balancing braces.
function topLevelRules(css) {
  const rules = []
  let i = 0, selStart = 0
  while (i < css.length) {
    if (css[i] === '{') {
      let depth = 1, j = i + 1
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      rules.push({ selector: css.slice(selStart, i).trim(), rule: css.slice(selStart, j).trim() })
      i = j; selStart = j
    } else i++
  }
  return rules
}

// Safety net: if the design pass dropped any required structural/component
// selector entirely, re-append the original rule so the site never breaks.
function preserveStructuralRules(oldCss, newCss) {
  const required = [
    '.site-header', '.site-header-bar', '.site-logo', '.nav-toggle', '.site-nav',
    '.site-content', '.site-footer', '.site-footer-credits',
    '.flow-left', '.flow-right', '.flow-full', '.flow-center',
    '.gallery-grid', '.gallery-strip', '.download-list', '.download-item', '.download-filename',
    '.contact-form', '.form-field', '.form-submit', '.page-section', '.image-credit',
  ]
  const oldRules = topLevelRules(oldCss)
  const restored = []
  for (const sel of required) {
    if (!newCss.includes(sel)) {
      for (const r of oldRules) {
        if (r.selector.includes(sel)) restored.push(r.rule)
      }
    }
  }
  if (!restored.length) return newCss
  const unique = [...new Set(restored)]
  return `${newCss}\n\n/* Auto-restored structural rules the design pass dropped */\n${unique.join('\n\n')}`
}

// Strip any external image URL the LLM may have invented/hardcoded that isn't
// in our tracked, attributed allow-list. Untracked external images have no
// licence or attribution, so we replace them with `none`. Relative URLs (our
// own assets) and data URIs are always kept.
function stripUntrackedImageUrls(css, allowedUrls = []) {
  const allowed = new Set(allowedUrls)
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _q, url) => {
    const u = url.trim()
    if (u.startsWith('data:') || u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) return match
    if (!/^https?:\/\//i.test(u)) return match
    if (allowed.has(u)) return match
    // External absolute URL not in our tracked set — drop it
    console.warn('Stripped untracked external image URL from design CSS:', u)
    return 'none'
  })
}

// Streams progress as newline-delimited JSON while it works, then a final
// { done, updated_css } event. Does NOT apply the CSS — the client previews
// it and confirms via PUT /api/css.
router.post('/css/design', requireAdmin, async (req, res) => {
  const { brief } = req.body
  if (!brief?.trim()) return res.status(400).json({ error: 'brief required' })

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  const send = (obj) => { res.write(JSON.stringify(obj) + '\n') }

  try {
    send({ phase: 'Reading your site…' })
    const cssPath = path.resolve('./public/site/site.css')
    const currentCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : ''
    const pages = db.prepare(`
      SELECT pv.rendered_html FROM page_versions pv
      INNER JOIN (SELECT page_id, MAX(id) AS max_id FROM page_versions GROUP BY page_id) latest
        ON pv.page_id = latest.page_id AND pv.id = latest.max_id
      INNER JOIN pages p ON pv.page_id = p.id
      WHERE p.deleted_at IS NULL AND pv.rendered_html IS NOT NULL
    `).all()
    const allPageHtml = pages.map(p => p.rendered_html)

    const imageUrls = []
    const credits = []
    if (unsplashConfigured()) {
      send({ phase: 'Deciding whether your design needs photos…' })
      const queries = await suggestImageQueries(brief)
      for (const q of queries) {
        send({ phase: `Finding a photo: “${q}”…` })
        try {
          const results = await searchPhotos(q, 1)
          const r = results[0]
          if (r) {
            trackDownload(r.downloadLocation)
            imageUrls.push(r.fullUrl)
            credits.push({ name: r.creditName, url: r.creditUrl })
          }
        } catch (e) { console.error('design image fetch failed:', e.message) }
      }
    }

    send({ phase: 'Writing the new stylesheet… (this is the slow part)' })
    let updatedCss = await designPass({ brief, currentCss, allPageHtml, imageUrls })

    send({ phase: 'Checking nothing got broken…' })
    // Guard against malformed/incomplete CSS — never write a broken stylesheet
    const opens = (updatedCss.match(/\{/g) || []).length
    const closes = (updatedCss.match(/\}/g) || []).length
    if (!updatedCss.trim() || opens !== closes) {
      throw new Error('The design came back incomplete. Please try again.')
    }
    updatedCss = preserveStructuralRules(currentCss, updatedCss)
    // Drop any external image URL the LLM invented outside our tracked set
    updatedCss = stripUntrackedImageUrls(updatedCss, imageUrls)

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('image_credits', JSON.stringify(credits))

    send({ done: true, updated_css: updatedCss, images_added: imageUrls.length })
    res.end()
  } catch (err) {
    send({ error: err.message })
    res.end()
  }
})

router.post('/css/audit', requireAdmin, async (req, res) => {
  const cssPath = path.resolve('./public/site/site.css')
  const currentCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : ''

  const pages = db.prepare(`
    SELECT pv.rendered_html FROM page_versions pv
    INNER JOIN (SELECT page_id, MAX(id) AS max_id FROM page_versions GROUP BY page_id) latest
      ON pv.page_id = latest.page_id AND pv.id = latest.max_id
    INNER JOIN pages p ON pv.page_id = p.id
    WHERE p.deleted_at IS NULL AND pv.rendered_html IS NOT NULL
  `).all()

  const allPageHtml = pages.map(p => p.rendered_html)
  const colorProperties = `--color-bg, --color-text, --color-accent, --color-surface, --color-border, --color-muted`

  try {
    const refactoredCss = await cssAudit({ currentCss, allPageHtml, colorProperties })

    const originalRules = (currentCss.match(/\{/g) || []).length
    const newRules = (refactoredCss.match(/\{/g) || []).length
    const summary = `${originalRules} rules → ${newRules} rules`

    res.json({ refactored_css: refactoredCss, summary })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/css', requireAdmin, (req, res) => {
  const { css } = req.body
  if (typeof css !== 'string') return res.status(400).json({ error: 'css required' })
  const cssPath = path.resolve('./public/site/site.css')
  fs.writeFileSync(cssPath, css, 'utf8')
  res.json({ ok: true })
})

// ─── Contact form ─────────────────────────────────────────────────────────────

router.post('/contact', contactLimit, async (req, res) => {
  const fields = req.body
  if (fields._honeypot) return res.status(200).json({ ok: true }) // silently discard bot submissions

  const required = ['name', 'email', 'message']
  const missing = required.filter(f => !fields[f]?.trim())
  if (missing.length) return res.status(422).json({ error: 'Missing required fields', fields: missing })

  try {
    await sendContactEmail(fields)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email' })
  }
})

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, (req, res) => {
  res.json(getSiteSettings())
})

router.put('/settings', requireAdmin, async (req, res) => {
  const allowed = ['site_name', 'site_description', 'site_ia', 'nav_layout', 'contact_email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from', 'smtp_to']
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')

  for (const [key, value] of Object.entries(req.body)) {
    if (key === 'admin_password') {
      await changeAdminPassword(value)
    } else if (allowed.includes(key)) {
      upsert.run(key, String(value))
    }
  }

  // Optionally store smtp_password separately
  if (req.body.smtp_password) {
    upsert.run('smtp_password', req.body.smtp_password)
  }

  res.json({ ok: true })
})

router.post('/settings/test-smtp', requireAdmin, async (req, res) => {
  try {
    await sendTestEmail()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
