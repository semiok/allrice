/* global Buffer, URL, URLSearchParams, console, fetch, process */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import httpProxy from 'http-proxy';

import {
  createNativeCapabilityObserver,
  readAllriceCapabilities,
} from './runtime-capabilities.mjs';
import { spawnDshWebUi } from './dsh-webui-compatibility.mjs';
import {
  createUpstreamAuthentication,
  trustedGatewayOrigin,
} from './dsh-upstream-auth.mjs';

const listenHost = process.env.ALLRICE_DSH_ADMIN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.ALLRICE_DSH_ADMIN_PORT ?? 3081);
const upstreamPort = Number(process.env.ALLRICE_DSH_WEBUI_PORT ?? 3080);
const upstream = `http://127.0.0.1:${upstreamPort}`;
const upstreamAuth = createUpstreamAuthentication(upstream);
const username = process.env.ALLRICE_DSH_ADMIN_USER ?? 'admin';
const password = process.env.ALLRICE_DSH_ADMIN_PASSWORD ?? '';
const configuredSecret = process.env.ALLRICE_DSH_ADMIN_SESSION_SECRET ?? '';
const sessionSecret =
  configuredSecret.length >= 32
    ? configuredSecret
    : randomBytes(32).toString('base64url');
const cookieName = 'allrice_dsh_admin_session';
const secureCookie = process.env.ALLRICE_DSH_ADMIN_SECURE_COOKIE !== '0';
const trustedAdminMeta =
  '<meta name="allrice-dsh-admin" content="authenticated">';
const capabilityCatalog = JSON.parse(
  readFileSync(
    new URL(
      '../../packages/dsh-runtime-diff/capabilities.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const pinnedDsh = JSON.parse(
  readFileSync(
    new URL('./node_modules/@deepseek-ai/dsh/package.json', import.meta.url),
    'utf8',
  ),
);
const nativeCapabilities = createNativeCapabilityObserver({
  version: process.env.ALLRICE_DSH_COMMAND?.trim() ? null : pinnedDsh.version,
  releaseSha: process.env.ALLRICE_RELEASE_SHA ?? null,
});
const capabilityMeta = `<meta name="allrice-dsh-capabilities" content="${encodeURIComponent(JSON.stringify({ ...capabilityCatalog, version: pinnedDsh.version }))}">`;
const allowedHosts = new Set(
  (
    process.env.ALLRICE_DSH_ADMIN_ALLOWED_HOSTS ??
    'dsh.bplabs.xyz,dsh.traditionow.ai,localhost,127.0.0.1'
  )
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

if (!password) {
  console.warn(
    'ALLRICE_DSH_ADMIN_PASSWORD is unset; the DSH administrator gateway will fail closed.',
  );
}
if (configuredSecret.length < 32) {
  console.warn(
    'ALLRICE_DSH_ADMIN_SESSION_SECRET is unset or short; sessions will reset when the gateway restarts.',
  );
}

function normalizedHost(request) {
  const value = String(request.headers.host ?? '').toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.split(':')[0] ?? '';
}

function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(payload) {
  return createHmac('sha256', sessionSecret)
    .update(payload, 'utf8')
    .digest('base64url');
}

function createSessionCookie() {
  const payload = Buffer.from(
    JSON.stringify({
      sub: username,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      nonce: randomBytes(12).toString('base64url'),
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return separator < 0
          ? [part, '']
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
}

function authenticated(request) {
  const value = parseCookies(request)[cookieName];
  if (!value) return false;
  const [payload, supplied, extra] = value.split('.');
  if (
    !payload ||
    !supplied ||
    extra ||
    !safeEqual(supplied, signature(payload))
  ) {
    return false;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    return (
      decoded.sub === username &&
      typeof decoded.exp === 'number' &&
      decoded.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

function cookie(value, maxAge = 7 * 24 * 60 * 60) {
  return [
    `${cookieName}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secureCookie ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function securityHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra,
  };
}

function loginPage(error = '') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AllRice DSH 管理</title><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;background:#f5f6f3;color:#17251e}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,#e2efe4,transparent 32%),#f6f6f2}
main{width:min(430px,100%);background:#fff;border:1px solid #dbe3da;border-radius:22px;padding:36px;box-shadow:0 24px 70px rgba(31,58,44,.12)}
.mark{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:#173f2c;color:#fff;font-weight:800;margin-bottom:26px}p{color:#6b766f;line-height:1.6}label{display:grid;gap:8px;margin-top:18px;font-size:14px;font-weight:650}input{width:100%;border:1px solid #cbd6cc;border-radius:12px;padding:13px 14px;font:inherit;outline:none}input:focus{border-color:#2d7852;box-shadow:0 0 0 3px #dfeee4}button{width:100%;margin-top:24px;border:0;border-radius:12px;padding:14px;background:#1f6d49;color:#fff;font:inherit;font-weight:750;cursor:pointer}.error{color:#a6382f;background:#fff0ee;padding:10px 12px;border-radius:10px}</style></head>
<body><main><div class="mark">DSH</div><h1>Harness 管理控制台</h1><p>登录后进入 DeepSeek Harness 官方 WebUI，配置和调试平台 Harness。</p>${error ? `<p class="error">${error}</p>` : ''}<form method="post" action="/login"><label>账号<input name="username" value="${username}" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">进入 DSH WebUI</button></form></main></body></html>`;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, securityHeaders(headers));
  response.end(body);
}

function redirect(response, location, sessionCookie) {
  response.writeHead(303, {
    location,
    'cache-control': 'no-store',
    ...(sessionCookie ? { 'set-cookie': sessionCookie } : {}),
  });
  response.end();
}

async function serveTrustedAdminShell(request, response) {
  try {
    const upstreamResponse = await fetch(
      new URL(request.url ?? '/', upstream),
      {
        headers: {
          accept: request.headers.accept ?? 'text/html',
          'accept-language': request.headers['accept-language'] ?? 'zh-CN',
          host: `127.0.0.1:${String(upstreamPort)}`,
          cookie: await upstreamAuth.cookie(),
        },
        redirect: 'manual',
      },
    );
    const contentType =
      upstreamResponse.headers.get('content-type') ??
      'text/html; charset=utf-8';
    let body = await upstreamResponse.text();
    if (contentType.includes('text/html') && !body.includes(trustedAdminMeta)) {
      body = body.includes('</head>')
        ? body.replace('</head>', `${trustedAdminMeta}${capabilityMeta}</head>`)
        : `${trustedAdminMeta}${capabilityMeta}${body}`;
    }
    response.writeHead(upstreamResponse.status, {
      'cache-control': 'no-store',
      'content-type': contentType,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    response.end(body);
  } catch {
    send(response, 502, 'DSH WebUI is starting. Please retry shortly.', {
      'content-type': 'text/plain; charset=utf-8',
    });
  }
}

const proxy = httpProxy.createProxyServer({
  target: upstream,
  changeOrigin: true,
  ws: true,
});

// Never export the gateway's native cookie or use a browser-supplied one.
proxy.on('proxyRes', (response) => {
  delete response.headers['set-cookie'];
});

async function proxyAuthenticated(request, response, head) {
  try {
    const headers = { cookie: await upstreamAuth.cookie(), origin: upstream };
    if (head !== undefined) proxy.ws(request, response, head, { headers });
    else proxy.web(request, response, { headers });
  } catch {
    if (head !== undefined) response.destroy();
    else send(response, 502, 'DSH WebUI is starting. Please retry shortly.');
  }
}

function localizeAuthenticatedRequest(proxyRequest, request) {
  proxyRequest.setHeader('host', `127.0.0.1:${String(upstreamPort)}`);
  if (request.headers.origin) proxyRequest.setHeader('origin', upstream);
  proxyRequest.removeHeader('forwarded');
  proxyRequest.removeHeader('x-forwarded-host');
}

// DSH deliberately keeps credentials, settings, plugins, presets and native
// host actions loopback-only because its standalone WebHost has no login
// boundary. The gateway authenticates first, then presents the accepted HTTP
// and WebSocket request as loopback-same-origin to the pinned WebHost.
// Unauthenticated requests never reach these hooks.
proxy.on('proxyReq', localizeAuthenticatedRequest);
proxy.on('proxyReqWs', localizeAuthenticatedRequest);
proxy.on('error', (_error, _request, response) => {
  if (response && 'writeHead' in response) {
    send(response, 502, 'DSH WebUI is starting. Please retry shortly.', {
      'content-type': 'text/plain; charset=utf-8',
    });
  }
});

const server = createServer((request, response) => {
  if (!allowedHosts.has(normalizedHost(request))) {
    send(response, 421, 'Unknown DSH administrator host', {
      'content-type': 'text/plain; charset=utf-8',
    });
    return;
  }

  const url = new URL(request.url ?? '/', upstream);
  if (url.pathname === '/health/live') {
    send(response, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  if (url.pathname === '/logout') {
    redirect(response, '/login', cookie('', 0));
    return;
  }
  if (url.pathname === '/login' && request.method === 'GET') {
    send(response, 200, loginPage(), {
      'content-type': 'text/html; charset=utf-8',
    });
    return;
  }
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8192) request.destroy();
    });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const valid =
        password.length > 0 &&
        safeEqual(form.get('username') ?? '', username) &&
        safeEqual(form.get('password') ?? '', password);
      if (!valid) {
        send(response, 401, loginPage('账号或密码错误。'), {
          'content-type': 'text/html; charset=utf-8',
        });
        return;
      }
      redirect(response, '/', cookie(createSessionCookie()));
    });
    return;
  }
  if (!authenticated(request)) {
    redirect(response, '/login');
    return;
  }
  if (!trustedGatewayOrigin(request, secureCookie)) {
    send(response, 403, 'Untrusted administrator origin');
    return;
  }
  if (url.pathname === '/api/allrice/capabilities') {
    if (request.method !== 'GET') {
      send(response, 405, 'Method not allowed', { allow: 'GET' });
      return;
    }
    void readAllriceCapabilities().then((allrice) => {
      send(
        response,
        200,
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          native: nativeCapabilities.read(),
          allrice,
        }),
        { 'content-type': 'application/json; charset=utf-8' },
      );
    });
    return;
  }
  if (
    request.method === 'GET' &&
    String(request.headers.accept ?? '').includes('text/html')
  ) {
    void serveTrustedAdminShell(request, response);
    return;
  }
  void proxyAuthenticated(request, response);
});

server.on('upgrade', (request, socket, head) => {
  if (
    !allowedHosts.has(normalizedHost(request)) ||
    !authenticated(request) ||
    !trustedGatewayOrigin(request, secureCookie)
  ) {
    socket.destroy();
    return;
  }
  void proxyAuthenticated(request, socket, head);
});

const platformPatch = fileURLToPath(
  new URL('allrice-platform.patch.yml', import.meta.url),
);
const adminHome =
  process.env.ALLRICE_DSH_ADMIN_HOME ??
  process.env.DSH_HOME ??
  '.local/dsh-admin';
const codexSearchPlugin = fileURLToPath(
  new URL('../../packages/dsh-web-search-codex/index.js', import.meta.url),
);
const runtimeDiffPackage = '@allrice/dsh-runtime-diff';
const runtimeDiffPackageRoot = dirname(
  fileURLToPath(
    new URL('../../packages/dsh-runtime-diff/package.json', import.meta.url),
  ),
);
const runtimeDiffPackageLink = resolve(
  adminHome,
  'node_modules/@allrice/dsh-runtime-diff',
);
mkdirSync(dirname(runtimeDiffPackageLink), { recursive: true, mode: 0o700 });
rmSync(runtimeDiffPackageLink, { force: true, recursive: true });
symlinkSync(runtimeDiffPackageRoot, runtimeDiffPackageLink, 'dir');
const runtimePatch = fileURLToPath(
  new URL(
    'allrice-runtime.patch.yml',
    new URL(`${adminHome.replace(/\/$/, '')}/`, `file://${process.cwd()}/`),
  ),
);
mkdirSync(adminHome, { recursive: true, mode: 0o700 });
writeFileSync(
  runtimePatch,
  [
    '# Generated by AllRice DSH Admin. Do not edit.',
    '- insert:',
    '    - id: allrice-admin-native-auth',
    `      name: ${JSON.stringify(fileURLToPath(new URL('native-auth-bridge.mjs', import.meta.url)))}`,
    '    - id: allrice-runtime-diff',
    `      name: ${JSON.stringify(runtimeDiffPackage)}`,
    '    - id: web-search-codex',
    `      name: ${JSON.stringify(codexSearchPlugin)}`,
    '      config:',
    '        model: gpt-5.6-luna',
    '        timeoutMs: 60000',
    '        maximumResponseBytes: 2000000',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
const dsh = spawnDshWebUi({
  commandOverride: process.env.ALLRICE_DSH_COMMAND,
  platformPatch,
  runtimePatch,
  upstreamPort,
  trustedHosts: [...allowedHosts],
  adminHome,
  credentialsPath:
    process.env.ALLRICE_DSH_ADMIN_CREDENTIALS_PATH ??
    process.env.DSH_CREDENTIALS_PATH,
});
dsh.on('message', (message) => {
  try {
    if (!nativeCapabilities.accept(message)) upstreamAuth.accept(message);
  } catch {
    console.error('Invalid native administrator authentication message');
  }
});
dsh.on('exit', (code, signal) => {
  console.error(
    `DSH WebUI exited (code=${String(code)}, signal=${String(signal)})`,
  );
  server.close();
});
dsh.on('error', (error) => {
  console.error('Unable to start the DSH WebUI', error);
  server.close();
});

server.listen(listenPort, listenHost, () => {
  console.info(
    `AllRice DSH administrator gateway listening on ${listenHost}:${listenPort}`,
  );
});

function shutdown(signal) {
  server.close();
  if (!dsh.killed) dsh.kill(signal);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
