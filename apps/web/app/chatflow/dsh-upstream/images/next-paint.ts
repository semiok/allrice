// DeepSeek DSH nextPaint (MIT); source pinned in upstream.json.
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        setTimeout(resolve, 0)
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        setTimeout(resolve, 0)
      }
      const fallback = setTimeout(finish, 100)
      requestAnimationFrame(finish)
    } else {
      setTimeout(resolve, 0)
    }
  })
}
