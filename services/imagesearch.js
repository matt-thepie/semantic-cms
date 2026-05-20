import config from '../config.js'

const API = 'https://api.unsplash.com'

function authHeaders() {
  if (!config.unsplash.accessKey) {
    throw new Error('Unsplash is not configured. Set UNSPLASH_ACCESS_KEY in your environment.')
  }
  return { Authorization: `Client-ID ${config.unsplash.accessKey}` }
}

export function isConfigured() {
  return !!config.unsplash.accessKey
}

// Search photos. Returns a normalised list the UI/LLM can use.
export async function searchPhotos(query, perPage = 12) {
  const url = `${API}/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&content_filter=high`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Unsplash search failed ${res.status}: ${body}`)
  }
  const data = await res.json()
  return (data.results || []).map(p => ({
    id: p.id,
    description: p.description || p.alt_description || query,
    thumbUrl: p.urls.thumb,
    previewUrl: p.urls.small,
    fullUrl: p.urls.regular,           // ~1080px wide, good for web
    downloadLocation: p.links.download_location,
    creditName: p.user?.name || 'Unknown',
    creditUrl: p.user?.links?.html || 'https://unsplash.com',
  }))
}

// Unsplash API guidelines require triggering this endpoint when a photo is
// actually used (downloaded), for attribution/analytics. Fire-and-forget.
export async function trackDownload(downloadLocation) {
  if (!downloadLocation) return
  try {
    await fetch(downloadLocation, { headers: authHeaders() })
  } catch (err) {
    console.error('Unsplash download tracking failed:', err.message)
  }
}
