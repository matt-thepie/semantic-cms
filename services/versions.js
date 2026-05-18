export function describeChange(previousBlocks, currentBlocks) {
  if (!previousBlocks || previousBlocks.length === 0) return 'Page created'

  const prev = new Map(previousBlocks.map(b => [b.id, b]))
  const curr = new Map(currentBlocks.map(b => [b.id, b]))

  const added   = currentBlocks.filter(b => !prev.has(b.id))
  const removed = previousBlocks.filter(b => !curr.has(b.id))
  const changed = currentBlocks.filter(b => {
    const p = prev.get(b.id)
    return p && JSON.stringify(p) !== JSON.stringify(b)
  })

  const parts = []
  if (added.length)   parts.push(`${added.length} block${added.length > 1 ? 's' : ''} added`)
  if (removed.length) parts.push(`${removed.length} block${removed.length > 1 ? 's' : ''} removed`)
  if (changed.length) parts.push(`${changed.length} block${changed.length > 1 ? 's' : ''} edited`)

  return parts.length ? parts.join(', ') : 'No changes'
}

export function nextPageId(db) {
  const rows = db.prepare("SELECT id FROM pages WHERE id LIKE 'page_%' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").all()
  if (!rows.length) return 'page_01'
  const last = parseInt(rows[0].id.replace('page_', ''), 10)
  return `page_${String(last + 1).padStart(2, '0')}`
}

export function nextAssetId(db) {
  const rows = db.prepare("SELECT id FROM assets WHERE id LIKE 'asset_%' ORDER BY id DESC LIMIT 1").all()
  if (!rows.length) return 'asset_01'
  const last = parseInt(rows[0].id.replace('asset_', ''), 10)
  return `asset_${String(last + 1).padStart(2, '0')}`
}
