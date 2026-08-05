import { randomUUID } from 'node:crypto';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const invitationToken = process.env.ALLRICE_SMOKE_INVITATION_TOKEN;
if (!baseUrl || !invitationToken) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL and ALLRICE_SMOKE_INVITATION_TOKEN are required',
  );
}

const email = 'phase0-smoke@example.com';
const password = 'allrice-smoke-password';

async function jsonRequest(path, init, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expectedStatus}, got ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

const accepted = await jsonRequest(
  '/api/v1/auth/invitations/accept',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: invitationToken,
      displayName: 'Phase 0 Smoke',
      password,
    }),
  },
  201,
);
const acceptedCookie = accepted.headers.get('set-cookie')?.split(';')[0];
if (!acceptedCookie) throw new Error('accept invitation did not set a session');

await jsonRequest(
  '/api/v1/auth/session',
  { headers: { cookie: acceptedCookie } },
  200,
);
await jsonRequest(
  '/api/v1/auth/session',
  {
    headers: {
      cookie: acceptedCookie,
      'x-allrice-organization-id': randomUUID(),
    },
  },
  403,
);
await jsonRequest(
  '/api/v1/auth/logout',
  { method: 'POST', headers: { cookie: acceptedCookie } },
  204,
);
await jsonRequest(
  '/api/v1/auth/session',
  { headers: { cookie: acceptedCookie } },
  401,
);

const loggedIn = await jsonRequest(
  '/api/v1/auth/login',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  },
  200,
);
const loginCookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
if (!loginCookie) throw new Error('login did not set a session');
await jsonRequest(
  '/api/v1/admin/invitations',
  {
    method: 'POST',
    headers: { cookie: loginCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'phase0-invitee@example.com',
      workspaceId: null,
      role: 'viewer',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  },
  201,
);

console.info('AllRice identity HTTP smoke passed');
