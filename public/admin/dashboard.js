// Dashboard logic

async function api(method, path, body) {
  const opts = { method, headers: {} }
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  const res = await fetch('/api' + path, opts)
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorised') }
  return res
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)   return 'just now'
  if (mins < 60)  return `${mins} minute${mins > 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs} hour${hrs > 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  if (days < 7)   return `${days} day${days > 1 ? 's' : ''} ago`
  return new Date(iso).toLocaleDateString()
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => { p.classList.remove('active'); p.hidden = true })
    btn.classList.add('active')
    const panel = document.getElementById('tab-' + target)
    panel.classList.add('active')
    panel.hidden = false
    if (target === 'assets') loadAssets()
    if (target === 'settings') loadSettings()
  })
})

// ─── Logout ───────────────────────────────────────────────────────────────────

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', '/auth/logout')
  window.location.href = '/admin/login'
})

// ─── Pages ───────────────────────────────────────────────────────────────────

async function loadPages() {
  const res = await api('GET', '/pages')
  const pages = await res.json()
  renderPageList(pages)
}

function renderPageList(pages) {
  const list = document.getElementById('page-list')
  list.innerHTML = ''

  const tops = pages.filter(p => !p.parent_id)
  const childrenOf = id => pages.filter(p => p.parent_id === id)
  const hasChildren = id => pages.some(p => p.parent_id === id)

  const parentOptions = (page) => {
    let opts = '<option value="">— Top level —</option>'
    for (const t of tops) {
      if (t.id === page.id) continue
      opts += `<option value="${t.id}"${page.parent_id === t.id ? ' selected' : ''}>${t.title}</option>`
    }
    return opts
  }

  const renderRow = (page, isChild) => {
    const li = document.createElement('li')
    li.className = 'page-row' + (isChild ? ' page-row-child' : '')
    li.draggable = true
    li.dataset.id = page.id
    // A page that already has sub-pages can't itself be nested (two-level cap)
    const canNest = !hasChildren(page.id)
    li.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="page-title">${page.title}${page.protected ? ' 🔒' : ''}</span>
      <span class="page-slug">/${page.slug}</span>
      <label class="page-parent">Under
        <select class="parent-select"${canNest ? '' : ' disabled'}>${parentOptions(page)}</select>
      </label>
      <a href="/admin/editor.html?id=${page.id}" class="btn btn-ghost btn-sm">Edit</a>
    `
    li.querySelector('.parent-select').addEventListener('change', async e => {
      await api('PUT', '/pages/' + page.id, { parent_id: e.target.value || null })
      loadPages()
    })
    list.appendChild(li)
  }

  for (const top of tops) {
    renderRow(top, false)
    for (const child of childrenOf(top.id)) renderRow(child, true)
  }
  initDragReorder(list)
}

function initDragReorder(list) {
  let dragging = null

  list.querySelectorAll('.page-row').forEach(row => {
    row.addEventListener('dragstart', e => { dragging = row; row.classList.add('dragging') })
    row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); saveNavOrder() })
    row.addEventListener('dragover', e => {
      e.preventDefault()
      if (dragging && dragging !== row) {
        const rect = row.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        if (e.clientY < mid) list.insertBefore(dragging, row)
        else list.insertBefore(dragging, row.nextSibling)
      }
    })
  })
}

async function saveNavOrder() {
  const rows = document.querySelectorAll('#page-list .page-row')
  for (let i = 0; i < rows.length; i++) {
    await api('PUT', '/pages/' + rows[i].dataset.id, { nav_order: i + 1 })
  }
}

// ─── New page dialog ──────────────────────────────────────────────────────────

const newPageDialog = document.getElementById('new-page-dialog')
const newTitleInput = document.getElementById('new-title')
const newSlugInput  = document.getElementById('new-slug')

document.getElementById('new-page-btn').addEventListener('click', () => {
  newTitleInput.value = ''
  newSlugInput.value  = ''
  document.getElementById('new-protected').checked = false
  document.getElementById('new-password-field').hidden = true
  newPageDialog.showModal()
})

document.getElementById('new-protected').addEventListener('change', e => {
  document.getElementById('new-password-field').hidden = !e.target.checked
})

newTitleInput.addEventListener('input', () => {
  if (!newSlugInput.dataset.edited) newSlugInput.value = slugify(newTitleInput.value)
})
newSlugInput.addEventListener('input', () => { newSlugInput.dataset.edited = '1' })

document.getElementById('new-page-form').addEventListener('submit', async e => {
  e.preventDefault()
  const title    = newTitleInput.value.trim()
  const slug     = newSlugInput.value.trim()
  const password = document.getElementById('new-protected').checked
    ? document.getElementById('new-password').value : undefined

  const res = await api('POST', '/pages', { title, slug, password })
  if (res.ok) {
    const { id } = await res.json()
    newPageDialog.close()
    window.location.href = `/admin/editor.html?id=${id}`
  }
})

// ─── Assets ───────────────────────────────────────────────────────────────────

async function loadAssets() {
  const res = await api('GET', '/assets')
  const assets = await res.json()
  renderAssetGrid(assets, document.getElementById('asset-grid'))
}

function renderAssetGrid(assets, container) {
  container.innerHTML = ''
  for (const asset of assets) {
    const cell = document.createElement('div')
    cell.className = 'asset-cell'
    const isImage = asset.mime.startsWith('image/')
    cell.innerHTML = `
      ${isImage ? `<img src="${asset.bucket_url}" alt="${asset.filename}" loading="lazy">` : `<div class="file-icon">📄</div>`}
      <span class="asset-filename">${asset.filename}</span>
      ${asset.used_by_pages.length ? '' : `<button class="asset-delete btn-icon" data-id="${asset.id}" title="Delete">✕</button>`}
    `
    container.appendChild(cell)
  }

  container.querySelectorAll('.asset-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this asset?')) return
      await api('DELETE', '/assets/' + btn.dataset.id)
      loadAssets()
    })
  })
}

// Upload handling
const uploadZone = document.getElementById('upload-zone')
const fileInput  = document.getElementById('file-input')

document.getElementById('upload-trigger').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => uploadFiles(fileInput.files))

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over') })
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'))
uploadZone.addEventListener('drop', e => {
  e.preventDefault()
  uploadZone.classList.remove('drag-over')
  uploadFiles(e.dataTransfer.files)
})

async function uploadFiles(files) {
  const progress = document.getElementById('upload-progress')
  for (const file of files) {
    const row = document.createElement('p')
    row.textContent = `Uploading ${file.name}...`
    progress.appendChild(row)

    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/assets', { method: 'POST', body: form })
    row.textContent = res.ok ? `✓ ${file.name}` : `✗ ${file.name} — failed`
  }
  setTimeout(() => { progress.innerHTML = ''; loadAssets() }, 2000)
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const res = await api('GET', '/settings')
  const settings = await res.json()
  for (const [key, val] of Object.entries(settings)) {
    const el = document.getElementById(key)
    if (el && el.type !== 'password') el.value = val
  }
  const siteName = settings.site_name || 'Semantic CMS'
  document.getElementById('site-name').textContent = siteName
}

document.getElementById('settings-form').addEventListener('submit', async e => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(e.target))
  // Strip empty passwords — don't overwrite with empty string
  if (!data.admin_password) delete data.admin_password
  if (!data.smtp_password)  delete data.smtp_password

  const res = await api('PUT', '/settings', data)
  const msg = document.getElementById('settings-msg')
  msg.textContent = res.ok ? 'Settings saved.' : 'Failed to save.'
  msg.hidden = false
  setTimeout(() => { msg.hidden = true }, 3000)
})

document.getElementById('test-smtp-btn').addEventListener('click', async () => {
  const res = await api('POST', '/settings/test-smtp')
  const msg = document.getElementById('settings-msg')
  msg.textContent = res.ok ? 'Test email sent.' : 'Failed to send test email.'
  msg.hidden = false
  setTimeout(() => { msg.hidden = true }, 4000)
})

// ─── Design (streamed progress + preview + confirm) ────────────────────────────

const designOverlay = document.getElementById('design-overlay')

function showDesignState(state) {
  document.getElementById('design-working').hidden = state !== 'working'
  document.getElementById('design-preview').hidden = state !== 'preview'
  document.getElementById('design-error').hidden = state !== 'error'
}

function closeDesignOverlay() {
  designOverlay.hidden = true
}

document.getElementById('design-btn').addEventListener('click', async () => {
  const brief = document.getElementById('design-brief').value.trim()
  if (!brief) return

  showDesignState('working')
  document.getElementById('design-phase').textContent = 'Starting…'
  designOverlay.hidden = false

  let candidateCss = null

  try {
    const res = await fetch('/api/css/design', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief }),
    })
    if (res.status === 401) { window.location.href = '/admin/login'; return }
    if (!res.ok || !res.body) throw new Error('Design request failed')

    // Read the newline-delimited JSON progress stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const evt = JSON.parse(line)
        if (evt.phase) {
          document.getElementById('design-phase').textContent = evt.phase
        } else if (evt.error) {
          throw new Error(evt.error)
        } else if (evt.done) {
          candidateCss = evt.updated_css
        }
      }
    }

    if (!candidateCss) throw new Error('No design was produced')

    // Show a live preview of the home page with the candidate CSS
    showDesignState('preview')
    const frame = document.getElementById('design-preview-frame')
    frame.onload = () => {
      try {
        const doc = frame.contentDocument
        // Only replace the theme stylesheet; keep nav.css (layout) intact
        doc.querySelectorAll('link[href*="site.css"]').forEach(l => l.remove())
        const style = doc.createElement('style')
        style.textContent = candidateCss
        doc.head.appendChild(style)
      } catch {}
    }
    frame.src = '/?_preview=' + Date.now()

    document.getElementById('design-apply').onclick = async () => {
      await api('PUT', '/css', { css: candidateCss })
      closeDesignOverlay()
      const msg = document.getElementById('design-msg')
      msg.textContent = 'Design applied. Refresh the public site to see it live.'
      msg.hidden = false
      setTimeout(() => { msg.hidden = true }, 6000)
    }
    document.getElementById('design-discard').onclick = closeDesignOverlay

  } catch (err) {
    showDesignState('error')
    document.getElementById('design-error-msg').textContent = err.message || 'Something went wrong. Try again.'
  }
})

document.getElementById('design-error-close').addEventListener('click', closeDesignOverlay)

// ─── Tidy CSS ─────────────────────────────────────────────────────────────────

const tidyCssDialog = document.getElementById('tidy-css-dialog')

document.getElementById('tidy-css-btn').addEventListener('click', () => {
  document.getElementById('tidy-result').hidden = true
  document.getElementById('tidy-progress').hidden = true
  document.getElementById('tidy-actions').hidden = false
  tidyCssDialog.showModal()
})

document.getElementById('tidy-confirm-btn').addEventListener('click', async () => {
  document.getElementById('tidy-actions').hidden = true
  document.getElementById('tidy-progress').hidden = false

  const auditRes = await api('POST', '/css/audit')
  const { refactored_css, summary } = await auditRes.json()

  await api('PUT', '/css', { css: refactored_css })

  document.getElementById('tidy-progress').hidden = true
  const result = document.getElementById('tidy-result')
  result.textContent = `Done. ${summary}`
  result.hidden = false

  const actions = document.getElementById('tidy-actions')
  actions.innerHTML = '<button class="btn btn-primary" onclick="this.closest(\'dialog\').close()">Close</button>'
  actions.hidden = false
})

// ─── Init ─────────────────────────────────────────────────────────────────────

loadPages()
loadSettings()
