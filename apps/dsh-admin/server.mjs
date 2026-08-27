/* global Buffer, URL, URLSearchParams, console, fetch, process */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import httpProxy from 'http-proxy';

const listenHost = process.env.ALLRICE_DSH_ADMIN_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.ALLRICE_DSH_ADMIN_PORT ?? 3081);
const upstreamPort = Number(process.env.ALLRICE_DSH_WEBUI_PORT ?? 3080);
const upstream = `http://127.0.0.1:${upstreamPort}`;
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
const allowedHosts = new Set(
  (
    process.env.ALLRICE_DSH_ADMIN_ALLOWED_HOSTS ??
    'allrice-dsh.bplabs.xyz,allrice-dsh.traditionow.ai,localhost,127.0.0.1'
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
        ? body.replace('</head>', `${trustedAdminMeta}</head>`)
        : `${trustedAdminMeta}${body}`;
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
  if (
    request.method === 'GET' &&
    String(request.headers.accept ?? '').includes('text/html')
  ) {
    void serveTrustedAdminShell(request, response);
    return;
  }
  proxy.web(request, response);
});

server.on('upgrade', (request, socket, head) => {
  if (!allowedHosts.has(normalizedHost(request)) || !authenticated(request)) {
    socket.destroy();
    return;
  }
  proxy.ws(request, socket, head);
});

const dshCommand =
  process.env.ALLRICE_DSH_COMMAND ??
  fileURLToPath(new URL('node_modules/.bin/dsh', import.meta.url));
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
const dsh = spawn(
  dshCommand,
  [
    '--profile',
    'web',
    '--patch',
    platformPatch,
    '--patch',
    runtimePatch,
    '--no-open',
    '--port',
    String(upstreamPort),
    '--trusted-host',
    ...allowedHosts,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DSH_HOME: adminHome,
      DSH_CREDENTIALS_PATH:
        process.env.ALLRICE_DSH_ADMIN_CREDENTIALS_PATH ??
        process.env.DSH_CREDENTIALS_PATH,
    },
  },
);
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
