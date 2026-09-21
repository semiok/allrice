/** Persist only a navigation hint. The workspace response still authorizes it.
 * replaceState preserves Next's state and does not create a browser-back entry
 * for every poll, draft change or task selection. */
export function rememberSessionLocation(sessionId: string | null) {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') === sessionId) return;
    if (sessionId) url.searchParams.set('session', sessionId);
    else url.searchParams.delete('session');
    // An approval anchor belongs to the previous Session, not the next one.
    url.hash = '';
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // Restricted/embedded browsers can reject History writes. Selection must
    // still work; never replay a request to compensate for a navigation failure.
  }
}
