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

// Strip markdown code fences the model sometimes wraps output in,
// despite being told not to. Handles ```html ... ``` and bare ``` ... ```.
function stripFences(text) {
  if (!text) return text
  let out = text.trim()
  const fence = out.match(/^```(?:html|css)?\s*\n([\s\S]*?)\n```$/)
  if (fence) return fence[1].trim()
  // Also handle a stray leading/trailing fence without the pair matching exactly
  out = out.replace(/^```(?:html|css)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  return out.trim()
}

function spansToText(spans) {
  if (!spans) return ''
  return spans.map(s => s.text).join('')
}

function buildAssetMapText(assetMap) {
  return Object.entries(assetMap)
    .map(([id, { url, filename, credit, creditUrl }]) => {
      const creditPart = credit ? `, credit: "${credit}", creditUrl: "${creditUrl}"` : ''
      return `  ${id}: { url: "${url}", filename: "${filename}"${creditPart} }`
    })
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

export async function semanticPass({ blockJson, pageTitle, pageSlug, pagePurpose, previousHtml, assetMap, siteSettings, sitePages, layoutNotes }) {
  const prompt = loadPrompt('semantic')
  const siteContext = buildSiteContext({ siteSettings, sitePages, pageSlug })
  const purposeLine = pagePurpose ? `\nTHIS_PAGE_PURPOSE: ${pagePurpose}` : ''

  const notes = Array.isArray(layoutNotes) ? layoutNotes.filter(Boolean) : []
  const layoutSection = notes.length
    ? `\nLAYOUT_PREFERENCES (the editor previously asked for these layout changes — you MUST honour them in your output, applying them to the current content):
${notes.map(n => `- ${n}`).join('\n')}\n`
    : ''

  const context = `${siteContext}
PAGE_TITLE: ${pageTitle}
PAGE_SLUG: ${pageSlug}${purposeLine}
BREAKPOINTS: ${BREAKPOINTS}
CLASS_VOCABULARY:
${CLASS_VOCABULARY}
${layoutSection}
ASSET_MAP:
${buildAssetMapText(assetMap)}

PREVIOUS_HTML:
${previousHtml || '(none — first save)'}

BLOCK_JSON:
${JSON.stringify(blockJson, null, 2)}`

  return stripFences(await adapter.complete(prompt, context))
}

export async function helpPass({ complaint, blockJson, currentHtml, pageTitle, pageSlug, pagePurpose, siteSettings, sitePages }) {
  const prompt = `${loadPrompt('semantic')}

---

HELP MODE (you are adjusting an existing page, not rendering from scratch)

The editor is unhappy with how THIS PAGE'S CONTENT looks and has described the problem. Return the adjusted HTML fragment for this page only.

SCOPE — what you CAN change:
- How this page's own content (its headings, paragraphs, images, galleries, lists, forms) is structured and laid out
- Image flow classes, figure wrapping, mobile reordering, grouping into lists/dl, spacing via the existing class vocabulary

SCOPE — what you CANNOT change (these are NOT in this HTML and are controlled elsewhere):
- The site navigation bar / menu, the site header, the site logo, or the site footer
- Colours, fonts, or the overall visual theme (these live in the stylesheet)
- Anything on other pages

If the complaint is entirely about something out of scope (e.g. "centre the navbar", "change the colours", "make the font bigger"), DO NOT alter or delete the content. Return the CURRENT_HTML completely unchanged. It is far better to leave the page exactly as-is than to damage it trying to fulfil an impossible request.

CONTENT PRESERVATION: never delete the page's content. Every block in BLOCK_JSON must still be present in your output. Adjust layout, never remove content.`

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

  return stripFences(await adapter.complete(prompt, context))
}

// Ask the model whether a design brief calls for photographic imagery, and if
// so for 1-2 short stock-photo search queries. Returns [] when no imagery is wanted.
export async function suggestImageQueries(brief) {
  const prompt = `A website owner gave a design brief. If it calls for photographic imagery (a hero image, background photo, banner, etc.), return a JSON array of 1-2 short image search queries (2-4 words each) suitable for a stock photo site. If it does NOT call for imagery, return [].
Return ONLY the JSON array, nothing else.`
  try {
    const out = await adapter.complete(prompt, `BRIEF: ${brief}`)
    const match = out.match(/\[[\s\S]*\]/)
    if (!match) return []
    const arr = JSON.parse(match[0])
    return Array.isArray(arr) ? arr.filter(q => typeof q === 'string' && q.trim()).slice(0, 2) : []
  } catch {
    return []
  }
}

export async function designPass({ brief, currentCss, allPageHtml, imageUrls = [] }) {
  const imageRule = imageUrls.length
    ? '\n- The user wants imagery. Use the provided AVAILABLE_IMAGES as CSS background-image values (e.g. on the header, hero, or body) where the brief calls for it. Use the EXACT URLs given, character for character. Add overlays/gradients as needed for text legibility.'
    : '\n- No images are available for this design. Do NOT use any photographic background images — use colours and gradients only.'

  const prompt = `You are a CSS designer for a small personal website. You will receive the current stylesheet, all page HTML fragments it styles, and a plain-English design brief from the site owner.

Your job is to update the stylesheet so it reflects the brief — changing colours, fonts, spacing, layout, or whatever the brief calls for — without breaking any functionality.

RULES
- Return only the complete updated CSS. No explanation, no markdown, no commentary.
- CRITICAL: The returned stylesheet MUST contain every CSS selector that the current stylesheet contains. You may change property values, add new rules, and adjust layout — but you must NEVER delete an existing selector or rule. Every selector present in CURRENT CSS must still be present in your output. Dropping a rule breaks the live site.
- All colours must be CSS custom properties defined in :root. Change the custom property values to achieve colour changes — do not hardcode hex or rgb values elsewhere in the stylesheet.
- Keep the file mobile-first: base styles for mobile, min-width media queries for larger screens.
- Preserve the existing CSS custom property names — you may change their values.
- You may add new custom properties to :root if needed, but keep the set minimal.
- Structural and component selectors (site-header, site-nav, site-footer, flow-left, flow-right, gallery-grid, contact-form, form-field, image-credit, etc.) must all survive — only change their visual properties if the brief calls for it.
- Dark mode overrides stay in @media (prefers-color-scheme: dark) immediately after :root.
- NEVER invent, guess, or hardcode any external image URL (such as images.unsplash.com/... or any other photo URL). The ONLY image URLs permitted are those listed verbatim in AVAILABLE_IMAGES. Using any other external image URL is forbidden — it has no licence or attribution. If you want imagery but none is provided, use colours/gradients instead.
- Do NOT set, change, or remove the header background photo. The .site-header background-image and the --header-bg-image variable are managed separately by the site owner through a dedicated control — leave them exactly as they are. You may still change the header's background COLOUR, text colour, padding and height.${imageRule}`

  const imagesBlock = imageUrls.length
    ? `\n\nAVAILABLE_IMAGES (royalty-free, already hosted — use these exact URLs):\n${imageUrls.map(u => `- ${u}`).join('\n')}`
    : ''

  const context = `DESIGN BRIEF: ${brief}${imagesBlock}

CURRENT CSS:
${currentCss}

PAGE HTML (for context — do not change this):
${allPageHtml.map((h, i) => `--- Page ${i + 1} ---\n${h}`).join('\n\n')}`

  // Whole-stylesheet output can be large — allow plenty of room so it isn't
  // cut off mid-rule (which would write broken CSS).
  return stripFences(await adapter.complete(prompt, context, { maxTokens: 16000 }))
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

  return stripFences(await adapter.complete(prompt, context, { maxTokens: 16000 }))
}
