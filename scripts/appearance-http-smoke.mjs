// MET-214: real Next first paint. A signed-in employee's saved appearance is
// in the page HTML, ahead of the first visible element; a signed-out page
// only has the default. Compose smoke uses its bootstrap account; another
// deployment's smoke passes a test account's username and password.
const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
if (!baseUrl) throw new Error('ALLRICE_SMOKE_BASE_URL is required');
const account = process.env.ALLRICE_SMOKE_USERNAME
  ? {
      username: process.env.ALLRICE_SMOKE_USERNAME,
      password: process.env.ALLRICE_SMOKE_PASSWORD,
    }
  : { email: 'phase0-smoke@example.com', password: 'allrice-smoke-password' };

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...init,
  });
  if (response.status !== 200)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected 200, got ${response.status}`,
    );
  return response;
}

const login = await request('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(account),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('login did not set a session');
const headers = { cookie, origin: new URL(baseUrl).origin };

async function save(appearance) {
  const response = await request('/api/v1/me/preferences', {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ appearance }),
  });
  const saved = (await response.json()).preferences?.appearance;
  if (saved !== appearance)
    throw new Error(`saved ${saved}, not ${appearance}`);
}

// The scripts in <body> before its first visible element.
async function firstPaint(path, sessionHeaders) {
  const html = await (await request(path, { headers: sessionHeaders })).text();
  const scripts = [];
  let hiddenDepth = 0;
  for (const tag of html
    .slice(html.indexOf('<body'))
    .matchAll(
      /<script\b[^>]*>([\s\S]*?)<\/script>|<(\/?)([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
    )) {
    if (tag[1] !== undefined) {
      if (!hiddenDepth) scripts.push(tag[1]);
    } else if (tag[2]) {
      if (hiddenDepth) hiddenDepth -= 1;
    } else if (tag[3].toLowerCase() !== 'body') {
      // Match attribute names, not prefixes or text inside quoted values.
      const hidden = [
        ...tag[4].matchAll(
          /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
        ),
      ].some((attribute) => attribute[1].toLowerCase() === 'hidden');
      if (!hiddenDepth && !hidden) break;
      // Void elements have no closing tag and must not extend the subtree.
      if (
        !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(
          tag[3],
        )
      )
        hiddenDepth += 1;
    }
  }
  const workspaceScript = /,(\{"choice":[^}]*\})\)$/;
  const workspace = scripts
    .map((script) => script.match(workspaceScript)?.[1])
    .find(Boolean);
  return {
    defaultFirst: /,null\)$/.test(scripts[0] ?? ''),
    workspace: workspace ? JSON.parse(workspace) : null,
    // Login must not carry an employee's choice anywhere in the document.
    hasWorkspaceScript: [
      ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
    ].some((script) => workspaceScript.test(script[1])),
  };
}

const original = (
  await (await request('/api/v1/me/preferences', { headers })).json()
).preferences.appearance;
try {
  for (const appearance of ['dark', 'system', 'light']) {
    await save(appearance);
    const page = await firstPaint('/chatflow', headers);
    if (!page.defaultFirst || page.workspace?.choice !== appearance)
      throw new Error(
        `/chatflow first paint for ${appearance}: ${JSON.stringify(page)}`,
      );
  }
  const signedOut = await firstPaint('/login', {});
  if (!signedOut.defaultFirst || signedOut.hasWorkspaceScript)
    throw new Error(`/login first paint: ${JSON.stringify(signedOut)}`);
} finally {
  await save(original);
}
console.log('Appearance first-paint smoke passed');
