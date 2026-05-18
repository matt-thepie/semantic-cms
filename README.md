# Semantic CMS

A lightweight Node.js CMS where an LLM acts as the semantic translation layer between a block editor and accessible, mobile-first HTML.

Non-technical editors arrange content blocks. On save, the block JSON is passed to an LLM which returns clean, semantic HTML — with correct heading hierarchy, meaningful alt text, and a mobile-first layout. The editor never touches HTML, CSS, or media queries.

## Quick start

```bash
cp .env.example .env
# Edit .env — set ADMIN_PASSWORD, SESSION_SECRET, and your LLM API key

npm install
npm start
# Visit http://localhost:3000/admin
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

### LLM adapters

| Adapter | Env var | Default model |
|---------|---------|---------------|
| `anthropic` | `LLM_API_KEY` | claude-sonnet-4-6 |
| `openai` | `LLM_API_KEY` | gpt-4o |
| `ollama` | _(none)_ | llama3 |

Set `LLM_ADAPTER` to switch. Ollama runs locally with no API key required.

### Storage adapters

| Adapter | Notes |
|---------|-------|
| `local` | Dev only — stores files in `public/uploads/` |
| `r2` | Cloudflare R2 (recommended for production) |
| `s3` | AWS S3 |
| `backblaze` | Backblaze B2 |

### Customising the LLM prompts

The semantic HTML prompt and CSS audit prompt are plain text files in `prompts/`. Edit them to tune the LLM output for your site.

## Block types

- `heading` — h1, h2, or h3
- `paragraph` — body text with inline formatting
- `image` — single image with caption and flow (left/right/full/center)
- `gallery` — grid or strip of images
- `divider` — section break
- `file` — downloadable attachment
- `resource-list` — collection of downloadable files
- `contact-form` — first-class contact form, wired to SMTP

## Production deployment

```bash
# Install PM2
npm install -g pm2

# Start
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

Nginx config and full deployment instructions are in [docs/technical-spec.md](docs/technical-spec.md).

## Architecture

See [docs/cms-spec.md](docs/cms-spec.md) for the full project specification.

**Stack:** Node.js 20+, Express, SQLite (better-sqlite3), vanilla JS + Web Components (no framework, no build step).

**RAM footprint:** ~80–120MB idle. Runs on a $5 VPS.
