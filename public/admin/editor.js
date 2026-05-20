// Page editor orchestration

const params = new URLSearchParams(window.location.search)
const pageId = params.get('id')
if (!pageId) window.location.href = '/admin/'

let blocks = []
let undoStack = []
let redoStack = []
let currentHtml = ''
let assetPickerCallback = null

async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  const res = await fetch('/api' + path, opts)
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorised') }
  return res
}

// ─── Block ID generation ──────────────────────────────────────────────────────

function nextBlockId() {
  const nums = blocks.map(b => parseInt(b.id?.replace('b_', ''), 10)).filter(n => !isNaN(n))
  const max = nums.length ? Math.max(...nums) : 0
  return `b_${String(max + 1).padStart(2, '0')}`
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────────

function snapshot() { return JSON.parse(JSON.stringify(blocks)) }

function pushUndo() {
  undoStack.push(snapshot())
  redoStack = []
  updateUndoButtons()
}

function undo() {
  if (!undoStack.length) return
  redoStack.push(snapshot())
  blocks = undoStack.pop()
  updateUndoButtons()
  renderBlocks()
}

function redo() {
  if (!redoStack.length) return
  undoStack.push(snapshot())
  blocks = redoStack.pop()
  updateUndoButtons()
  renderBlocks()
}

function updateUndoButtons() {
  document.getElementById('undo-btn').disabled = !undoStack.length
  document.getElementById('redo-btn').disabled = !redoStack.length
}

document.getElementById('undo-btn').addEventListener('click', undo)
document.getElementById('redo-btn').addEventListener('click', redo)

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'Z' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo() }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
  if (e.key === 'Escape') {
    closeAllPopovers()
    closePanels()
  }
})

function closePanels() {
  document.getElementById('asset-panel').hidden = true
  document.getElementById('history-panel').hidden = true
  assetPickerCallback = null
}

document.addEventListener('click', e => {
  const assetPanel = document.getElementById('asset-panel')
  if (!assetPanel.hidden && !assetPanel.contains(e.target) && !e.target.closest('.asset-pick-btn, .gallery-add-btn, .add-file-btn, #asset-panel-upload')) {
    assetPanel.hidden = true
    assetPickerCallback = null
  }
})

// ─── Load page ────────────────────────────────────────────────────────────────

async function loadPage() {
  const res = await api('GET', `/pages/${pageId}/content`)
  if (!res.ok) { alert('Page not found'); window.location.href = '/admin/'; return }

  const page = await res.json()
  document.title = `${page.title} — Editor`
  document.getElementById('page-title-display').textContent = page.title
  document.getElementById('page-purpose').value = page.purpose || ''
  blocks = page.block_json
  currentHtml = page.rendered_html

  renderBlocks()
}

document.getElementById('page-purpose').addEventListener('change', async (e) => {
  await api('PUT', `/pages/${pageId}`, { purpose: e.target.value })
})

// ─── Block rendering ──────────────────────────────────────────────────────────

function spansToHtml(spans) {
  if (!spans) return ''
  return spans.map(span => {
    let html = escHtml(span.text)
    if (span.marks) {
      for (const mark of span.marks) {
        if (mark === 'strong') html = `<strong>${html}</strong>`
        else if (mark === 'em') html = `<em>${html}</em>`
        else if (mark === 'u') html = `<u>${html}</u>`
        else if (mark === 'sup') html = `<sup>${html}</sup>`
        else if (mark?.type === 'link') html = `<a href="${escAttr(mark.href)}">${html}</a>`
      }
    }
    return html
  }).join('')
}

function spansToPlain(spans) {
  return (spans || []).map(s => s.text).join('')
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;')
}

// Parse a contentEditable element's DOM back into the Span[] format,
// capturing strong/em/u/sup/link marks. Used to persist inline formatting.
function htmlToSpans(root) {
  const spans = []
  const walk = (node, marks) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) {
          spans.push(marks.length ? { text: child.textContent, marks: [...marks] } : { text: child.textContent })
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase()
        let mark = null
        if (tag === 'strong' || tag === 'b') mark = 'strong'
        else if (tag === 'em' || tag === 'i') mark = 'em'
        else if (tag === 'u') mark = 'u'
        else if (tag === 'sup') mark = 'sup'
        else if (tag === 'a') mark = { type: 'link', href: child.getAttribute('href') || '' }
        else if (tag === 'br') { spans.push({ text: '\n' }); continue }
        else if (tag === 'div' || tag === 'p') { walk(child, marks); continue }
        walk(child, mark ? [...marks, mark] : marks)
      }
    }
  }
  walk(root, [])
  return normalizeSpans(spans)
}

// Merge adjacent spans with identical marks, drop empties, guarantee at least one span.
function normalizeSpans(spans) {
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || [])
  const out = []
  for (const s of spans) {
    if (!s.text) continue
    const last = out[out.length - 1]
    if (last && same(last.marks, s.marks)) last.text += s.text
    else out.push({ text: s.text, ...(s.marks ? { marks: s.marks } : {}) })
  }
  return out.length ? out : [{ text: '' }]
}

function blockPreview(block) {
  const emptyHint = '<span class="preview-empty">Empty — click to edit</span>'
  switch (block.type) {
    case 'heading':
      return `<h${block.content.level} class="preview-heading">${spansToHtml(block.content.text) || emptyHint}</h${block.content.level}>`
    case 'paragraph':
      return `<p>${spansToHtml(block.content.text) || emptyHint}</p>`
    case 'list': {
      const tag = block.content.ordered ? 'ol' : 'ul'
      const items = (block.content.items || []).map(item => `<li>${spansToHtml(item)}</li>`).join('')
      return `<${tag} class="preview-list">${items}</${tag}>`
    }
    case 'image':
      return `<div class="preview-image-row">
        <div class="preview-image-thumb">${block.content.asset ? '🖼' : '[ no image ]'}</div>
        <span class="preview-image-caption">${spansToPlain(block.content.caption) || ''}</span>
      </div>`
    case 'gallery':
      return `<div class="preview-gallery">Gallery — ${block.content.items?.length || 0} image${(block.content.items?.length || 0) !== 1 ? 's' : ''}</div>`
    case 'divider':
      return `<hr class="preview-divider">`
    case 'file':
      return `<div class="preview-file">📎 ${block.content.label ? spansToPlain(block.content.label) : 'File'}</div>`
    case 'resource-list':
      return `<div class="preview-file">📋 ${block.content.items?.length || 0} file${(block.content.items?.length || 0) !== 1 ? 's' : ''}</div>`
    case 'contact-form':
      return `<div class="preview-form">✉ Contact form</div>`
    default:
      return `<div>${block.type}</div>`
  }
}

function renderBlocks() {
  const stack = document.getElementById('block-stack')
  stack.innerHTML = ''

  stack.appendChild(makeAddAffordance(-1))

  blocks.forEach((block, index) => {
    const wrapper = document.createElement('div')
    wrapper.className = 'block-wrapper'
    wrapper.dataset.id = block.id
    wrapper.dataset.index = index

    const el = document.createElement('div')
    el.className = 'block-item'
    el.innerHTML = `
      <span class="drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <div class="block-preview">${blockPreview(block)}</div>
    `
    el.addEventListener('click', e => { if (!e.target.closest('.drag-handle')) activateBlock(index) })

    wrapper.appendChild(el)
    stack.appendChild(wrapper)
    stack.appendChild(makeAddAffordance(index))
  })

  initBlockDrag()
}

function makeAddAffordance(afterIndex) {
  const div = document.createElement('div')
  div.className = 'add-affordance'
  div.innerHTML = '<button class="add-block-btn" title="Add block">+</button>'
  div.querySelector('.add-block-btn').addEventListener('click', e => {
    e.stopPropagation()
    showBlockPicker(afterIndex, div.querySelector('.add-block-btn'))
  })
  return div
}

// ─── Block drag reorder ───────────────────────────────────────────────────────

function initBlockDrag() {
  const stack = document.getElementById('block-stack')
  let dragging = null

  stack.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('dragstart', e => {
      dragging = handle.closest('.block-wrapper')
      dragging.classList.add('dragging')
    })
  })

  stack.addEventListener('dragover', e => {
    e.preventDefault()
    const target = e.target.closest('.block-wrapper')
    if (target && target !== dragging) {
      const rect = target.getBoundingClientRect()
      if (e.clientY < rect.top + rect.height / 2) stack.insertBefore(dragging, target)
      else stack.insertBefore(dragging, target.nextSibling)
    }
  })

  stack.addEventListener('dragend', () => {
    if (!dragging) return
    dragging.classList.remove('dragging')
    pushUndo()
    // Reorder blocks array to match DOM
    const newOrder = [...stack.querySelectorAll('.block-wrapper')].map(w => w.dataset.id)
    blocks = newOrder.map(id => blocks.find(b => b.id === id)).filter(Boolean)
    dragging = null
    renderBlocks()
  })
}

// ─── Block picker ─────────────────────────────────────────────────────────────

let activePicker = null

function showBlockPicker(afterIndex, anchor) {
  closeAllPopovers()
  const template = document.getElementById('block-picker-template')
  const picker = template.content.cloneNode(true).querySelector('.block-picker')

  picker.querySelectorAll('.block-picker-option').forEach(btn => {
    btn.addEventListener('click', () => {
      insertBlock(btn.dataset.type, afterIndex)
      picker.remove()
      activePicker = null
    })
  })

  anchor.after(picker)
  activePicker = picker
}

function closeAllPopovers() {
  // Only remove pickers — the toolbar is part of the active block editor and
  // must not be stripped out (that would leave a block with no delete button).
  document.querySelectorAll('.block-picker').forEach(el => el.remove())
  activePicker = null
}

document.addEventListener('click', e => {
  if (activePicker && !activePicker.contains(e.target) && !e.target.closest('.add-block-btn')) {
    closeAllPopovers()
  }
})

// ─── Insert / delete blocks ───────────────────────────────────────────────────

function defaultBlock(type) {
  const id = nextBlockId()
  switch (type) {
    case 'heading':      return { id, type, content: { level: 2, text: [{ text: '' }] }, meta: {} }
    case 'paragraph':    return { id, type, content: { text: [{ text: '' }] }, meta: {} }
    case 'list':         return { id, type, content: { ordered: false, items: [[{ text: '' }]] }, meta: {} }
    case 'image':        return { id, type, content: { asset: null }, meta: { flow: 'full' } }
    case 'gallery':      return { id, type, content: { items: [] }, meta: { layout: 'grid', columns: { desktop: 3, tablet: 2, mobile: 1 } } }
    case 'divider':      return { id, type, content: {}, meta: {} }
    case 'file':         return { id, type, content: { asset: null, label: [{ text: '' }] }, meta: {} }
    case 'resource-list':return { id, type, content: { items: [] }, meta: {} }
    case 'contact-form': return { id, type, content: {
      heading: [{ text: 'Get in Touch' }],
      fields: [
        { id: 'field_name',    type: 'text',     label: [{ text: 'Your name' }],     required: true },
        { id: 'field_email',   type: 'email',    label: [{ text: 'Email address' }], required: true },
        { id: 'field_message', type: 'textarea', label: [{ text: 'Message' }],       required: true },
      ],
      submit_label: [{ text: 'Send Message' }],
    }, meta: {} }
    default: return { id, type, content: {}, meta: {} }
  }
}

function insertBlock(type, afterIndex) {
  pushUndo()
  const block = defaultBlock(type)
  blocks.splice(afterIndex + 1, 0, block)
  renderBlocks()
  // Immediately activate the new block
  activateBlock(afterIndex + 1)
}

function deleteBlock(index) {
  pushUndo()
  blocks.splice(index, 1)
  renderBlocks()
}

function moveBlock(index, direction) {
  const target = index + direction
  if (target < 0 || target >= blocks.length) return
  pushUndo();
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]]
  renderBlocks()
}

// Transform a block to another type, preserving its id and text
function transformBlock(index, toType) {
  const block = blocks[index]
  if (!block || block.type === toType) return
  pushUndo()

  // Extract text spans from the source block (paragraph/heading have content.text,
  // list items get joined)
  let spans
  if (block.type === 'list') {
    spans = (block.content.items || []).flatMap((item, i) =>
      i === 0 ? item : [{ text: ' ' }, ...item])
  } else {
    spans = block.content?.text || [{ text: '' }]
  }

  if (toType === 'heading') {
    block.type = 'heading'
    block.content = { level: 2, text: spans }
  } else if (toType === 'paragraph') {
    block.type = 'paragraph'
    block.content = { text: spans }
  } else if (toType === 'list') {
    block.type = 'list'
    block.content = { ordered: false, items: [spans] }
    block.meta = {}
  }

  renderBlocks()
  activateBlock(index)
}

// ─── Active block editor ──────────────────────────────────────────────────────

let activeIndex = null

function activateBlock(index) {
  closeAllPopovers()
  activeIndex = index
  const block = blocks[index]
  if (!block) return

  // Remove any existing active editors
  document.querySelectorAll('.block-active-editor').forEach(el => el.remove())
  document.querySelectorAll('.block-item').forEach(el => el.classList.remove('active'))

  const wrappers = document.querySelectorAll('.block-wrapper')
  const wrapper = wrappers[index]
  if (!wrapper) return
  wrapper.querySelector('.block-item').classList.add('active')

  const editor = buildBlockEditor(block, index)
  wrapper.appendChild(editor)
}

function buildBlockEditor(block, index) {
  const div = document.createElement('div')
  div.className = 'block-active-editor'

  div.innerHTML = buildToolbar(block, index)

  const body = buildEditorBody(block, index)
  div.appendChild(body)

  // Toolbar event wiring
  div.querySelector('[data-action="move-up"]')?.addEventListener('click', () => moveBlock(index, -1))
  div.querySelector('[data-action="move-down"]')?.addEventListener('click', () => moveBlock(index, 1))
  div.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
    if (confirm('Delete this block?')) deleteBlock(index)
  })

  // Heading level buttons (live in the toolbar, not the body)
  div.querySelectorAll('[data-level]').forEach(btn => {
    btn.addEventListener('click', () => {
      pushUndo()
      block.content.level = parseInt(btn.dataset.level)
      activateBlock(index)
    })
  })

  // Transform buttons (paragraph ↔ heading ↔ list)
  div.querySelectorAll('[data-transform]').forEach(btn => {
    btn.addEventListener('click', () => transformBlock(index, btn.dataset.transform))
  })

  // List style buttons (bullet / numbered)
  div.querySelectorAll('[data-list-style]').forEach(btn => {
    btn.addEventListener('click', () => {
      pushUndo()
      block.content.ordered = btn.dataset.listStyle === 'number'
      activateBlock(index)
    })
  })

  // Inline formatting buttons (bold/italic/underline/link) for paragraphs
  div.querySelectorAll('[data-fmt]').forEach(btn => {
    // mousedown + preventDefault keeps the text selection inside the editor
    btn.addEventListener('mousedown', e => e.preventDefault())
    btn.addEventListener('click', () => {
      const editor = div.querySelector('.inline-editor')
      if (!editor) return
      editor.focus()
      const fmt = btn.dataset.fmt
      if (fmt === 'link') {
        const url = prompt('Link URL (include https://):', 'https://')
        if (url && url !== 'https://') document.execCommand('createLink', false, url)
      } else {
        document.execCommand(fmt, false, null)
      }
      block.content.text = htmlToSpans(editor)
      const preview = div.closest('.block-wrapper')?.querySelector('.block-preview')
      if (preview) preview.innerHTML = blockPreview(block)
    })
  })

  return div
}

function buildToolbar(block, index) {
  const moveControls = `<button class="toolbar-btn" data-action="move-up" title="Move up">↑</button>
    <button class="toolbar-btn" data-action="move-down" title="Move down">↓</button>`
  const deleteBtn = `<button class="toolbar-btn toolbar-btn-danger" data-action="delete" title="Delete">🗑</button>`

  let specific = ''
  switch (block.type) {
    case 'paragraph':
      specific = `<button class="toolbar-btn" data-fmt="bold" title="Bold"><b>B</b></button>
        <button class="toolbar-btn" data-fmt="italic" title="Italic"><i>I</i></button>
        <button class="toolbar-btn" data-fmt="underline" title="Underline"><u>U</u></button>
        <button class="toolbar-btn" data-fmt="link" title="Add link">🔗</button>
        <span class="toolbar-sep"></span>
        <button class="toolbar-btn" data-transform="heading" title="Convert to heading">↕ Heading</button>
        <button class="toolbar-btn" data-transform="list" title="Convert to list">↕ List</button>
        <span class="toolbar-sep"></span>`
      break
    case 'heading':
      specific = `<button class="toolbar-btn ${block.content.level===1?'active':''}" data-level="1">H1</button>
        <button class="toolbar-btn ${block.content.level===2?'active':''}" data-level="2">H2</button>
        <button class="toolbar-btn ${block.content.level===3?'active':''}" data-level="3">H3</button>
        <span class="toolbar-sep"></span>
        <button class="toolbar-btn" data-transform="paragraph" title="Convert to text">↕ Text</button>
        <span class="toolbar-sep"></span>`
      break
    case 'list':
      specific = `<button class="toolbar-btn ${!block.content.ordered?'active':''}" data-list-style="bullet" title="Bulleted">• List</button>
        <button class="toolbar-btn ${block.content.ordered?'active':''}" data-list-style="number" title="Numbered">1. List</button>
        <span class="toolbar-sep"></span>
        <button class="toolbar-btn" data-transform="paragraph" title="Convert to text">↕ Text</button>
        <span class="toolbar-sep"></span>`
      break
    case 'image':
      specific = `<button class="toolbar-btn ${block.meta.flow==='left'?'active':''}" data-flow="left" title="Float left">◧</button>
        <button class="toolbar-btn ${block.meta.flow==='full'?'active':''}" data-flow="full" title="Full width">▣</button>
        <button class="toolbar-btn ${block.meta.flow==='right'?'active':''}" data-flow="right" title="Float right">◨</button>
        <button class="toolbar-btn ${block.meta.flow==='center'?'active':''}" data-flow="center" title="Center">◫</button>
        <span class="toolbar-sep"></span>`
      break
  }

  return `<div class="block-toolbar">${specific}${moveControls}<span class="toolbar-sep"></span>${deleteBtn}</div>`
}

function buildEditorBody(block, index) {
  const div = document.createElement('div')
  div.className = 'block-editor-body'

  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      const ta = document.createElement('div')
      ta.className = 'inline-editor'
      ta.contentEditable = 'true'
      ta.spellcheck = true
      ta.innerHTML = spansToHtml(block.content.text)
      // Headings stay plain text (the semantic pass strips heading marks anyway);
      // paragraphs preserve inline marks (bold/italic/underline/link).
      const syncText = () => {
        block.content.text = block.type === 'heading'
          ? [{ text: ta.innerText.trim() }]
          : htmlToSpans(ta)
      }
      ta.addEventListener('input', () => {
        syncText()
        // Refresh just this block's preview — no full re-render (that would
        // destroy the DOM mid-interaction and break the next click)
        const preview = ta.closest('.block-wrapper')?.querySelector('.block-preview')
        if (preview) preview.innerHTML = blockPreview(block)
      })
      ta.addEventListener('blur', syncText)

      div.appendChild(ta)
      setTimeout(() => { ta.focus(); placeCursorAtEnd(ta) }, 0)
      break
    }

    case 'list': {
      const itemsText = (block.content.items || []).map(item => spansToPlain(item)).join('\n')
      div.innerHTML = `
        <div class="list-editor">
          <p class="muted">One item per line</p>
          <textarea class="list-items-input" rows="${Math.max(3, (block.content.items || []).length)}"></textarea>
        </div>
      `
      const ta = div.querySelector('.list-items-input')
      ta.value = itemsText
      const sync = () => {
        const lines = ta.value.split('\n')
        block.content.items = lines.length ? lines.map(l => [{ text: l }]) : [[{ text: '' }]]
      }
      ta.addEventListener('input', () => {
        sync()
        const preview = ta.closest('.block-wrapper')?.querySelector('.block-preview')
        if (preview) preview.innerHTML = blockPreview(block)
      })
      ta.addEventListener('blur', () => {
        const lines = ta.value.split('\n').map(l => l.trim()).filter(l => l.length)
        block.content.items = lines.length ? lines.map(l => [{ text: l }]) : [[{ text: '' }]]
      })
      setTimeout(() => ta.focus(), 0)
      break
    }

    case 'image': {
      const assetInfo = block.content.asset ? `Asset: ${block.content.asset}` : 'No image selected'
      div.innerHTML = `
        <div class="image-editor">
          <button class="btn btn-ghost asset-pick-btn">Click to ${block.content.asset ? 'replace' : 'choose'} image</button>
          <p class="muted">${assetInfo}</p>
          <div class="form-field">
            <label>Caption (optional)</label>
            <input type="text" class="caption-input" value="${escAttr(spansToPlain(block.content.caption))}">
          </div>
          <div class="form-field">
            <label>Alt text override <span class="muted">(leave blank to auto-generate)</span></label>
            <input type="text" class="alt-input" value="${escAttr(block.content.alt || '')}">
          </div>
        </div>
      `
      div.querySelector('.asset-pick-btn').addEventListener('click', () => {
        openAssetPicker(asset => {
          pushUndo()
          block.content.asset = asset.id
          activateBlock(index)
        })
      })
      div.querySelector('.caption-input').addEventListener('change', e => {
        block.content.caption = [{ text: e.target.value }]
      })
      div.querySelector('.alt-input').addEventListener('change', e => {
        block.content.alt = e.target.value || undefined
      })
      div.addEventListener('click', e => {
        const flow = e.target.dataset?.flow
        if (flow) { pushUndo(); block.meta.flow = flow; activateBlock(index) }
      })
      break
    }

    case 'gallery': {
      const items = block.content.items || []
      div.innerHTML = `
        <div class="gallery-editor">
          <div class="gallery-items">${items.map((item, i) => `
            <div class="gallery-item-row" data-i="${i}">
              <span>${item.asset || 'No asset'}</span>
              <input type="text" class="gallery-caption" placeholder="Caption" value="${escAttr(spansToPlain(item.caption))}">
              <button class="btn-icon gallery-item-remove" data-i="${i}">✕</button>
            </div>
          `).join('')}</div>
          <button class="btn btn-ghost gallery-add-btn">+ Add image</button>
        </div>
      `
      div.querySelector('.gallery-add-btn').addEventListener('click', () => {
        openAssetPicker(asset => {
          pushUndo()
          const newId = `${block.id}${String.fromCharCode(97 + (block.content.items?.length || 0))}`
          block.content.items = [...(block.content.items || []), { id: newId, asset: asset.id }]
          activateBlock(index)
        })
      })
      div.querySelectorAll('.gallery-item-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          pushUndo()
          block.content.items.splice(parseInt(btn.dataset.i), 1)
          activateBlock(index)
        })
      })
      div.querySelectorAll('.gallery-caption').forEach((inp, i) => {
        inp.addEventListener('change', () => {
          if (block.content.items[i]) block.content.items[i].caption = [{ text: inp.value }]
        })
      })
      break
    }

    case 'divider':
      div.innerHTML = '<hr class="preview-divider">'
      break

    case 'file': {
      div.innerHTML = `
        <div class="file-editor">
          <div class="form-field">
            <label>File: <span class="muted">${block.content.asset || 'none'}</span></label>
            <button class="btn btn-ghost asset-pick-btn">Choose file</button>
          </div>
          <div class="form-field">
            <label>Label</label>
            <input type="text" class="label-input" value="${escAttr(spansToPlain(block.content.label))}">
          </div>
          <div class="form-field">
            <label>Note (optional)</label>
            <input type="text" class="desc-input" value="${escAttr(spansToPlain(block.content.description))}">
          </div>
        </div>
      `
      div.querySelector('.asset-pick-btn').addEventListener('click', () => {
        openAssetPicker(asset => { pushUndo(); block.content.asset = asset.id; activateBlock(index) })
      })
      div.querySelector('.label-input').addEventListener('change', e => {
        block.content.label = [{ text: e.target.value }]
      })
      div.querySelector('.desc-input').addEventListener('change', e => {
        block.content.description = e.target.value ? [{ text: e.target.value }] : undefined
      })
      break
    }

    case 'resource-list': {
      const items = block.content.items || []
      div.innerHTML = `
        <div class="resource-list-editor">
          ${items.map((item, i) => `
            <div class="resource-item-row" data-i="${i}">
              <span class="muted">${item.asset || 'no asset'}</span>
              <input type="text" class="item-label" placeholder="Label" value="${escAttr(spansToPlain(item.label))}">
              <button class="btn-icon item-remove" data-i="${i}">✕</button>
            </div>
          `).join('')}
          <button class="btn btn-ghost add-file-btn">+ Add file</button>
        </div>
      `
      div.querySelector('.add-file-btn').addEventListener('click', () => {
        openAssetPicker(asset => {
          pushUndo()
          const newId = `${block.id}${String.fromCharCode(97 + (block.content.items?.length || 0))}`
          block.content.items = [...(block.content.items || []), { id: newId, asset: asset.id, label: [{ text: '' }] }]
          activateBlock(index)
        })
      })
      div.querySelectorAll('.item-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          pushUndo(); block.content.items.splice(parseInt(btn.dataset.i), 1); activateBlock(index)
        })
      })
      div.querySelectorAll('.item-label').forEach((inp, i) => {
        inp.addEventListener('change', () => {
          if (block.content.items[i]) block.content.items[i].label = [{ text: inp.value }]
        })
      })
      break
    }

    case 'contact-form': {
      const fields = block.content.fields || []
      div.innerHTML = `
        <div class="form-block-editor">
          <p class="muted">Contact form — ${fields.length} field${fields.length !== 1 ? 's' : ''}</p>
          <button class="btn btn-ghost edit-fields-btn">Edit fields</button>
        </div>
      `
      div.querySelector('.edit-fields-btn').addEventListener('click', () => openFormEditor(block, index))
      break
    }
  }

  return div
}

function placeCursorAtEnd(el) {
  const range = document.createRange()
  const sel = window.getSelection()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

// ─── Asset picker ─────────────────────────────────────────────────────────────

let currentAssets = []

function selectAsset(asset) {
  document.getElementById('asset-panel').hidden = true
  if (assetPickerCallback) assetPickerCallback(asset)
  assetPickerCallback = null
}

function switchAssetTab(tab) {
  document.querySelectorAll('.asset-tab').forEach(b => b.classList.toggle('active', b.dataset.assetTab === tab))
  document.getElementById('asset-tab-library').hidden = tab !== 'library'
  document.getElementById('asset-tab-search-panel').hidden = tab !== 'search'
}

async function openAssetPicker(callback) {
  assetPickerCallback = callback
  document.getElementById('asset-panel').hidden = false
  switchAssetTab('library')

  const res = await fetch('/api/assets')
  currentAssets = await res.json()
  renderAssetPanelGrid(currentAssets)
  document.getElementById('asset-search').value = ''

  // Show the "Find a photo" tab only if Unsplash is configured
  try {
    const st = await (await fetch('/api/images/status')).json()
    document.getElementById('asset-tab-search').style.display = st.configured ? '' : 'none'
  } catch { document.getElementById('asset-tab-search').style.display = 'none' }
}

function renderAssetPanelGrid(assets) {
  const grid = document.getElementById('asset-panel-grid')
  grid.innerHTML = ''
  for (const asset of assets) {
    const cell = document.createElement('div')
    cell.className = 'asset-cell asset-cell-selectable'
    const isImage = asset.mime.startsWith('image/')
    cell.innerHTML = isImage
      ? `<img src="${asset.bucket_url}" alt="${asset.filename}" loading="lazy"><span class="asset-filename">${asset.filename}</span>`
      : `<div class="file-icon">📄</div><span class="asset-filename">${asset.filename}</span>`
    cell.addEventListener('click', () => selectAsset(asset))
    grid.appendChild(cell)
  }
}

// Tab switching
document.querySelectorAll('.asset-tab').forEach(btn => {
  btn.addEventListener('click', () => switchAssetTab(btn.dataset.assetTab))
})

// Library filter
document.getElementById('asset-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase()
  renderAssetPanelGrid(currentAssets.filter(a => a.filename.toLowerCase().includes(q)))
})

document.querySelectorAll('.panel-close').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.panel).hidden = true
    assetPickerCallback = null
  })
})

// Asset panel upload
document.getElementById('asset-panel-upload').addEventListener('click', () => {
  document.getElementById('asset-panel-file-input').click()
})

document.getElementById('asset-panel-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]
  if (!file) return
  const form = new FormData(); form.append('file', file)
  const res = await fetch('/api/assets', { method: 'POST', body: form })
  if (res.ok) selectAsset(await res.json())
})

// ─── AI image search (Unsplash) ───────────────────────────────────────────────

async function runImageSearch() {
  const q = document.getElementById('image-search-input').value.trim()
  if (!q) return
  const status = document.getElementById('image-search-status')
  const grid = document.getElementById('image-search-grid')
  status.textContent = 'Searching…'; status.hidden = false
  grid.innerHTML = ''
  try {
    const res = await fetch('/api/images/search?q=' + encodeURIComponent(q))
    if (!res.ok) { status.textContent = 'Search failed. Check your Unsplash key.'; return }
    const { results } = await res.json()
    if (!results.length) { status.textContent = 'No photos found — try different words.'; return }
    status.hidden = true
    renderImageSearchGrid(results)
  } catch {
    status.textContent = 'Search failed.'
  }
}

function renderImageSearchGrid(results) {
  const grid = document.getElementById('image-search-grid')
  grid.innerHTML = ''
  for (const r of results) {
    const cell = document.createElement('div')
    cell.className = 'asset-cell asset-cell-selectable'
    cell.innerHTML = `<img src="${r.thumbUrl}" alt="${escAttr(r.description)}" loading="lazy"><span class="asset-filename">© ${escHtml(r.creditName)}</span>`
    cell.addEventListener('click', async () => {
      const status = document.getElementById('image-search-status')
      status.textContent = 'Adding photo to your media…'; status.hidden = false
      try {
        const res = await fetch('/api/images/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r),
        })
        if (!res.ok) { status.textContent = 'Could not add that photo.'; return }
        selectAsset(await res.json())
      } catch {
        status.textContent = 'Could not add that photo.'
      }
    })
    grid.appendChild(cell)
  }
}

document.getElementById('image-search-btn').addEventListener('click', runImageSearch)
document.getElementById('image-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); runImageSearch() }
})

// ─── Form field editor ────────────────────────────────────────────────────────

function openFormEditor(block, index) {
  // Simple inline field list editing — a future enhancement could use a proper side panel
  const existing = document.getElementById('form-editor-panel')
  if (existing) existing.remove()

  const panel = document.createElement('div')
  panel.id = 'form-editor-panel'
  panel.className = 'form-editor-panel'
  panel.innerHTML = `
    <h3>Contact Form Fields</h3>
    <ul class="form-fields-list">
      ${(block.content.fields || []).map((f, i) => `
        <li>
          <span>${spansToPlain(f.label)}</span>
          <span class="muted">${f.type}</span>
          <button class="btn-icon remove-field" data-i="${i}">✕</button>
        </li>
      `).join('')}
    </ul>
    <button class="btn btn-ghost add-field-btn">+ Add field</button>
    <div class="form-field">
      <label>Submit button text</label>
      <input type="text" class="submit-label-input" value="${escAttr(spansToPlain(block.content.submit_label))}">
    </div>
    <button class="btn btn-primary close-form-editor">Done</button>
  `

  panel.querySelectorAll('.remove-field').forEach(btn => {
    btn.addEventListener('click', () => {
      pushUndo()
      block.content.fields.splice(parseInt(btn.dataset.i), 1)
      openFormEditor(block, index)
    })
  })

  panel.querySelector('.add-field-btn').addEventListener('click', () => {
    const label = prompt('Field label?')
    if (!label) return
    const type = prompt('Field type? (text/email/tel/textarea/select)', 'text')
    if (!type) return
    pushUndo()
    block.content.fields.push({
      id: `field_${label.toLowerCase().replace(/\s+/g, '_')}`,
      type,
      label: [{ text: label }],
      required: false,
    })
    openFormEditor(block, index)
  })

  panel.querySelector('.submit-label-input').addEventListener('change', e => {
    block.content.submit_label = [{ text: e.target.value }]
  })

  panel.querySelector('.close-form-editor').addEventListener('click', () => {
    panel.remove()
    renderBlocks()
  })

  document.querySelector('.editor-main').appendChild(panel)
}

// ─── Version history ──────────────────────────────────────────────────────────

document.getElementById('history-btn').addEventListener('click', async () => {
  const panel = document.getElementById('history-panel')
  panel.hidden = !panel.hidden
  if (!panel.hidden) loadVersions()
})

async function loadVersions() {
  const res = await api('GET', `/pages/${pageId}/versions`)
  const versions = await res.json()
  const list = document.getElementById('version-list')
  list.innerHTML = ''
  for (const v of versions) {
    const li = document.createElement('li')
    li.className = 'version-row'
    const date = new Date(v.created_at)
    const dateStr = date.toLocaleDateString() === new Date().toLocaleDateString()
      ? `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : date.toLocaleDateString()
    li.innerHTML = `
      <span class="version-date">${dateStr}</span>
      <span class="version-desc">${v.description}</span>
      <button class="btn btn-ghost btn-sm restore-btn" data-vid="${v.id}">↩</button>
    `
    list.appendChild(li)
  }

  list.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Restore this version? The current state will be saved first.')) return
      const res = await api('POST', `/pages/${pageId}/versions/${btn.dataset.vid}/restore`)
      if (res.ok) {
        const { rendered_html } = await res.json()
        currentHtml = rendered_html || ''
        document.getElementById('history-panel').hidden = true
        showSaveStatus('Restored.')
      }
    })
  })
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function save() {
  const btn = document.getElementById('save-btn')
  btn.disabled = true
  btn.textContent = 'Saving...'
  document.getElementById('save-overlay').hidden = false

  try {
    // Sync page title and purpose
    const titleEl = document.getElementById('page-title-display')
    const purposeEl = document.getElementById('page-purpose')
    if (titleEl.textContent) {
      await api('PUT', `/pages/${pageId}`, {
        title: titleEl.textContent,
        purpose: purposeEl.value,
      })
    }

    const res = await api('POST', `/pages/${pageId}/save`, { block_json: blocks })
    if (res.ok) {
      const data = await res.json()
      currentHtml = data.rendered_html || ''
      undoStack = []
      redoStack = []
      updateUndoButtons()
      if (data.rendered_html) {
        showSaveStatus('Saved just now')
      } else {
        showSaveStatus('Content saved but HTML could not be generated. Try saving again.', true)
      }
    } else {
      showSaveStatus('Save failed.', true)
    }
  } finally {
    document.getElementById('save-overlay').hidden = true
    btn.disabled = false
    btn.textContent = 'Save'
  }
}

function showSaveStatus(msg, isError = false) {
  const el = document.getElementById('save-status')
  el.textContent = msg
  el.className = 'save-status' + (isError ? ' save-status-error' : '')
  el.hidden = false
  setTimeout(() => { el.hidden = true }, 4000)
}

document.getElementById('save-btn').addEventListener('click', save)

// ─── Plain-English help ───────────────────────────────────────────────────────

document.getElementById('help-toggle').addEventListener('click', () => {
  const panel = document.getElementById('help-panel')
  panel.hidden = !panel.hidden
  if (!panel.hidden) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => document.getElementById('help-input').focus(), 200)
  }
})

document.getElementById('help-submit').addEventListener('click', async () => {
  const complaint = document.getElementById('help-input').value.trim()
  if (!complaint) return

  document.getElementById('help-submit').disabled = true
  document.getElementById('help-submit').textContent = 'Working...'

  const res = await api('POST', `/pages/${pageId}/help`, {
    complaint,
    block_json: blocks,
    current_html: currentHtml,
  })

  document.getElementById('help-submit').disabled = false
  document.getElementById('help-submit').textContent = 'Ask for help'

  if (res.ok) {
    const { adjusted_html } = await res.json()
    const result = document.getElementById('help-result')
    result.querySelector('.help-preview').innerHTML = adjusted_html
    result.hidden = false

    document.getElementById('help-apply').onclick = async () => {
      // Persist the adjusted HTML directly — do NOT re-run the semantic pass
      // (that would discard the adjustment).
      const saveRes = await api('POST', `/pages/${pageId}/apply-html`, {
        block_json: blocks,
        rendered_html: adjusted_html,
      })
      if (saveRes.ok) {
        currentHtml = adjusted_html
        document.getElementById('help-panel').hidden = true
        document.getElementById('help-result').hidden = true
        showSaveStatus('Fix applied. Refresh the public page to see it.')
      }
    }

    document.getElementById('help-retry').onclick = () => {
      result.hidden = true
      document.getElementById('help-input').value = ''
      document.getElementById('help-input').focus()
    }
  }
})

// ─── Init ─────────────────────────────────────────────────────────────────────

loadPage()
