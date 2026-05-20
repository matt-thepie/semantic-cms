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

// Each tab is deep-linkable via the URL hash (e.g. /admin/#appearance), so a
// direct link to any pane can be shared.
const VALID_TABS = ['pages', 'appearance', 'assets', 'settings']

function showTab(target, { updateHash = true } = {}) {
  if (!VALID_TABS.includes(target)) target = 'pages'
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === target))
  document.querySelectorAll('.tab-panel').forEach(p => {
    const on = p.id === 'tab-' + target
    p.classList.toggle('active', on)
    p.hidden = !on
  })
  if (updateHash) location.hash = target
  if (target === 'assets') loadAssets()
  if (target === 'settings') loadSettings()
  if (target === 'appearance') { loadSettings(); loadHeaderPhoto() } // keep nav-layout + header photo in sync
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab))
})

// Respond to back/forward and direct hash links
window.addEventListener('hashchange', () => showTab(location.hash.replace('#', ''), { updateHash: false }))

// On load, honour the hash if present
const initialTab = location.hash.replace('#', '')
if (initialTab) showTab(initialTab, { updateHash: false })

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
  // nav_layout is a set of radio cards, not a single field
  const navLayout = settings.nav_layout || 'topbar-dropdown'
  const radio = document.querySelector(`input[name="nav_layout"][value="${navLayout}"]`)
  if (radio) radio.checked = true
  // site_max_width is also a set of radio cards
  const siteWidth = settings.site_max_width || 'standard'
  const widthRadio = document.querySelector(`input[name="site_max_width"][value="${siteWidth}"]`)
  if (widthRadio) widthRadio.checked = true
  const siteName = settings.site_name || 'Semantic CMS'
  document.getElementById('site-name').textContent = siteName
}

// Menu layout lives in the Appearance tab (outside the settings form), so it
// saves the moment a card is chosen.
document.querySelectorAll('input[name="nav_layout"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const msg = document.getElementById('nav-layout-msg')
    const res = await api('PUT', '/settings', { nav_layout: radio.value })
    if (msg) {
      msg.textContent = res.ok ? 'Menu layout saved — refresh your site to see it.' : 'Could not save. Try again.'
      msg.hidden = false
      setTimeout(() => { msg.hidden = true }, 5000)
    }
  })
})

// Site width — also saves the moment a card is chosen.
document.querySelectorAll('input[name="site_max_width"]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const msg = document.getElementById('site-width-msg')
    const res = await api('PUT', '/settings', { site_max_width: radio.value })
    if (msg) {
      msg.textContent = res.ok ? 'Site width saved — refresh your site to see it.' : 'Could not save. Try again.'
      msg.hidden = false
      setTimeout(() => { msg.hidden = true }, 5000)
    }
  })
})

// ─── Header photo ──────────────────────────────────────────────────────────────

async function loadHeaderPhoto() {
  try {
    const meta = await (await fetch('/api/site-meta')).json()
    const preview = document.getElementById('header-photo-preview')
    const removeBtn = document.getElementById('header-photo-remove-btn')
    if (meta.header_image && meta.header_image.url) {
      preview.className = 'header-photo-preview'
      preview.style.backgroundImage = `url("${meta.header_image.url}")`
      preview.textContent = ''
      removeBtn.hidden = false
    } else {
      preview.className = 'header-photo-preview header-photo-empty'
      preview.style.backgroundImage = ''
      preview.textContent = 'No header photo'
      removeBtn.hidden = true
    }
  } catch {}
}

document.getElementById('header-photo-search-btn').addEventListener('click', () => {
  const panel = document.getElementById('header-photo-search')
  panel.hidden = !panel.hidden
  if (!panel.hidden) document.getElementById('header-photo-query').focus()
})

async function runHeaderPhotoSearch() {
  const q = document.getElementById('header-photo-query').value.trim()
  if (!q) return
  const status = document.getElementById('header-photo-status')
  const grid = document.getElementById('header-photo-results')
  status.textContent = 'Searching…'; status.hidden = false; grid.innerHTML = ''
  const res = await api('GET', '/images/search?q=' + encodeURIComponent(q))
  if (!res.ok) { status.textContent = 'Search needs an Unsplash key (see Settings).'; return }
  const { results } = await res.json()
  if (!results.length) { status.textContent = 'No photos found — try different words.'; return }
  status.hidden = true
  grid.innerHTML = ''
  for (const r of results) {
    const cell = document.createElement('div')
    cell.className = 'asset-cell asset-cell-selectable'
    cell.innerHTML = `<img src="${r.thumbUrl}" alt="" loading="lazy"><span class="asset-filename">© ${r.creditName}</span>`
    cell.addEventListener('click', async () => {
      status.textContent = 'Setting header photo…'; status.hidden = false
      await api('PUT', '/header-image', {
        url: r.fullUrl, creditName: r.creditName, creditUrl: r.creditUrl, downloadLocation: r.downloadLocation,
      })
      document.getElementById('header-photo-search').hidden = true
      document.getElementById('header-photo-query').value = ''
      grid.innerHTML = ''; status.hidden = true
      loadHeaderPhoto()
    })
    grid.appendChild(cell)
  }
}
document.getElementById('header-photo-go').addEventListener('click', runHeaderPhotoSearch)
document.getElementById('header-photo-query').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); runHeaderPhotoSearch() }
})
document.getElementById('header-photo-remove-btn').addEventListener('click', async () => {
  await api('DELETE', '/header-image')
  loadHeaderPhoto()
})

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
