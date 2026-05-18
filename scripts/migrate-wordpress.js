#!/usr/bin/env node
/**
 * WordPress → Semantic CMS migration script
 * Usage: node scripts/migrate-wordpress.js path/to/export.xml
 *
 * Reads a WordPress WXR export, extracts published pages, downloads images
 * from the live site, and seeds the local database with block JSON.
 * Rendered HTML is left null — save each page from the editor to trigger
 * the LLM semantic pass.
 */

import fs from 'fs'
import https from 'https'
import http from 'http'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load CMS modules
const configPath = path.join(__dirname, '../config.js')
process.env.STORAGE_ADAPTER = process.env.STORAGE_ADAPTER || 'local'
process.env.LLM_ADAPTER     = process.env.LLM_ADAPTER     || 'anthropic'
process.env.LLM_API_KEY     = process.env.LLM_API_KEY     || 'dummy'
process.env.ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'migrate'
process.env.SESSION_SECRET  = process.env.SESSION_SECRET  || 'migrate'

const { default: db } = await import('../db.js')
const { uploadAsset } = await import('../services/storage.js')

const xmlFile = process.argv[2]
if (!xmlFile) { console.error('Usage: node scripts/migrate-wordpress.js export.xml'); process.exit(1) }

const xml = fs.readFileSync(xmlFile, 'utf8')

// ─── XML helpers ──────────────────────────────────────────────────────────────

function extractAll(text, tagName) {
  const results = []
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'g')
  let m
  while ((m = re.exec(text)) !== null) results.push(m[1].trim())
  return results
}

function extractFirst(text, tagName, fallback = '') {
  const m = text.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`))
  return m ? m[1].trim() : fallback
}

function extractCdata(text, tagName, fallback = '') {
  const m = text.match(new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`))
  return m ? m[1].trim() : fallback
}

// ─── HTML entity decode + tag strip ───────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#160;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '')
}

function stripTags(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
}

function text(str) { return [{ text: str.trim() }] }

// ─── Content block extraction ─────────────────────────────────────────────────

function extractParagraphBlocks(content) {
  const blocks = []
  // Standard Gutenberg paragraphs
  const paraRe = /<!--\s*wp:paragraph[^>]*-->\s*<p[^>]*>([\s\S]*?)<\/p>\s*<!--\s*\/wp:paragraph\s*-->/g
  let m
  while ((m = paraRe.exec(content)) !== null) {
    const raw = stripTags(m[1]).trim()
    if (raw && raw.length > 2) blocks.push(raw)
  }
  // Kubio text blocks (raw text between comments)
  const kubioTextRe = /<!--\s*wp:kubio\/text[^>]*-->\s*([\s\S]*?)\s*<!--\s*\/wp:kubio\/text\s*-->/g
  while ((m = kubioTextRe.exec(content)) !== null) {
    const raw = stripTags(m[1]).trim()
    if (raw && raw.length > 2) blocks.push(raw)
  }
  return blocks
}

function extractHeadingBlocks(content) {
  const blocks = []
  const re = /<!--\s*wp:heading[^>]*-->\s*<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>\s*<!--\s*\/wp:heading\s*-->/g
  let m
  while ((m = re.exec(content)) !== null) {
    const level = Math.min(3, parseInt(m[1])) // clamp to 1-3
    const raw = stripTags(m[2]).trim()
    if (raw) blocks.push({ level, text: raw })
  }
  return blocks
}

function extractImageUrls(content) {
  const urls = []
  // From Kubio image blocks: "url":"https://..."
  const kubioImgRe = /"url"\s*:\s*"(https?:\/\/alicedennis\.net\/wp-content\/uploads\/[^"]+)"/g
  let m
  while ((m = kubioImgRe.exec(content)) !== null) {
    if (!urls.includes(m[1])) urls.push(m[1])
  }
  // Standard wp:image
  const wpImgRe = /<!--\s*wp:image[^>]*?-->\s*[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<!--\s*\/wp:image\s*-->/g
  while ((m = wpImgRe.exec(content)) !== null) {
    if (!urls.includes(m[1]) && m[1].includes('alicedennis.net')) urls.push(m[1])
  }
  return urls
}

// Split a long paragraph that contains double newlines into multiple paragraphs
function splitIntoParagraphs(raw) {
  return raw.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(p => p.length > 0)
}

// ─── Image download + upload ──────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

function slugifyFilename(url) {
  const base = path.basename(url).split('?')[0]
  return base.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-')
}

function nextAssetId() {
  const row = db.prepare("SELECT id FROM assets WHERE id LIKE 'asset_%' ORDER BY id DESC LIMIT 1").get()
  if (!row) return 'asset_01'
  const last = parseInt(row.id.replace('asset_', ''), 10)
  return `asset_${String(last + 1).padStart(2, '0')}`
}

async function importImage(url) {
  // Check if already imported by URL
  const existing = db.prepare('SELECT id FROM assets WHERE bucket_url LIKE ?').get(`%${path.basename(url).split('?')[0]}%`)
  if (existing) { console.log(`  ↩ already imported: ${path.basename(url)}`); return existing.id }

  console.log(`  ↓ downloading: ${path.basename(url)}`)
  let buffer
  try { buffer = await downloadBuffer(url) } catch (e) { console.warn(`  ✗ failed: ${e.message}`); return null }

  const originalFilename = slugifyFilename(url)
  const ext = path.extname(originalFilename).toLowerCase()
  const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)

  if (!isImage) {
    const { url: bucketUrl } = await uploadAsset(buffer, originalFilename, 'application/octet-stream')
    const id = nextAssetId()
    db.prepare('INSERT INTO assets (id, filename, bucket_url, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, originalFilename, bucketUrl, 'application/octet-stream', buffer.length, new Date().toISOString())
    return id
  }

  // Process image with sharp
  const processed = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true })

  const webpBuffer = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()

  const baseName = path.parse(originalFilename).name
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
  const finalFilename = `${baseName}${ext}`
  const webpFilename = `${baseName}.webp`

  await uploadAsset(webpBuffer, webpFilename, 'image/webp')
  const { url: bucketUrl } = await uploadAsset(processed.data, finalFilename, mime)

  const id = nextAssetId()
  db.prepare('INSERT INTO assets (id, filename, bucket_url, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, originalFilename, bucketUrl, mime, buffer.length, new Date().toISOString())

  console.log(`  ✓ ${finalFilename} → ${id}`)
  return id
}

// ─── Parse XML items ──────────────────────────────────────────────────────────

function parseItems(xml) {
  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml)) !== null) items.push(m[1])
  return items
}

function parseItem(raw) {
  return {
    title:    decodeEntities(extractCdata(raw, 'title')),
    slug:     extractCdata(raw, 'wp:post_name'),
    postType: extractCdata(raw, 'wp:post_type'),
    status:   extractCdata(raw, 'wp:status'),
    content:  extractCdata(raw, 'content:encoded'),
    navOrder: parseInt(extractFirst(raw, 'wp:menu_order', '0')),
    postId:   extractFirst(raw, 'wp:post_id', '0'),
  }
}

// ─── Build block JSON for a page ─────────────────────────────────────────────

async function buildBlocks(content, imageUrlToAssetId) {
  const blocks = []
  let blockNum = 0

  function id() { return `b_${String(++blockNum).padStart(2, '0')}` }

  // Extract paragraphs — split on double newlines (long WP paragraphs with <br> chains)
  const rawParas = extractParagraphBlocks(content)
  const paragraphs = []
  for (const raw of rawParas) {
    for (const p of splitIntoParagraphs(raw)) {
      if (p.length > 2) paragraphs.push(p)
    }
  }

  // Extract images in the order they appear in the kubio blocks
  const imageUrls = extractImageUrls(content)
  const imageAssetIds = []
  for (const url of imageUrls) {
    const assetId = imageUrlToAssetId[url]
    if (assetId) imageAssetIds.push(assetId)
  }

  // Build paragraph blocks
  for (const p of paragraphs) {
    blocks.push({ id: id(), type: 'paragraph', content: { text: text(p) }, meta: {} })
  }

  // Add images — if multiple (≥2) group as a gallery, otherwise single image blocks
  if (imageAssetIds.length === 1) {
    blocks.push({ id: id(), type: 'image', content: { asset: imageAssetIds[0] }, meta: { flow: 'right' } })
  } else if (imageAssetIds.length >= 2) {
    const galleryId = id()
    blocks.push({
      id: galleryId,
      type: 'gallery',
      content: {
        items: imageAssetIds.map((assetId, i) => ({
          id: `${galleryId}${String.fromCharCode(97 + i)}`,
          asset: assetId,
        })),
      },
      meta: { layout: 'grid', columns: { desktop: Math.min(imageAssetIds.length, 3), tablet: 2, mobile: 1 } },
    })
  }

  return blocks
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const items = parseItems(xml).map(parseItem)

// Pages to import: published, type=page, not trashed
const pages = items.filter(i =>
  i.postType === 'page' &&
  i.status === 'publish' &&
  !i.slug.endsWith('__trashed') &&
  i.title && i.title !== 'Sample Page' && i.title !== 'Privacy Policy'
)

console.log(`Found ${pages.length} pages to import`)
pages.forEach(p => console.log(`  → ${p.title} (/${p.slug})`))

// Collect all image URLs across all pages
const allImageUrls = new Set()
for (const page of pages) {
  for (const url of extractImageUrls(page.content)) allImageUrls.add(url)
}

console.log(`\nDownloading ${allImageUrls.size} images...`)
const imageUrlToAssetId = {}
for (const url of allImageUrls) {
  const assetId = await importImage(url)
  if (assetId) imageUrlToAssetId[url] = assetId
}

// Clear the seeded home page that server.js creates on first run
const existingHome = db.prepare("SELECT id FROM pages WHERE slug = 'home' AND deleted_at IS NULL").get()
if (existingHome) {
  console.log('\nRemoving seeded home page...')
  db.prepare('DELETE FROM page_versions WHERE page_id = ?').run(existingHome.id)
  db.prepare('DELETE FROM pages WHERE id = ?').run(existingHome.id)
}

// Nav order mapping from the footer nav in the WordPress export
const navOrderMap = {
  'biography':               1,
  'choral-conducting':       2,
  'singing-and-piano-lessons': 3,
  'lessons-in-marazion':     4,
  'accompanying':            5,
  'front_page':              0,
  'home':                    0,
}

console.log('\nImporting pages...')

let pageNum = 0
const now = new Date().toISOString()

// Page ID counter - check existing
function nextPageId() {
  const row = db.prepare("SELECT id FROM pages WHERE id LIKE 'page_%' ORDER BY id DESC LIMIT 1").get()
  if (!row) return 'page_01'
  const last = parseInt(row.id.replace('page_', ''), 10)
  return `page_${String(last + 1).padStart(2, '0')}`
}

for (const page of pages) {
  // Normalise slug
  let slug = page.slug.replace(/__trashed$/, '')
  if (slug === 'front_page') slug = 'home'

  // Skip if already exists
  const existing = db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').get(slug)
  if (existing) { console.log(`  ↩ skip (exists): /${slug}`); continue }

  const pageId = nextPageId()
  const navOrder = navOrderMap[slug] ?? navOrderMap[page.slug] ?? 10
  const title = page.title === 'Home' && slug !== 'home' ? page.title : page.title

  db.prepare(`
    INSERT INTO pages (id, slug, title, nav_order, format_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, '0.1', ?, ?)
  `).run(pageId, slug, title, navOrder, now, now)

  const blocks = await buildBlocks(page.content, imageUrlToAssetId)

  // If this is the home page, add a contact form block at the end
  if (slug === 'home') {
    blocks.push({
      id: `b_${String(blocks.length + 1).padStart(2, '0')}`,
      type: 'contact-form',
      content: {
        heading: [{ text: 'Get in Touch' }],
        description: [{ text: "I'd love to hear from you. I'll get back to you within a couple of days." }],
        fields: [
          { id: 'field_name',       type: 'text',     label: [{ text: 'Your name' }],           required: true,  placeholder: 'Jane Smith' },
          { id: 'field_email',      type: 'email',    label: [{ text: 'Email address' }],        required: true,  placeholder: 'jane@example.com' },
          { id: 'field_instrument', type: 'select',   label: [{ text: 'Instrument of interest' }], required: false, options: ['Piano', 'Singing', 'Both', 'Theory', 'Not sure yet'] },
          { id: 'field_message',    type: 'textarea', label: [{ text: 'Message' }],              required: true,  placeholder: 'Tell me a bit about yourself...' },
        ],
        submit_label: [{ text: 'Send Message' }],
      },
      meta: {},
    })
  }

  db.prepare(`
    INSERT INTO page_versions (page_id, block_json, rendered_html, description, created_at)
    VALUES (?, ?, NULL, 'Imported from WordPress', ?)
  `).run(pageId, JSON.stringify(blocks), now)

  // Update asset usage
  const assetIds = new Set()
  const collectAssets = (b) => {
    if (b.content?.asset) assetIds.add(b.content.asset)
    if (b.content?.items) b.content.items.forEach(item => { if (item.asset) assetIds.add(item.asset) })
  }
  blocks.forEach(collectAssets)
  const insertUsage = db.prepare('INSERT OR IGNORE INTO asset_usage (asset_id, page_id) VALUES (?, ?)')
  for (const aid of assetIds) insertUsage.run(aid, pageId)

  console.log(`  ✓ ${pageId} /${slug} "${title}" — ${blocks.length} blocks, ${assetIds.size} images`)
}

// Seed site settings from the channel title
const siteTitle = decodeEntities(extractFirst(xml, 'title'))
if (siteTitle && siteTitle !== 'Alice Dennis BEM GTCL LTCL BEM') {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_name', siteTitle)
} else {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_name', 'Alice Dennis BEM GTCL LTCL')
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_description', 'Piano & singing teacher, choral conductor, accompanist — Marazion, Cornwall')
}

console.log('\nDone. Start the server and save each page to trigger the LLM semantic pass.')
console.log('Or run: npm run dev')
