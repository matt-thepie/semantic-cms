# Semantic CMS — Editor UI Specification v0.1

## Overview

Two interfaces:

1. **Dashboard** — site overview, page list, asset library, site settings
2. **Page Editor** — block editing, version history, publish

Both are served as static HTML/JS from the Express server under `/admin`. No framework. Vanilla JS and Web Components. No build step.

The admin is accessible at `/admin` and is protected by session auth. One password, site-wide.

---

## Design Principles

- Every control Alice needs is visible. Nothing is hidden behind right-clicks, obscure keyboard shortcuts, or tooltips that only appear after hovering for 2 seconds.
- Every destructive action is recoverable. Delete a block → undo. Mess up a page → version history.
- The interface uses plain English. No jargon. "Add a block" not "Insert node". "Undo" not "Revert state".
- The admin looks professional but not intimidating. It is not a developer tool dressed up.

---

## 1. Dashboard

### Layout

```
┌─────────────────────────────────────────────────┐
│  [Site name]                        [Log out]   │
├─────────────────────────────────────────────────┤
│                                                 │
│  Pages          Assets         Settings         │
│  ──────         ──────         ────────         │
│  [page list]    [asset grid]   [smtp etc]       │
│                                                 │
│                                 [Tidy CSS]      │
└─────────────────────────────────────────────────┘
```

Three tabs. Pages is the default.

### Pages Tab

A simple list. Each row:

```
┌──────────────────────────────────────────────────────┐
│  About          /about        Saved 2 days ago  [Edit]│
│  Lessons        /lessons      Saved today        [Edit]│
│  Contact        /contact      Saved 1 week ago   [Edit]│
│  Pupils         /pupils  🔒   Saved 3 days ago   [Edit]│
└──────────────────────────────────────────────────────┘
                                            [+ New page]
```

- Pages are listed in navigation order, draggable to reorder
- The lock icon on Pupils indicates password protection
- "Saved N ago" is a human-readable relative timestamp
- No published/draft states in v0.1 — saves are live immediately
- [+ New page] opens a simple dialog: page title, slug (auto-derived from title, editable), password protection toggle

### Assets Tab

A grid of uploaded files. Each cell shows:
- Thumbnail (images) or file type icon (PDFs, etc.)
- Original filename below
- Click to copy asset ID to clipboard (for developer use)
- Hover reveals a delete button (with confirmation)

Upload is drag-and-drop onto the grid, or a file picker button. Multiple files accepted. Progress shown per file.

Assets that are referenced by at least one page cannot be deleted — the UI shows which pages use them.

### Settings Tab

```
Site name         [Alice Dennis — Piano & Singing Teacher    ]
Site description  [Private music tuition in Cornwall         ]

Contact email     [alice@alicedennis.net                     ]
SMTP host         [smtp.example.com                          ]
SMTP port         [587                                       ]
SMTP user         [alice@alicedennis.net                     ]
SMTP password     [••••••••                                  ]

Admin password    [Change password...]

                                              [Save settings]
```

SMTP settings are tested on save — a test email is sent to the contact address. Success/failure is shown inline.

### Tidy CSS Button

Bottom right of the Settings tab. Opens a confirmation dialog:

> "This will refactor the site stylesheet using AI. It won't change how the site looks, but it will clean up the underlying CSS. This may take 10–20 seconds."
>
> [Cancel]  [Tidy CSS]

Progress is shown. On completion, a diff summary: "47 rules → 31 rules. 3 hardcoded colours replaced."

---

## 2. Page Editor

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  ← Dashboard   About                [History] [Save]    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│                                                         │
│   [block]                                               │
│   ── + ──                                               │
│   [block]                                               │
│   ── + ──                                               │
│   [block]                                               │
│   ── + ──                                               │
│                                                         │
│                        [Something doesn't look right?] │
└─────────────────────────────────────────────────────────┘
```

- Header: back to dashboard, page title (editable inline), history button, save button
- Body: scrollable block stack
- Footer: the plain-English help trigger

The editor width is constrained to match the site's content width — Alice is always editing at approximately the width the content will render on desktop.

### Undo / Redo

Keyboard: Cmd+Z / Ctrl+Z (undo), Cmd+Shift+Z / Ctrl+Shift+Z (redo)

A subtle undo/redo control sits in the header:

```
← →   About   ...
```

The arrows are greyed out when there is nothing to undo/redo. No undo history panel — just the keyboard shortcuts and the arrows. The undo stack is in-session only and is lost on page close or save.

On save, the undo stack is cleared. The version history takes over from that point.

---

## Block Stack

### Add Block Affordance

Between every pair of blocks, and before the first block and after the last:

```
────────────── + ──────────────
```

A thin horizontal line with a centred + button. Always visible, not hover-dependent. Clicking + opens the block picker inline.

### Block Picker

A small popover appears below the + button. Eight block type options arranged in two rows of four:

```
┌─────────────────────────────────┐
│  ¶ Text   H Heading  ─ Divider  │
│  🖼 Image  ▦ Gallery  📎 File   │
│  📋 List   ✉ Contact            │
└─────────────────────────────────┘
```

Labels are short and plain. Icons are simple. Clicking any option inserts an empty block of that type at the chosen position and immediately activates it for editing.

The popover closes if the user clicks outside it or presses Escape.

---

## Block Component

Each block is a Web Component: `<cms-block type="paragraph" id="b_02">`.

### Inactive State

```
┌─────────────────────────────────────────────────────┐
│  ⠿  Alice has taught piano and singing in Cornwall  │
│     since 1990.                                     │
└─────────────────────────────────────────────────────┘
```

- Drag handle (⠿) always visible on the left
- Content rendered as it will approximately appear on the site
- Subtle border to show it is a discrete block

### Active State (clicked)

```
┌──────────────────────────────────────────────────────────────┐
│  [B] [I] [U] [🔗] │ [↕ Transform] │ [↑] [↓] │ [🗑 Delete]  │
├──────────────────────────────────────────────────────────────┤
│  ⠿  Alice has taught piano and singing in Cornwall           │
│     since 1990.                                              │
└──────────────────────────────────────────────────────────────┘
```

Toolbar appears above the block. Toolbar sections are separated by vertical dividers. Actions from left to right: formatting, transform, move, delete.

Only the actions relevant to this block type are shown. The toolbar never shows disabled/greyed buttons — irrelevant actions simply don't appear.

---

## Block Toolbars by Type

### Paragraph

```
[B] [I] [U] [🔗]  │  [↕ Text → Heading]  │  [↑] [↓]  │  [🗑]
```

- B / I / U apply to the current text selection, not the whole block
- Link opens a small popover: URL input + confirm button
- Transform opens a popover: "Convert to Heading" with level picker H1 / H2 / H3

Content is edited directly inline — the block becomes a contenteditable region when active.

### Heading

```
[H1] [H2] [H3]  │  [↕ Heading → Text]  │  [↑] [↓]  │  [🗑]
```

- H1 / H2 / H3 are toggle buttons — the active level is highlighted
- Inline formatting is intentionally omitted (the LLM semantic pass strips inappropriate marks anyway)
- Transform: "Convert to Paragraph"

Content edited inline.

### Image

```
[◧ Left] [▣ Full] [◨ Right] [◫ Center]  │  [↕ → Gallery]  │  [↑] [↓]  │  [🗑]
```

- Flow buttons are icon-only with tooltips — left float, full width, right float, centered
- Active flow is highlighted
- Transform: "Convert to Gallery" (this image becomes the first gallery item)

Block body:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│          [  Click to replace image  ]               │
│                  [thumbnail]                        │
│                                                     │
│  Caption (optional):  [ type here...             ]  │
│  Alt text override:   [ leave blank to auto-gen  ]  │
└─────────────────────────────────────────────────────┘
```

Clicking the thumbnail opens the asset library panel (see below). Caption and alt text are plain text inputs, not rich text — captions don't need formatting.

### Gallery

```
[▦ Grid] [▤ Strip]  │  Columns: [desktop 3▾] [tablet 2▾] [mobile 1▾]  │  [↕ → Image]  │  [↑] [↓]  │  [🗑]
```

- Layout toggle: grid or strip
- Column dropdowns per breakpoint — simple selects, values constrained by breakpoint rules
- Transform: "Convert to single image" (takes first item, requires confirmation if more than one item)

Block body shows a live preview grid of the gallery items:

```
┌──────┬──────┬──────┐
│  🖼  │  🖼  │  🖼  │   [+ Add image]
└──────┴──────┴──────┘
```

Each thumbnail is clickable to edit its caption/alt text inline. Draggable within the gallery to reorder. Hover reveals a remove button.

[+ Add image] opens the asset library panel.

### Divider

```
[↑] [↓]  │  [🗑]
```

No additional actions. Rendered as a visual horizontal rule in the editor.

### File

```
[↕ → Resource List]  │  [↑] [↓]  │  [🗑]
```

Block body:

```
┌─────────────────────────────────────────────────────┐
│  File:   alice-spring-term.pdf    [Replace]          │
│  Label:  [ Spring Term 2025 — Timetable           ]  │
│  Note:   [ Updated 3rd Jan. Check your time.      ]  │
└─────────────────────────────────────────────────────┘
```

### Resource List

```
[↕ → File (first item only)]  │  [↑] [↓]  │  [🗑]
```

Block body shows each file item as a row:

```
┌─────────────────────────────────────────────────┐
│  ⠿  alice-spring-term.pdf   Spring Term 2025    [✎] [🗑] │
│  ⠿  grade3-pieces.pdf       Grade 3 Piano       [✎] [🗑] │
│                                      [+ Add file]        │
└─────────────────────────────────────────────────┘
```

Rows are draggable to reorder. Edit (✎) expands the row to show label and description fields.

### Contact Form

```
[✎ Edit fields]  │  [↑] [↓]  │  [🗑]
```

The form is too complex to edit inline. [Edit fields] opens a sidebar panel:

```
┌─────────────────────────────┐
│  Contact Form Fields        │
│  ───────────────────────    │
│  ⠿  Name         text  [🗑] │
│  ⠿  Email        email [🗑] │
│  ⠿  Instrument   select[🗑] │
│  ⠿  Message      textarea[🗑]│
│                             │
│  [+ Add field]              │
│                             │
│  Submit button text:        │
│  [ Send Message           ] │
│                             │
│              [Done]         │
└─────────────────────────────┘
```

Fields are draggable to reorder. Each has a type badge. [+ Add field] presents: text / email / tel / textarea / select. Select fields have an additional "edit options" control.

---

## Asset Library Panel

Appears as a slide-in panel from the right when selecting or replacing an image or file.

```
┌────────────────────────────────┐
│  Choose an asset          [✕]  │
│  ───────────────────────────   │
│  [🔍 Search...            ]    │
│                                │
│  [+ Upload new]                │
│                                │
│  ┌──────┬──────┬──────┐        │
│  │alice │piano │truro │        │
│  │piano │recit │cathe │        │
│  │.jpg  │al.jpg│dral  │        │
│  └──────┴──────┴──────┘        │
│                                │
└────────────────────────────────┘
```

- Filenames shown below thumbnails — always the original filename, never an ID
- Search filters by filename in real time
- [+ Upload new] accepts a file and immediately selects it
- Clicking a thumbnail selects it and closes the panel

---

## Version History Panel

Opened via [History] in the editor header. Slides in from the right.

```
┌────────────────────────────────────────┐
│  Version history                  [✕]  │
│  ─────────────────────────────────     │
│  Today 14:32   Image added        [↩]  │
│  Today 11:05   3 blocks changed   [↩]  │
│  Yesterday     Heading edited     [↩]  │
│  3 days ago    Page created       [↩]  │
└────────────────────────────────────────┘
```

- Descriptions are auto-generated by diffing block arrays — plain English, no LLM required
- [↩] restores that version — shows a confirmation: "This will replace the current page content. The current state will be saved as a version first."
- Restoring triggers the semantic pass and saves a new version

---

## Plain-English Help

Fixed to the bottom of the editor:

```
Something doesn't look right?
```

Clicking expands a small panel:

```
┌──────────────────────────────────────────────────┐
│  Tell me what looks wrong:                        │
│                                                   │
│  [ The photo is too big on my phone             ] │
│                                                   │
│                                    [Ask for help] │
└──────────────────────────────────────────────────┘
```

On submit:
- Sends: current block JSON + current rendered HTML + the plain-English complaint
- Model returns adjusted HTML
- A preview panel opens showing before/after
- "Apply this fix" saves the new HTML and adds a version
- "Try again" lets her describe the problem differently

---

## Save Flow

[Save] in the editor header:

1. Block JSON is validated client-side (no empty required fields, no broken asset references)
2. If invalid, inline errors shown — save is blocked
3. JSON is sent to `/api/pages/:id/save`
4. Server sends block JSON + context to LLM semantic pass
5. HTML is returned and stored alongside the block JSON
6. A new version row is created
7. Undo stack is cleared
8. Save button returns to its default state
9. "Saved just now" appears in the header

If the LLM call fails, the block JSON is saved without rendered HTML, and a warning is shown: "Content saved but HTML could not be generated. Try saving again." The page continues to serve the previous rendered HTML until a successful save.

---

## Pupils Area (Password Protection)

Pages marked as password-protected are served under a simple middleware check. The password is set per-page in the new page dialog and is stored hashed in SQLite.

On the public site, visiting a protected page shows a minimal password form. On correct entry, a session cookie is set for that page. No account creation, no email verification.

In the editor, protected pages show a lock icon in the dashboard list. The editor itself is unchanged — the password protection is a public-facing concern only.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + Z | Undo |
| Cmd/Ctrl + Shift + Z | Redo |
| Cmd/Ctrl + S | Save |
| Escape | Close any open popover or panel |
| Enter (on + button) | Open block picker |
| Arrow keys (on block) | Move focus between blocks |

---

*Next: Technical Implementation Specification*
