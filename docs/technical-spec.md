# Semantic CMS — Technical Implementation Specification v0.1

## Overview

A single Node.js process serving everything — admin, public site, and API. Nginx in front for SSL termination and static asset caching. PM2 for process management. SQLite for data. A storage bucket for assets.

---

## Directory Structure

```
/
├── server.js                 Entry point
├── db.js                     SQLite connection and schema
├── router/
│   ├── api.js                All /api/* routes
│   ├── admin.js              Serves /admin (static files + auth middleware)
│   └── site.js               Serves public pages
├── services/
│   ├── llm.js                LLM adapter loader and semantic pass runner
│   ├── storage.js            Storage adapter loader and asset operations
│   ├── mailer.js             Contact form email via nodemailer
│   ├── versions.js           Version diffing and description generation
│   └── auth.js               Session auth helpers
├── adapters/
│   ├── llm/
│   │   ├── anthropic.js
│   │   ├── openai.js
│   │   └── ollama.js
│   └── storage/
│       ├── r2.js
│       ├── s3.js
│       ├── backblaze.js
│       └── local.js          Development only
├── prompts/
│   ├── semantic.txt          Semantic HTML prompt (overridable)
│   └── css-audit.txt         CSS audit prompt (overridable)
├── public/
│   ├── admin/                Admin UI (static HTML/JS/CSS)
│   │   ├── index.html        Dashboard
│   │   ├── editor.html       Page editor
│   │   ├── components/       Web Components
│   │   │   ├── cms-block.js
│   │   │   ├── cms-toolbar.js
│   │   │   ├── cms-block-picker.js
│   │   │   ├── cms-asset-library.js
│   │   │   └── cms-version-history.js
│   │   ├── editor.js         Editor orchestration (undo stack, save flow)
│   │   ├── dashboard.js      Dashboard logic
│   │   └── admin.css
│   └── site/                 Public site
│       ├── index.html        Shell — fetches and injects page content
│       ├── site.js           Page routing and content fetching
│       └── site.css          Site stylesheet (managed by CSS audit)
├── config.js                 Runtime config loader
└── package.json
```

---

## Configuration

`config.js` loads from environment variables. A `.env` file is supported for local development.

```javascript
// config.js
export default {
  port:             process.env.PORT || 3000,
  adminPassword:    process.env.ADMIN_PASSWORD,         // required
  sessionSecret:    process.env.SESSION_SECRET,         // required
  
  llm: {
    adapter:        process.env.LLM_ADAPTER || 'anthropic',
    apiKey:         process.env.LLM_API_KEY,
    model:          process.env.LLM_MODEL,              // optional override
  },

  storage: {
    adapter:        process.env.STORAGE_ADAPTER || 'local',
    bucket:         process.env.STORAGE_BUCKET,
    accountId:      process.env.STORAGE_ACCOUNT_ID,    // R2 / S3
    accessKeyId:    process.env.STORAGE_ACCESS_KEY_ID,
    secretKey:      process.env.STORAGE_SECRET_KEY,
    publicUrl:      process.env.STORAGE_PUBLIC_URL,     // base URL for public asset access
  },

  smtp: {
    host:           process.env.SMTP_HOST,
    port:           process.env.SMTP_PORT || 587,
    user:           process.env.SMTP_USER,
    password:       process.env.SMTP_PASSWORD,
    from:           process.env.SMTP_FROM,
    to:             process.env.SMTP_TO,
  },

  db: {
    path:           process.env.DB_PATH || './data/cms.db',
  }
}
```

All sensitive values are environment variables only — never in source code.

---

## Database Schema

```sql
-- Pages
CREATE TABLE pages (
  id              TEXT PRIMARY KEY,           -- e.g. "page_01"
  slug            TEXT UNIQUE NOT NULL,       -- e.g. "about"
  title           TEXT NOT NULL,
  nav_order       INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,                       -- NULL = not protected
  format_version  TEXT NOT NULL DEFAULT '0.1',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Page versions
CREATE TABLE page_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         TEXT NOT NULL REFERENCES pages(id),
  block_json      TEXT NOT NULL,              -- serialised block array
  rendered_html   TEXT,                       -- NULL if LLM pass failed
  description     TEXT NOT NULL,             -- auto-generated diff description
  created_at      TEXT NOT NULL
);

-- Assets
CREATE TABLE assets (
  id              TEXT PRIMARY KEY,           -- e.g. "asset_01"
  filename        TEXT NOT NULL,              -- original filename
  bucket_url      TEXT NOT NULL,              -- resolved bucket URL
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,           -- bytes
  created_at      TEXT NOT NULL
);

-- Asset usage (for deletion protection)
CREATE TABLE asset_usage (
  asset_id        TEXT NOT NULL REFERENCES assets(id),
  page_id         TEXT NOT NULL REFERENCES pages(id),
  PRIMARY KEY (asset_id, page_id)
);

-- Site settings (key-value)
CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

-- Sessions (managed by better-sqlite3-session-store)
CREATE TABLE sessions (
  sid             TEXT PRIMARY KEY,
  sess            TEXT NOT NULL,
  expired_at      TEXT NOT NULL
);
```

All timestamps are stored as ISO 8601 strings (`2025-03-14T10:30:00Z`). SQLite has no native date type — this is conventional and sortable.

---

## API Routes

All routes are under `/api`. All responses are JSON. All mutation routes require admin session auth except `/api/contact`.

### Auth

```
POST   /api/auth/login          { password } → sets session cookie
POST   /api/auth/logout         clears session
GET    /api/auth/status         → { authenticated: bool }
```

### Pages

```
GET    /api/pages               → [{ id, slug, title, nav_order, protected, updated_at }]
GET    /api/pages/:slug         → { id, slug, title, rendered_html } (public, no auth)
POST   /api/pages               { title, slug, password? } → { id }
PUT    /api/pages/:id           { title, nav_order } → 200
DELETE /api/pages/:id           → 200 (soft: marks deleted_at, not removed from DB)
```

### Page Content (Save Flow)

```
POST   /api/pages/:id/save      { block_json } → { version_id, rendered_html, description }
```

This is the main save endpoint. Server-side it:
1. Validates block JSON structure
2. Resolves asset IDs to URLs (for LLM context)
3. Loads previous rendered HTML from latest version
4. Calls LLM semantic pass
5. Diffs block arrays to generate version description
6. Writes new version row
7. Updates asset_usage table
8. Returns rendered HTML and version description

LLM failure is non-fatal — block JSON is saved, rendered_html is NULL, previous HTML continues to be served.

### Page Help (Plain-English Fix)

```
POST   /api/pages/:id/help      { complaint, block_json, current_html } → { adjusted_html }
```

Calls LLM with complaint + context. Returns adjusted HTML for preview. Does not save — client applies on user confirmation via `/api/pages/:id/save`.

### Versions

```
GET    /api/pages/:id/versions  → [{ id, description, created_at }]
POST   /api/pages/:id/versions/:vid/restore → triggers save flow from that version's block_json
```

### Assets

```
GET    /api/assets              → [{ id, filename, mime, size, created_at, used_by_pages: [] }]
POST   /api/assets              multipart/form-data, file → { id, filename, url }
DELETE /api/assets/:id          → 200 or 409 if in use
```

Upload flow:
1. Multer receives file
2. Sharp processes images: strips EXIF, generates WebP version at 1920px max width
3. Original filename preserved (slugified to be URL-safe)
4. File uploaded to storage bucket via adapter
5. Asset row created in DB

### CSS Audit

```
POST   /api/css/audit           (admin only) → { refactored_css, summary }
```

Gathers all rendered HTML from current page versions, sends to LLM CSS audit prompt, returns refactored CSS. Does not apply automatically — client applies on confirmation.

```
PUT    /api/css                 { css } → writes to public/site/site.css
```

### Contact Form

```
POST   /api/contact             { fields } → 200 or 422
```

Public route, no auth. Rate limited. Validates required fields server-side. Sends email via nodemailer. Honeypot field checked (a hidden field that legitimate users never fill — bots do).

### Settings

```
GET    /api/settings            → { site_name, site_description, smtp_*, contact_email }
PUT    /api/settings            { ...settings } → 200
POST   /api/settings/test-smtp  → sends test email → 200 or 500
```

---

## LLM Service

```javascript
// services/llm.js

import config from '../config.js'
import fs from 'fs'

// Load adapter dynamically based on config
const adapter = (await import(`../adapters/llm/${config.llm.adapter}.js`)).default

// Load prompt files, fall back to built-in defaults
function loadPrompt(name) {
  const customPath = `./prompts/${name}.txt`
  const defaultPath = new URL(`../prompts/${name}.txt`, import.meta.url)
  return fs.existsSync(customPath)
    ? fs.readFileSync(customPath, 'utf8')
    : fs.readFileSync(defaultPath, 'utf8')
}

export async function semanticPass({ blockJson, pageTitle, pageSlug, previousHtml, assetMap, siteSettings }) {
  const prompt = loadPrompt('semantic')
  const context = buildSemanticContext({ blockJson, pageTitle, pageSlug, previousHtml, assetMap, siteSettings })
  return adapter.complete(prompt, context)
}

export async function cssAudit({ currentCss, allPageHtml }) {
  const prompt = loadPrompt('css-audit')
  const context = buildCssAuditContext({ currentCss, allPageHtml })
  return adapter.complete(prompt, context)
}

export async function helpPass({ complaint, blockJson, currentHtml, pageTitle, pageSlug, siteSettings }) {
  const prompt = loadPrompt('semantic')
  const context = buildHelpContext({ complaint, blockJson, currentHtml, pageTitle, pageSlug, siteSettings })
  return adapter.complete(prompt, context)
}
```

### Adapter Interface

Each adapter exports a default object with a single method:

```javascript
// adapters/llm/anthropic.js
import config from '../../config.js'

export default {
  async complete(systemPrompt, userContent) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.llm.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.llm.model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    })
    const data = await response.json()
    return data.content[0].text
  }
}
```

```javascript
// adapters/llm/ollama.js
export default {
  async complete(systemPrompt, userContent) {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        model: config.llm.model || 'llama3',
        system: systemPrompt,
        prompt: userContent,
        stream: false
      })
    })
    const data = await response.json()
    return data.response
  }
}
```

---

## Storage Service

```javascript
// services/storage.js
const adapter = (await import(`../adapters/storage/${config.storage.adapter}.js`)).default

export async function uploadAsset(buffer, filename, mime) {
  return adapter.upload(buffer, filename, mime)
  // returns: { url: string }
}

export async function deleteAsset(filename) {
  return adapter.delete(filename)
}
```

### Storage Adapter Interface

```javascript
// adapters/storage/r2.js
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${config.storage.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretKey,
  }
})

export default {
  async upload(buffer, filename, mime) {
    await client.send(new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: filename,
      Body: buffer,
      ContentType: mime,
    }))
    return { url: `${config.storage.publicUrl}/${filename}` }
  },

  async delete(filename) {
    await client.send(new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: filename,
    }))
  }
}
```

```javascript
// adapters/storage/local.js — development only
import fs from 'fs'
import path from 'path'

const uploadDir = './public/uploads'

export default {
  async upload(buffer, filename, mime) {
    fs.mkdirSync(uploadDir, { recursive: true })
    fs.writeFileSync(path.join(uploadDir, filename), buffer)
    return { url: `/uploads/${filename}` }
  },

  async delete(filename) {
    fs.unlinkSync(path.join(uploadDir, filename))
  }
}
```

---

## Version Diffing

Auto-generated version descriptions without LLM — pure JavaScript.

```javascript
// services/versions.js

export function describeChange(previousBlocks, currentBlocks) {
  if (!previousBlocks || previousBlocks.length === 0) return 'Page created'

  const prev = new Map(previousBlocks.map(b => [b.id, b]))
  const curr = new Map(currentBlocks.map(b => [b.id, b]))

  const added   = currentBlocks.filter(b => !prev.has(b.id))
  const removed = previousBlocks.filter(b => !curr.has(b.id))
  const changed = currentBlocks.filter(b => {
    const p = prev.get(b.id)
    return p && JSON.stringify(p) !== JSON.stringify(b)
  })

  const parts = []
  if (added.length)   parts.push(`${added.length} block${added.length > 1 ? 's' : ''} added`)
  if (removed.length) parts.push(`${removed.length} block${removed.length > 1 ? 's' : ''} removed`)
  if (changed.length) parts.push(`${changed.length} block${changed.length > 1 ? 's' : ''} edited`)

  return parts.length ? parts.join(', ') : 'No changes'
}
```

---

## Public Site Routing

The public site is a single `index.html` shell. JavaScript fetches page content from the API on load.

```javascript
// public/site/site.js

const slug = window.location.pathname.replace(/^\//, '') || 'home'

async function loadPage(slug) {
  const res = await fetch(`/api/pages/${slug}`)
  
  if (res.status === 401) {
    // Password-protected page
    renderPasswordForm(slug)
    return
  }
  
  if (res.status === 404) {
    renderNotFound()
    return
  }

  const page = await res.json()
  document.title = `${page.title} — ${siteName}`
  document.getElementById('content').innerHTML = page.rendered_html
}

loadPage(slug)
```

Page titles and site name are injected into `index.html` at server start from settings.

Protected page flow:
1. `/api/pages/:slug` returns 401 if page has a password and no valid session
2. Client renders a minimal password form
3. Form posts to `/api/pages/:slug/unlock` with password
4. Server checks hash, sets page-scoped session cookie, returns 200
5. Client retries `/api/pages/:slug` — now returns content

---

## Image Processing

On upload, Sharp processes all image files:

```javascript
// in the upload route handler
import sharp from 'sharp'

async function processImage(buffer, originalFilename) {
  const slug = slugify(originalFilename)           // "Alice Piano.JPG" → "alice-piano.jpg"
  
  // WebP version at max 1920px, strips EXIF
  const webpBuffer = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer()

  // Keep original as fallback (for non-WebP browsers — rare now but correct)
  const originalBuffer = await sharp(buffer)
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .toBuffer()

  return { webpBuffer, originalBuffer, slug }
}
```

Two files are stored per image upload: `alice-piano.webp` and `alice-piano.jpg`. The HTML semantic pass uses `<picture>` with WebP source and JPEG fallback:

```html
<picture>
  <source srcset="https://r2.../alice-piano.webp" type="image/webp">
  <img src="https://r2.../alice-piano.jpg" alt="...">
</picture>
```

---

## Auth Middleware

```javascript
// services/auth.js

export function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next()
  res.status(401).json({ error: 'Unauthorised' })
}

// Applied to all /api routes except:
// GET /api/pages/:slug  (public content)
// POST /api/contact     (contact form)
// POST /api/auth/login  (login itself)
// POST /api/pages/:slug/unlock (page password)
```

Session cookie is HttpOnly, Secure (in production), SameSite=Strict. Session stored in SQLite via `better-sqlite3-session-store`.

Admin password is stored hashed in the settings table (bcrypt, 12 rounds). Never in environment variables after initial setup — env var is only used for first-run bootstrap.

---

## Rate Limiting

Applied to public mutation routes:

```javascript
import rateLimit from 'express-rate-limit'

const contactLimit = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 5,                      // 5 contact form submissions per IP
  message: { error: 'Too many submissions, please try again later' }
})

const unlockLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                     // 10 password attempts per IP
  message: { error: 'Too many attempts, please try again later' }
})
```

---

## Server Entry Point

```javascript
// server.js
import express from 'express'
import session from 'express-session'
import multer from 'multer'
import config from './config.js'
import db from './db.js'
import apiRouter from './router/api.js'
import adminRouter from './router/admin.js'
import siteRouter from './router/site.js'

const app = express()

app.use(express.json())
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000   // 30 days
  }
}))

app.use('/api', apiRouter)
app.use('/admin', adminRouter)
app.use('/', siteRouter)

app.listen(config.port, () => {
  console.log(`Semantic CMS running on port ${config.port}`)
})
```

---

## Dependencies

```json
{
  "dependencies": {
    "express": "^4",
    "better-sqlite3": "^9",
    "express-session": "^1",
    "better-sqlite3-session-store": "^0",
    "multer": "^1",
    "sharp": "^0.33",
    "nodemailer": "^6",
    "bcrypt": "^5",
    "express-rate-limit": "^7",
    "@aws-sdk/client-s3": "^3"
  },
  "devDependencies": {
    "dotenv": "^16"
  },
  "type": "module",
  "engines": {
    "node": ">=20"
  }
}
```

No frontend build toolchain. No TypeScript compilation. No bundler. The admin JS files are served as ES modules directly. Native browser features throughout.

---

## Nginx Configuration

```nginx
server {
    listen 80;
    server_name alicedennis.net www.alicedennis.net;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name alicedennis.net www.alicedennis.net;

    ssl_certificate     /etc/letsencrypt/live/alicedennis.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alicedennis.net/privkey.pem;

    # Cache static assets aggressively
    location ~* \.(css|js|woff2|ico)$ {
        proxy_pass http://localhost:3000;
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Don't cache HTML or API responses
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "no-cache";
    }
}
```

---

## PM2 Configuration

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'semantic-cms',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
}
```

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

---

## First Run

On first start, if the database is empty:

1. Schema is created
2. Default settings are seeded (empty site name/description)
3. Admin password is read from `ADMIN_PASSWORD` env var, hashed, stored in settings table, env var no longer needed
4. A home page is created with a single contact-form block
5. Console output: `Semantic CMS ready. Visit http://localhost:3000/admin to set up your site.`

---

## Package Name

`semantic-cms` — available on npm as of writing. Straightforward, descriptive, no clever wordplay that dates badly.

---

*Specification complete. Next: implementation.*
