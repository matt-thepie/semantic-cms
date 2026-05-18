import config from '../config.js'
import fs from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const adapterModule = await import(`../adapters/llm/${config.llm.adapter}.js`)
const adapter = adapterModule.default

function loadPrompt(name) {
  const customPath = path.resolve(`./prompts/${name}.txt`)
  const defaultPath = path.join(__dirname, `../prompts/${name}.txt`)
  return fs.existsSync(customPath)
    ? fs.readFileSync(customPath, 'utf8')
    : fs.readFileSync(defaultPath, 'utf8')
}

function spansToText(spans) {
  if (!spans) return ''
  return spans.map(s => s.text).join('')
}

function buildAssetMapText(assetMap) {
  return Object.entries(assetMap)
    .map(([id, { url, filename }]) => `  ${id}: { url: "${url}", filename: "${filename}" }`)
    .join('\n')
}

const CLASS_VOCABULARY = `
Layout — images:
  flow-left        Figure floated left on desktop, full width on mobile
  flow-right       Figure floated right on desktop, full width on mobile
  flow-full        Full width at all breakpoints
  flow-center      Centred, constrained width, no float

Gallery:
  gallery-grid     Grid layout, column counts from data attributes
  gallery-strip    Horizontal scrolling strip

Downloads:
  download-list    <ul> wrapper for a resource list
  download-item    Individual download link
  download-filename  Filename span inside a download link

Forms:
  contact-form     Form wrapper
  form-field       Label + input wrapper
  form-submit      Submit button

Structure:
  page-section     Logical subdivision within a page, used on <section> elements
`.trim()

const BREAKPOINTS = 'mobile: <640px, tablet: 640px–1024px, desktop: >1024px'

function buildSiteContext({ siteSettings, sitePages, pageSlug }) {
  const ia = siteSettings.site_ia
    ? `\nSITE_INFORMATION_ARCHITECTURE:\n${siteSettings.site_ia}\n`
    : ''

  const pagesList = (sitePages || []).map((p, i) => {
    const marker = p.slug === pageSlug ? ' ← THIS PAGE' : ''
    const purpose = p.purpose ? ` — ${p.purpose}` : ''
    return `  ${i + 1}. ${p.title} (/${p.slug})${purpose}${marker}`
  }).join('\n')

  const pagesBlock = pagesList ? `\nSITE_PAGES (in navigation order):\n${pagesList}\n` : ''

  return `SITE_NAME: ${siteSettings.site_name || ''}
SITE_DESCRIPTION: ${siteSettings.site_description || ''}${ia}${pagesBlock}`
}

export async function semanticPass({ blockJson, pageTitle, pageSlug, pagePurpose, previousHtml, assetMap, siteSettings, sitePages }) {
  const prompt = loadPrompt('semantic')
  const siteContext = buildSiteContext({ siteSettings, sitePages, pageSlug })
  const purposeLine = pagePurpose ? `\nTHIS_PAGE_PURPOSE: ${pagePurpose}` : ''

  const context = `${siteContext}
PAGE_TITLE: ${pageTitle}
PAGE_SLUG: ${pageSlug}${purposeLine}
BREAKPOINTS: ${BREAKPOINTS}
CLASS_VOCABULARY:
${CLASS_VOCABULARY}

ASSET_MAP:
${buildAssetMapText(assetMap)}

PREVIOUS_HTML:
${previousHtml || '(none — first save)'}

BLOCK_JSON:
${JSON.stringify(blockJson, null, 2)}`

  return adapter.complete(prompt, context)
}

export async function helpPass({ complaint, blockJson, currentHtml, pageTitle, pageSlug, pagePurpose, siteSettings, sitePages }) {
  const prompt = loadPrompt('semantic')
  const siteContext = buildSiteContext({ siteSettings, sitePages, pageSlug })
  const purposeLine = pagePurpose ? `\nTHIS_PAGE_PURPOSE: ${pagePurpose}` : ''

  const context = `${siteContext}
PAGE_TITLE: ${pageTitle}
PAGE_SLUG: ${pageSlug}${purposeLine}
BREAKPOINTS: ${BREAKPOINTS}
CLASS_VOCABULARY:
${CLASS_VOCABULARY}

EDITOR COMPLAINT: ${complaint}

CURRENT_HTML:
${currentHtml}

BLOCK_JSON:
${JSON.stringify(blockJson, null, 2)}`

  return adapter.complete(prompt, context)
}

export async function designPass({ brief, currentCss, allPageHtml }) {
  const prompt = `You are a CSS designer for a small personal website. You will receive the current stylesheet, all page HTML fragments it styles, and a plain-English design brief from the site owner.

Your job is to update the stylesheet so it reflects the brief — changing colours, fonts, spacing, layout, or whatever the brief calls for — without breaking any functionality.

RULES
- Return only the complete updated CSS. No explanation, no markdown, no commentary.
- All colours must be CSS custom properties defined in :root. Change the custom property values to achieve colour changes — do not hardcode hex or rgb values elsewhere in the stylesheet.
- Keep the file mobile-first: base styles for mobile, min-width media queries for larger screens.
- Preserve the existing CSS custom property names — you may change their values.
- You may add new custom properties to :root if needed, but keep the set minimal.
- Do not remove any structural class rules (flow-left, gallery-grid, contact-form, etc.) — only change their visual properties if the brief calls for it.
- Dark mode overrides stay in @media (prefers-color-scheme: dark) immediately after :root.`

  const context = `DESIGN BRIEF: ${brief}

CURRENT CSS:
${currentCss}

PAGE HTML (for context — do not change this):
${allPageHtml.map((h, i) => `--- Page ${i + 1} ---\n${h}`).join('\n\n')}`

  return adapter.complete(prompt, context)
}

export async function cssAudit({ currentCss, allPageHtml, colorProperties }) {
  const prompt = loadPrompt('css-audit')
  const htmlFragments = allPageHtml.map((h, i) => `--- Page ${i + 1} ---\n${h}`).join('\n\n')
  const context = `BREAKPOINTS: ${BREAKPOINTS}
CLASS_VOCABULARY:
${CLASS_VOCABULARY}

COLOR_PROPERTIES:
${colorProperties}

CURRENT_CSS:
${currentCss}

ALL_PAGE_HTML:
${htmlFragments}`

  return adapter.complete(prompt, context)
}
