/** Bounded text preview from the pinned DSH turn navigation source (MIT). */
export function preview(parts: Iterable<string>, limit: number): string {
  let text = ''
  let unread = false
  for (const part of parts) {
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // Per-part bound: this runs on every structural rail update, so one huge
    // text block must not be concatenated (and regex-normalized) whole for a
    // preview this short.
    const clipped = part.length > limit * 2
    const chunk = clipped ? part.slice(0, limit * 2) : part
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}
