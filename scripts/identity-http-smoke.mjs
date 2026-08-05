import { randomUUID } from 'node:crypto';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const invitationToken = process.env.ALLRICE_SMOKE_INVITATION_TOKEN;
const organizationId = process.env.ALLRICE_SMOKE_ORGANIZATION_ID;
const workspaceId = process.env.ALLRICE_SMOKE_WORKSPACE_ID;
if (!baseUrl || !invitationToken || !organizationId || !workspaceId) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL, invitation token, organization ID and workspace ID are required',
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
const inviteeEmail = 'phase0-invitee@example.com';
const invitationResponse = await jsonRequest(
  '/api/v1/admin/invitations',
  {
    method: 'POST',
    headers: { cookie: loginCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: inviteeEmail,
      workspaceId,
      role: 'member',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  },
  201,
);
const invitation = await invitationResponse.json();
const inviteePassword = 'allrice-invitee-password';
const inviteeAccepted = await jsonRequest(
  '/api/v1/auth/invitations/accept',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: invitation.invitation.token,
      displayName: 'Phase 0 Invitee',
      password: inviteePassword,
    }),
  },
  201,
);
const inviteeCookie = inviteeAccepted.headers.get('set-cookie')?.split(';')[0];
if (!inviteeCookie) throw new Error('invitee acceptance did not set a session');

const tenantHeaders = {
  'x-allrice-organization-id': organizationId,
  'x-allrice-workspace-id': workspaceId,
};
const persistedContent = 'allrice survives database and storage restart';
const uploadResponse = await jsonRequest(
  '/api/v1/files',
  {
    method: 'POST',
    headers: {
      cookie: inviteeCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({
      workspaceId,
      category: 'uploads',
      mediaType: 'text/plain; charset=utf-8',
      contentBase64: Buffer.from(persistedContent).toString('base64'),
      visibility: 'private',
      retentionUntil: null,
      immutable: false,
    }),
  },
  201,
);
const upload = await uploadResponse.json();
const fileId = upload.file.object.id;

await jsonRequest(
  `/api/v1/files/${fileId}/sign`,
  {
    method: 'POST',
    headers: {
      cookie: loginCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({ lifetimeSeconds: 300 }),
  },
  403,
);
const signedResponse = await jsonRequest(
  `/api/v1/files/${fileId}/sign`,
  {
    method: 'POST',
    headers: {
      cookie: inviteeCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({ lifetimeSeconds: 300 }),
  },
  200,
);
const signed = await signedResponse.json();
const downloaded = await jsonRequest(signed.url, {}, 200);
if ((await downloaded.text()) !== persistedContent) {
  throw new Error('signed download content mismatch');
}
await jsonRequest(`/api/v1/files/${fileId}?token=invalid`, {}, 403);

const embedding = Array.from({ length: 1536 }, (_, index) =>
  index === 0 ? 1 : 0,
);
const memoryResponse = await jsonRequest(
  '/api/v1/memories',
  {
    method: 'POST',
    headers: {
      cookie: inviteeCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({
      workspaceId,
      projectId: null,
      content: 'invitee private memory',
      metadata: {},
      visibility: 'private',
      embedding,
    }),
  },
  201,
);
const memory = await memoryResponse.json();
const adminRecallResponse = await jsonRequest(
  '/api/v1/memories/recall',
  {
    method: 'POST',
    headers: {
      cookie: loginCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({ workspaceId, embedding, limit: 10 }),
  },
  200,
);
const adminRecall = await adminRecallResponse.json();
if (adminRecall.results.length !== 0) {
  throw new Error('admin vector recall exposed another user private memory');
}
const inviteeRecallResponse = await jsonRequest(
  '/api/v1/memories/recall',
  {
    method: 'POST',
    headers: {
      cookie: inviteeCookie,
      'content-type': 'application/json',
      ...tenantHeaders,
    },
    body: JSON.stringify({ workspaceId, embedding, limit: 10 }),
  },
  200,
);
const inviteeRecall = await inviteeRecallResponse.json();
if (inviteeRecall.results[0]?.memory_id !== memory.memory.id) {
  throw new Error('owner vector recall did not return private memory');
}

console.info('AllRice identity HTTP smoke passed');
console.info(
  `ALLRICE_SMOKE_STATE=${Buffer.from(
    JSON.stringify({ signedUrl: signed.url, persistedContent }),
  ).toString('base64url')}`,
);
