/** Integration tests may use only the dedicated local or CI database pair.
 * This never chooses a database, creates one, or falls back to application env. */
export function assertRuntimeFixtureDatabase(url: URL) {
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.search ||
    url.hash ||
    !(
      (url.port === '5432' &&
        url.username === 'a123' &&
        url.pathname === '/allrice_b2') ||
      (url.port === '54329' &&
        url.username === 'allrice' &&
        url.pathname === '/allrice')
    )
  )
    throw Error('Dedicated local/CI fixture database required');
}
