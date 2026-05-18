# Semantic CMS — Block Format Specification v0.1

## Principles

- A page is a flat, ordered array of blocks
- Each block has a unique id, a type, and a content object
- Content structure is defined per type — no generic content blobs
- Collection types (gallery, resource-list) allow one level of nesting; their items are not full blocks
- Text content is stored as an inline mark array, never raw HTML
- Asset references use asset IDs, never raw URLs — resolved at render time
- Block type is not fixed — transforms are supported by preserving id and migrating content
- The LLM semantic pass is the only thing that produces HTML — the block format is never rendered directly

---

## Top-Level Page Structure

```json
{
  "id": "page_01",
  "slug": "about",
  "title": "About Alice",
  "blocks": []
}
```

---

## Inline Mark Array

Used in any field that contains rich text. An array of span objects.

### Span Object

```typescript
type Span =
  | { text: string }                          // plain text, no formatting
  | { text: string; marks: Mark[] }           // formatted text
```

### Mark Types

```typescript
type Mark =
  | "strong"                                  // bold
  | "em"                                      // italic
  | "u"                                       // underline
  | "sup"                                     // superscript
  | { type: "link"; href: string; title?: string }  // hyperlink
```

### Rules

- A span with no marks omits the marks field entirely
- Multiple marks on one span are expressed as an array: `["strong", "em"]`
- A link mark and a formatting mark can coexist on the same span
- Empty text spans are invalid and should be stripped
- The LLM semantic pass may remove marks from headings where they are semantically inappropriate (e.g. a link wrapping an entire heading)

### Example

```json
[
  { "text": "Alice has taught " },
  { "text": "piano and singing", "marks": ["strong"] },
  { "text": " in Cornwall since " },
  { "text": "1990", "marks": [{ "type": "link", "href": "https://example.com" }] },
  { "text": "." }
]
```

---

## Asset Reference

Any block that references an uploaded file uses an asset ID, not a URL.

```json
{ "asset": "asset_01" }
```

The asset is resolved against the assets table at render time:

```
id        | filename          | bucket_url                          | mime       | size
asset_01  | alice-piano.jpg   | https://r2.domain.com/alice-piano.jpg | image/jpeg | 204800
```

This means:
- Assets can be replaced without touching block content
- Bucket providers can be migrated without touching block content
- The editor always sees the original filename, never a UUID

---

## Block Object

```typescript
interface Block {
  id: string           // unique within the page, e.g. "b_01"
  type: BlockType      // see types below
  content: object      // structure defined per type
  meta: object         // optional, type-specific metadata (flow, layout hints etc.)
}
```

---

## Block Types

---

### `heading`

A section heading. Levels 1–3 only. Level 1 is reserved for the page title in most contexts — the LLM semantic pass will use this to inform document structure.

```typescript
interface HeadingContent {
  level: 1 | 2 | 3
  text: Span[]
}
```

```json
{
  "id": "b_01",
  "type": "heading",
  "content": {
    "level": 2,
    "text": [{ "text": "About Alice" }]
  },
  "meta": {}
}
```

**Transform targets**: `paragraph`

---

### `paragraph`

A block of body text. The most common block type.

```typescript
interface ParagraphContent {
  text: Span[]
}
```

```json
{
  "id": "b_02",
  "type": "paragraph",
  "content": {
    "text": [
      { "text": "Alice has taught " },
      { "text": "piano and singing", "marks": ["strong"] },
      { "text": " in Cornwall since 1990." }
    ]
  },
  "meta": {}
}
```

**Transform targets**: `heading`

---

### `image`

A single image with optional caption. The `flow` property expresses the editor's desktop layout intent — the LLM semantic pass uses this as input, not as a direct CSS instruction.

```typescript
interface ImageContent {
  asset: string          // asset ID
  caption?: Span[]       // optional caption, rendered as figcaption
  alt?: string           // optional manual alt text override
                         // if absent, LLM generates from caption and context
}

interface ImageMeta {
  flow: "left" | "right" | "full" | "center"  // desktop layout intent
}
```

```json
{
  "id": "b_03",
  "type": "image",
  "content": {
    "asset": "asset_01",
    "caption": [{ "text": "Alice at the Steinway, Truro Cathedral 2019" }]
  },
  "meta": {
    "flow": "left"
  }
}
```

**Transform targets**: `gallery` (wraps this image as the first gallery item)

---

### `gallery`

An ordered collection of images. One level of nesting — items are not full blocks.

```typescript
interface GalleryItem {
  id: string             // unique within the gallery, e.g. "b_04a"
  asset: string          // asset ID
  caption?: Span[]
  alt?: string
}

interface GalleryContent {
  items: GalleryItem[]
}

interface ColumnSpec {
  desktop: 1 | 2 | 3 | 4
  tablet: 1 | 2 | 3
  mobile: 1 | 2
}

interface GalleryMeta {
  layout: "grid" | "strip"   // grid: equal tiles, strip: horizontal scroll
  columns: ColumnSpec        // column count at each breakpoint
}
```

```json
{
  "id": "b_04",
  "type": "gallery",
  "content": {
    "items": [
      {
        "id": "b_04a",
        "asset": "asset_02",
        "caption": [{ "text": "Concert at Truro Cathedral" }]
      },
      {
        "id": "b_04b",
        "asset": "asset_03",
        "caption": [{ "text": "With the University of Plymouth Choral Society" }]
      }
    ]
  },
  "meta": {
    "layout": "grid",
    "columns": { "desktop": 3, "tablet": 2, "mobile": 1 }
  }
}
```

**Transform targets**: `image` (extracts first item, discards remainder — requires confirmation)

---

### `divider`

A semantic section break. No content. The LLM semantic pass renders this as `<hr>` or uses it to inform section boundaries.

```typescript
interface DividerContent {}
```

```json
{
  "id": "b_05",
  "type": "divider",
  "content": {},
  "meta": {}
}
```

**Transform targets**: none

---

### `file`

A downloadable file attachment. Rendered as a styled download link. Primarily used in the pupils area for sheet music, term dates, etc.

```typescript
interface FileContent {
  asset: string          // asset ID
  label: Span[]          // the link text shown to the user
  description?: Span[]   // optional explanatory text shown beneath the link
}
```

```json
{
  "id": "b_06",
  "type": "file",
  "content": {
    "asset": "asset_04",
    "label": [{ "text": "Spring Term 2025 — Timetable" }],
    "description": [{ "text": "Updated 3rd January. Please check your lesson time." }]
  },
  "meta": {}
}
```

**Transform targets**: `resource-list` (wraps this file as the first list item)

---

### `resource-list`

An ordered collection of downloadable files. One level of nesting. Renders as a semantic list of download links.

```typescript
interface ResourceItem {
  id: string
  asset: string
  label: Span[]
  description?: Span[]
}

interface ResourceListContent {
  items: ResourceItem[]
}
```

```json
{
  "id": "b_07",
  "type": "resource-list",
  "content": {
    "items": [
      {
        "id": "b_07a",
        "asset": "asset_04",
        "label": [{ "text": "Spring Term 2025 — Timetable" }]
      },
      {
        "id": "b_07b",
        "asset": "asset_05",
        "label": [{ "text": "Grade 3 Piano — Recommended Pieces" }]
      }
    ]
  },
  "meta": {}
}
```

**Transform targets**: `file` (extracts first item, discards remainder — requires confirmation)

---

### `contact-form`

First-class block type. Not a plugin. One per site typically, but can appear on any page. Configuration is site-level (SMTP settings), not per-block.

```typescript
interface ContactFormContent {
  heading?: Span[]           // optional heading above the form
  description?: Span[]       // optional introductory text
  fields: FormField[]        // ordered list of fields
  submit_label: Span[]       // text on the submit button
}

interface FormField {
  id: string                 // e.g. "field_name"
  type: "text" | "email" | "tel" | "textarea" | "select"
  label: Span[]
  required: boolean
  placeholder?: string
  options?: string[]         // for select fields only
}
```

```json
{
  "id": "b_08",
  "type": "contact-form",
  "content": {
    "heading": [{ "text": "Get in Touch" }],
    "description": [{ "text": "I'd love to hear from you. I'll get back to you within a couple of days." }],
    "fields": [
      {
        "id": "field_name",
        "type": "text",
        "label": [{ "text": "Your name" }],
        "required": true,
        "placeholder": "Alice Smith"
      },
      {
        "id": "field_email",
        "type": "email",
        "label": [{ "text": "Email address" }],
        "required": true,
        "placeholder": "alice@example.com"
      },
      {
        "id": "field_instrument",
        "type": "select",
        "label": [{ "text": "Instrument of interest" }],
        "required": false,
        "options": ["Piano", "Singing", "Both", "Not sure yet"]
      },
      {
        "id": "field_message",
        "type": "textarea",
        "label": [{ "text": "Message" }],
        "required": true,
        "placeholder": "Tell me a bit about yourself..."
      }
    ],
    "submit_label": [{ "text": "Send Message" }]
  },
  "meta": {}
}
```

**Transform targets**: none

---

## Block ID Format

- Page-level blocks: `b_01`, `b_02`, ... (zero-padded, sequential within page)
- Collection items: `b_04a`, `b_04b`, ... (parent id + lowercase letter suffix)
- Form fields: `field_name`, `field_email`, ... (semantic, not sequential)
- IDs are stable across transforms — a paragraph that becomes a heading keeps its id
- IDs are unique within a page, not globally

---

## Meta Object

The `meta` object carries presentation intent from the editor. It is input to the LLM semantic pass, not a direct CSS instruction. The LLM may honour, reinterpret, or override meta values in service of semantic correctness and mobile-first layout.

Currently defined meta fields:

| Block type | Field | Values | Meaning |
|------------|-------|--------|---------|
| `image` | `flow` | `left`, `right`, `full`, `center` | Desktop layout intent |
| `gallery` | `layout` | `grid`, `strip` | Display arrangement |
| `gallery` | `columns.desktop` | `1`–`4` | Column count on desktop |
| `gallery` | `columns.tablet` | `1`–`3` | Column count on tablet |
| `gallery` | `columns.mobile` | `1`–`2` | Column count on mobile |

The LLM semantic pass may override `columns` values if they are nonsensical for the number of items — e.g. 4 columns for 2 images.

All other blocks have an empty meta object `{}` in v0.1.

---

## Breakpoints

Three named breakpoints used consistently across the block format, CSS, and LLM prompt:

| Name | Range | Typical use |
|------|-------|-------------|
| `mobile` | < 640px | Single column, stacked layout |
| `tablet` | 640px – 1024px | Two column max, moderate spacing |
| `desktop` | > 1024px | Full layout as editor intended |

These names are the only breakpoint vocabulary. `sm`, `md`, `lg`, `xl` are never used. Pixel values are defined once in the CSS and never repeated.

---

## Dark Mode

All colours in the stylesheet are CSS custom properties. Hardcoded hex values anywhere other than the custom property definitions are forbidden and will be flagged by the CSS audit.

```css
:root {
  --color-bg:      #faf9f7;
  --color-text:    #1a1a1a;
  --color-accent:  #2d5a3d;
  --color-surface: #ffffff;
  --color-border:  #e0ddd8;
  --color-muted:   #6b6762;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg:      #1a1a1a;
    --color-text:    #f0ede8;
    --color-accent:  #5a9a6d;
    --color-surface: #242424;
    --color-border:  #333333;
    --color-muted:   #999390;
  }
}
```

Dark mode is automatic via `prefers-color-scheme`. No toggle, no JavaScript, no extra effort from the editor or developer. The CSS audit enforces the custom property contract.

---

## Transforms

A transform changes a block's type while preserving its id and as much content as is meaningful. Transforms are offered contextually in the editor UI.

| From | To | Content mapping |
|------|----|-----------------|
| `paragraph` | `heading` | `text` → `text`, default `level: 2` |
| `heading` | `paragraph` | `text` → `text` |
| `image` | `gallery` | block becomes first gallery item |
| `gallery` | `image` | first item becomes image block, confirmation required |
| `file` | `resource-list` | block becomes first list item |
| `resource-list` | `file` | first item becomes file block, confirmation required |

Destructive transforms (those that discard content) require explicit confirmation in the editor UI.

---

## WordPress Migration

Gutenberg stores blocks as HTML with structured comments:

```html
<!-- wp:paragraph -->
<p>Hello</p>
<!-- /wp:paragraph -->

<!-- wp:image {"id":42,"align":"left"} -->
<figure class="wp-block-image alignleft"><img src="/wp-content/uploads/alice.jpg" alt=""/></figure>
<!-- /wp:image -->
```

The migration tool parses WordPress export XML, extracts block comments, and maps them to this format. Asset URLs are downloaded, uploaded to the configured storage bucket, and replaced with asset IDs. The mapping is:

| WordPress block | This format |
|-----------------|-------------|
| `wp:paragraph` | `paragraph` |
| `wp:heading` | `heading` |
| `wp:image` | `image` |
| `wp:gallery` | `gallery` |
| `wp:file` | `file` |
| `wp:separator` | `divider` |
| `wp:group`, `wp:columns` | flattened, LLM re-infers layout |

---

## Versioning

This is v0.1 of the block format. The version is stored at the page level:

```json
{
  "id": "page_01",
  "slug": "about",
  "title": "About Alice",
  "format_version": "0.1",
  "blocks": []
}
```

Breaking changes increment the minor version. Migration scripts are provided for each version bump.

---

*Next: LLM Semantic Prompt Specification*
