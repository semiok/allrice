/** Actual browser Host, not a client-controlled forwarding-header whitelist. */
export function sameOriginBrowserWrite(request: Request) {
  const origin = request.headers.get('origin');
  if (
    !origin ||
    origin === 'null' ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return false;
  try {
    const parsed = new URL(origin),
      host = request.headers.get('host') ?? new URL(request.url).host;
    return (
      parsed.origin === origin &&
      parsed.host === host &&
      (parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))
    );
  } catch {
    return false;
  }
}
