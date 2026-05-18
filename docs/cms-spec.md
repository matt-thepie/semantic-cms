# Semantic CMS — Project Specification

## Overview

A lightweight, Node-based CMS built around a genuinely novel architecture: a block editor where an LLM acts as the semantic translation layer between user intent and accessible, responsive HTML. Built for non-technical editors. Designed to run happily on minimal cloud infrastructure.

---

## The Problem With Existing CMSes

- **WordPress**: Correct editor experience, catastrophic technical stack. PHP, MySQL, plugin hell, 100MB to render one page.
- **Headless CMSes (Payload, Directus, etc.)**: Built by developers, for developers. The editor UX is an afterthought. Non-technical users cannot use them without a developer intermediary. Ironically, developers don't need a CMS.
- **Block editors (Gutenberg)**: Good mental model, horrible semantic output. Conflates visual layout with document structure. Generates `div > div > div > p` where `<article>` and `<figure>` belong. No concept of mobile layout.
- **"AI editors"**: Marketing. They use LLMs to generate content or suggest colours. Nobody uses the model as a semantic translation layer.

---

## Core Architecture

### The Block Model

A page is a flat, ordered list of typed blocks. Not a blob of HTML. Not nested containers.

```json
[
  { "type": "heading", "level": 1, "content": "About Alice" },
  { "type": "paragraph", "content": "Alice has taught piano since 1990..." },
  { "type": "image", "src": "alice-piano.jpg", "caption": "Alice at the Steinway", "flow": "left" },
  { "type": "paragraph", "content": "She moved to Cornwall in 2017..." }
]
```

Block types (initial set):
- `heading` (h1–h3)
- `paragraph`
- `image`
- `gallery` (collection of images)
- `divider`
- `file` (downloadable attachment)
- `contact-form` (first-class, not a plugin)

Positioning is expressed as a property on the block (`flow: left | right | full | center`), not as a container block. The page remains a flat list. Layout relationships between adjacent blocks are inferred, not declared.

### The LLM Semantic Layer

This is the core innovation. On save, the block JSON is passed to an LLM with a carefully constructed prompt. The LLM returns clean, semantic, accessible, mobile-first HTML. This HTML is what gets stored and served.

**What the LLM infers that a dumb renderer cannot:**
- Whether an image is decorative or informative, and generates `alt` text accordingly
- Whether a sequence of short paragraphs is a `<dl>`, a `<ul>`, or narrative prose
- Whether an image adjacent to paragraphs constitutes a `<figure>` wrapping
- The information hierarchy of the page, and therefore the correct heading levels
- Mobile layout: given desktop intent, what does a phone user need first

**The prompt framing:**

> A non-technical user has arranged the following content blocks on a desktop canvas. Infer the purpose and information hierarchy of this page. From that, produce mobile-first semantic HTML where the mobile layout reflects what a phone user needs most. The desktop layout should honour the user's arrangement where it makes sense, but both layouts should serve the content's purpose rather than literally reproduce the user's decisions. Use semantic HTML elements throughout. Generate descriptive alt text for all images based on available context.

The model does not make visual design decisions. It makes semantic and structural decisions. Visual design is CSS — the developer's responsibility, done once.

### The Feedback Loop

A plain-English help button is available in the editor. If the published result doesn't look right, the editor describes the problem in their own words:

> "The photo is too big on my phone"
> "The text looks squashed next to the picture"

The model receives the block JSON, the current HTML output, and the complaint. It adjusts and re-renders. No phone call to the developer. No explanation of what a media query is.

---

## Technical Stack

### Server
- **Runtime**: Node.js
- **Framework**: Express
- **Database**: SQLite via `better-sqlite3` (synchronous, zero config, sufficient for any small-to-medium site)
- **Auth**: `express-session` with a single admin password (no user management complexity)
- **File handling**: `multer` for uploads, `sharp` for image processing

### Client (Admin)
- **Editor**: TipTap (rich text, extensible, headless — UI is fully controlled)
- **Block management**: Vanilla JS + Web Components (no framework, no build step)
- **Drag to reorder**: Native browser Drag and Drop API
- **No React**: React is not essential to this architecture. Web Components provide the component model. A framework can be added by the developer if they choose.

### Client (Public Site)
- Client-side rendering from the Express JSON API
- Each page fetches its content on load — no build step, no rebuild when content changes
- Alice saves a change, it is live immediately
- The stored HTML (output of the LLM semantic pass) is injected directly into the page

### Asset Storage
- Pluggable storage adapter — local disk for development, bucket for production
- Default recommendation: **Cloudflare R2** (S3-compatible API, free egress)
- App is stateless with respect to assets — assets are never stored on the server

### LLM Integration
- Pluggable LLM adapter — developer supplies their own key and chooses their provider
- Adapter interface: a single `complete(prompt, content)` method
- Ships with adapters for: Anthropic, OpenAI, Ollama (local, free, no key required)
- The semantic prompt is a plain text file — developer can override it
- LLM call is made client-side from the admin UI (admin is behind auth, key exposure surface is minimal)
- API key never touches the public site
- A thin `/api/semantic` proxy endpoint on the Express server keeps the key server-side if preferred

---

## Deployment

A single Node process. Nginx in front. PM2 to keep it alive. SSL via Certbot.

```
Node (Express)   →  port 3000  (API + admin + public site)
Nginx            →  reverse proxy, SSL termination
PM2              →  process management
Cloudflare R2    →  asset storage (or any S3-compatible bucket)
SQLite           →  single file on disk, back it up like any other file
```

RAM footprint: ~80–120MB idle. Runs comfortably on a $5 VPS.

---

## Default State

On first run, the CMS contains:

- One home page (blank, ready to edit)
- One contact form (wired to email via SMTP config, working immediately)
- Nothing else

No blog. No comments. No sample posts. No widgets. No "Hello World." No sidebar. The developer adds pages deliberately during setup.

---

## What The Editor Actually Does

1. Goes to `admin.yourdomain.com` in their browser
2. Logs in with a password
3. Clicks a page to edit it
4. Sees their blocks: text, images, etc.
5. Clicks between blocks to add a new one
6. Picks block type (paragraph, image, etc.)
7. For images: drag and drop from their desktop, or pick from the media library
8. Sets image flow (left / right / full) with a single click
9. Hits save
10. LLM semantic pass runs
11. Change is live

If something looks wrong on mobile:
1. Clicks "Something doesn't look right"
2. Types a plain English description
3. LLM adjusts
4. Editor approves or describes again

---

## What The Editor Never Touches

- CSS
- HTML
- Media queries
- Alt text (generated by the LLM from context)
- Mobile layout (inferred by the LLM from desktop intent)
- Git
- The terminal
- You

---

## Open Source Considerations

- LLM adapter is pluggable — no vendor lock-in
- Storage adapter is pluggable — no infrastructure lock-in
- Semantic prompt is overridable — developer can tune output
- Ollama adapter allows fully local operation with no external API costs
- Minimal dependencies by design — no framework churn, no upstream breaking changes
- The block JSON format is the public contract — renderers, importers, exporters can be built against it

---

## What This Is Not

- A blogging platform
- A multi-user CMS with roles and permissions
- A page builder with drag-and-drop layout columns
- A WordPress replacement in the feature-parity sense
- An "AI writing assistant"

---

## Explicit Non-Goals

- Comments
- Blog/post taxonomy
- Plugin ecosystem
- Visual theme switching
- Multi-language support (v1)
- Real-time collaborative editing

---

*This document is a living spec. Implementation begins with the block format definition and the LLM prompt design.*
