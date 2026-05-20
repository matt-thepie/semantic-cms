// Public site — fetch and inject page content from the API

const slug = window.location.pathname.replace(/^\//, '') || 'home'
let currentPageId = null

async function init() {
  setupNavToggle()
  await loadNav()
  await loadPage(slug)
}

function setupNavToggle() {
  const toggle = document.getElementById('nav-toggle')
  const nav = document.getElementById('site-nav')
  if (!toggle || !nav) return

  toggle.addEventListener('click', e => {
    e.stopPropagation()
    const open = nav.classList.toggle('open')
    toggle.setAttribute('aria-expanded', String(open))
  })

  // Close when a nav link is clicked
  nav.addEventListener('click', e => {
    if (e.target.tagName === 'A') {
      nav.classList.remove('open')
      toggle.setAttribute('aria-expanded', 'false')
    }
  })

  // Close on outside click
  document.addEventListener('click', e => {
    if (nav.classList.contains('open') && !nav.contains(e.target) && !toggle.contains(e.target)) {
      nav.classList.remove('open')
      toggle.setAttribute('aria-expanded', 'false')
    }
  })

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      nav.classList.remove('open')
      toggle.setAttribute('aria-expanded', 'false')
    }
  })
}

function href(p) { return '/' + (p.slug === 'home' ? '' : p.slug) }
function isActive(p) { return slug === p.slug || (slug === 'home' && p.slug === 'home') }

async function loadNav() {
  try {
    const res = await fetch('/api/nav')
    if (!res.ok) return
    const pages = await res.json()
    const nav = document.getElementById('site-nav')

    // Build a two-level tree: top-level pages, each with their children
    const tops = pages.filter(p => !p.parent_id)
    const childrenOf = id => pages.filter(p => p.parent_id === id)

    nav.innerHTML = tops.map(top => {
      const kids = childrenOf(top.id)
      const topLink = `<a href="${href(top)}" class="${isActive(top) ? 'active' : ''}">${top.title}</a>`
      if (!kids.length) return `<div class="nav-item">${topLink}</div>`
      const submenu = kids.map(k =>
        `<a href="${href(k)}" class="nav-child ${isActive(k) ? 'active' : ''}">${k.title}</a>`
      ).join('')
      return `<div class="nav-item has-children">${topLink}<div class="nav-submenu">${submenu}</div></div>`
    }).join('')
  } catch {}
}

async function loadPage(slug) {
  let res
  try {
    res = await fetch(`/api/pages/${slug}`)
  } catch {
    renderError('Could not connect to the server.')
    return
  }

  if (res.status === 401) {
    renderPasswordForm(slug)
    return
  }

  if (res.status === 404) {
    renderNotFound()
    return
  }

  const page = await res.json()
  currentPageId = page.id
  if (adminBarPresent()) updateAdminBarEditLink()
  document.title = page.title + (document.getElementById('site-logo')?.textContent ? ` — ${document.getElementById('site-logo').textContent}` : '')
  document.getElementById('content').innerHTML = page.rendered_html || '<p>This page has no content yet.</p>'

  // Wire up contact forms in the injected HTML
  document.querySelectorAll('.contact-form').forEach(wireContactForm)
}

function renderPasswordForm(slug) {
  const template = document.getElementById('password-form-template')
  const form = template.content.cloneNode(true)
  document.getElementById('content').innerHTML = ''
  document.getElementById('content').appendChild(form)

  document.getElementById('page-unlock-form').addEventListener('submit', async e => {
    e.preventDefault()
    const password = document.getElementById('page-password').value
    const res = await fetch(`/api/pages/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      await loadPage(slug)
    } else {
      const errEl = document.querySelector('.unlock-error')
      errEl.textContent = 'Incorrect password.'
      errEl.hidden = false
    }
  })
}

function renderNotFound() {
  document.title = 'Page not found'
  document.getElementById('content').innerHTML = '<section class="page-section"><h1>Page not found</h1><p>Sorry, this page doesn\'t exist.</p></section>'
}

function renderError(msg) {
  document.getElementById('content').innerHTML = `<section class="page-section"><p>${msg}</p></section>`
}

function wireContactForm(form) {
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(form))
    const submitBtn = form.querySelector('[type="submit"]')
    submitBtn.disabled = true

    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (res.ok) {
      form.innerHTML = '<p class="contact-success">Thank you — your message has been sent.</p>'
    } else {
      submitBtn.disabled = false
      const errP = form.querySelector('.contact-error') || Object.assign(document.createElement('p'), { className: 'contact-error' })
      errP.textContent = 'Something went wrong. Please try again.'
      if (!form.querySelector('.contact-error')) form.appendChild(errP)
    }
  })
}

// Load site name + image credits into header/footer (public-safe endpoint)
async function loadSiteMeta() {
  try {
    const res = await fetch('/api/site-meta')
    if (!res.ok) return
    const meta = await res.json()
    // Apply the chosen nav layout to the document
    document.body.dataset.nav = meta.nav_layout || 'topbar-dropdown'
    const name = meta.site_name || ''
    const logoEl = document.getElementById('site-logo')
    if (logoEl && name) logoEl.textContent = name
    const footerEl = document.getElementById('site-footer-name')
    if (footerEl && name) footerEl.textContent = `© ${new Date().getFullYear()} ${name}`

    // Header background photo — applied here (not via the AI design pass) so it
    // can't be lost when the theme stylesheet is regenerated.
    const header = meta.header_image
    if (header && header.url) {
      document.documentElement.style.setProperty('--header-bg-image', `url("${header.url}")`)
      document.body.dataset.hasHeaderImage = ''
    }

    // Photo attribution (Unsplash requirement) — header photo + any design backgrounds
    const credits = (meta.image_credits || []).slice()
    if (header && header.credit) credits.push({ name: header.credit.replace(/^Photo by | on Unsplash$/g, ''), url: header.creditUrl })
    const creditEl = document.getElementById('site-footer-credits')
    if (credits.length && creditEl) {
      creditEl.innerHTML = 'Photos: ' + credits.map(c =>
        `<a href="${(c.url || 'https://unsplash.com')}?utm_source=semantic_cms&utm_medium=referral" target="_blank" rel="noopener">${c.name}</a>`
      ).join(', ') + ' on <a href="https://unsplash.com?utm_source=semantic_cms&utm_medium=referral" target="_blank" rel="noopener">Unsplash</a>'
    }
  } catch {}
}

// ─── Admin bar (only for signed-in admins) ─────────────────────────────────────
// Bridges the live site and the editor: while signed in, every page shows an
// "Edit this page" toolbar so there's no need to hunt for the separate admin area.

function adminBarPresent() { return !!document.getElementById('admin-bar') }

function updateAdminBarEditLink() {
  const edit = document.getElementById('admin-bar-edit')
  if (edit && currentPageId) edit.href = `/admin/editor.html?id=${encodeURIComponent(currentPageId)}`
}

async function setupAdminBar() {
  let status
  try { status = await (await fetch('/api/auth/status')).json() } catch { return }
  if (!status || !status.authenticated) return

  const bar = document.createElement('div')
  bar.id = 'admin-bar'
  bar.className = 'admin-bar'
  bar.setAttribute('role', 'navigation')
  bar.setAttribute('aria-label', 'Admin toolbar')

  const label = document.createElement('span')
  label.className = 'admin-bar-label'
  label.textContent = status.email ? `Signed in as ${status.email}` : 'Signed in'
  bar.appendChild(label)

  const spacer = document.createElement('span')
  spacer.className = 'admin-bar-spacer'
  bar.appendChild(spacer)

  const edit = document.createElement('a')
  edit.id = 'admin-bar-edit'
  edit.className = 'admin-bar-btn admin-bar-btn-primary'
  edit.href = currentPageId ? `/admin/editor.html?id=${encodeURIComponent(currentPageId)}` : '/admin/'
  edit.textContent = '✎ Edit this page'
  bar.appendChild(edit)

  const dash = document.createElement('a')
  dash.className = 'admin-bar-btn'
  dash.href = '/admin/'
  dash.textContent = 'Dashboard'
  bar.appendChild(dash)

  document.body.appendChild(bar)
  document.body.classList.add('has-admin-bar')
}

loadSiteMeta()
init().then(setupAdminBar)
