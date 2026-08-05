import { randomUUID } from 'node:crypto';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const invitationToken = process.env.ALLRICE_SMOKE_INVITATION_TOKEN;
const organizationId = process.env.ALLRICE_SMOKE_ORGANIZATION_ID;
const workspaceId = process.env.ALLRICE_SMOKE_WORKSPACE_ID;
const secondWorkspaceId = process.env.ALLRICE_SMOKE_SECOND_WORKSPACE_ID;
if (
  !baseUrl ||
  !invitationToken ||
  !organizationId ||
  !workspaceId ||
  !secondWorkspaceId
) {
  throw new Error(
    'All identity/workspace smoke environment variables are required',
  );
}

const email = 'phase0-smoke@example.com';
const password = 'allrice-smoke-password';
const inviteeEmail = 'phase0-invitee@example.com';
const inviteePassword = 'allrice-invitee-password';

async function jsonRequest(path, init = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expectedStatus}, got ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

function tenantHeaders(cookie, selectedWorkspaceId = workspaceId) {
  return {
    cookie,
    'x-allrice-organization-id': organizationId,
    'x-allrice-workspace-id': selectedWorkspaceId,
  };
}

function sseEvent(text, eventName) {
  const match = text.match(
    new RegExp(`event: ${eventName}\\ndata: (.+)(?:\\n\\n|$)`),
  );
  if (!match?.[1]) throw new Error(`SSE event ${eventName} missing`);
  return JSON.parse(match[1]);
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

await jsonRequest('/api/v1/auth/session', {
  headers: { cookie: acceptedCookie },
});
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

const loggedIn = await jsonRequest('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const loginCookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
if (!loginCookie) throw new Error('login did not set a session');

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

await jsonRequest(
  '/api/v1/auth/session',
  { headers: tenantHeaders(inviteeCookie, secondWorkspaceId) },
  403,
);

const workspaceResponse = await jsonRequest('/api/v1/workspace', {
  headers: tenantHeaders(inviteeCookie),
});
const workspace = (await workspaceResponse.json()).workspace;
if (
  workspace.workspaceId !== workspaceId ||
  workspace.employee.version.model !== 'allrice/basic-assistant-v1'
) {
  throw new Error('default employee workspace was not provisioned correctly');
}

const sessionResponse = await jsonRequest(
  '/api/v1/sessions',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(inviteeCookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId, title: 'Persistent smoke session' }),
  },
  201,
);
const session = (await sessionResponse.json()).session;
const persistedContent = 'allrice survives database and storage restart';
const attachmentResponse = await jsonRequest(
  `/api/v1/sessions/${session.id}/attachments?workspaceId=${workspaceId}`,
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(inviteeCookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fileName: 'restart-proof.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from(persistedContent).toString('base64'),
    }),
  },
  201,
);
const attachment = (await attachmentResponse.json()).attachment;
const fileId = attachment.id;

await jsonRequest(
  `/api/v1/files/${fileId}/sign`,
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(loginCookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ lifetimeSeconds: 300 }),
  },
  403,
);
const signedResponse = await jsonRequest(`/api/v1/files/${fileId}/sign`, {
  method: 'POST',
  headers: {
    ...tenantHeaders(inviteeCookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ lifetimeSeconds: 300 }),
});
const signed = await signedResponse.json();
const downloaded = await jsonRequest(signed.url);
if ((await downloaded.text()) !== persistedContent) {
  throw new Error('signed download content mismatch');
}
await jsonRequest(`/api/v1/files/${fileId}?token=invalid`, {}, 403);

const clientMessageId = randomUUID();
const sendInit = {
  method: 'POST',
  headers: {
    ...tenantHeaders(inviteeCookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    clientMessageId,
    text: 'Remember that the restart proof is attached.',
    attachmentIds: [fileId],
  }),
};
const firstSend = await jsonRequest(
  `/api/v1/sessions/${session.id}/messages?workspaceId=${workspaceId}`,
  sendInit,
);
const firstEvents = await firstSend.text();
const userMessage = sseEvent(firstEvents, 'message.accepted');
const assistantMessage = sseEvent(firstEvents, 'assistant.completed');
const retrySend = await jsonRequest(
  `/api/v1/sessions/${session.id}/messages?workspaceId=${workspaceId}`,
  sendInit,
);
const retryEvents = await retrySend.text();
if (
  sseEvent(retryEvents, 'message.accepted').id !== userMessage.id ||
  sseEvent(retryEvents, 'assistant.completed').id !== assistantMessage.id
) {
  throw new Error('message retry created duplicate records');
}

await jsonRequest(
  `/api/v1/sessions/${session.id}?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(loginCookie) },
  403,
);
await jsonRequest(`/api/v1/sessions/${session.id}?workspaceId=${workspaceId}`, {
  method: 'PATCH',
  headers: {
    ...tenantHeaders(inviteeCookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ visibility: 'workspace' }),
});
const sharedHistoryResponse = await jsonRequest(
  `/api/v1/sessions/${session.id}?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(loginCookie) },
);
const sharedHistory = (await sharedHistoryResponse.json()).history;
const sharedUserMessageIndex = sharedHistory.messages.findIndex(
  (message) => message.id === userMessage.id,
);
const sharedAssistantMessageIndex = sharedHistory.messages.findIndex(
  (message) => message.id === assistantMessage.id,
);
if (
  sharedUserMessageIndex === -1 ||
  sharedAssistantMessageIndex === -1 ||
  sharedUserMessageIndex >= sharedAssistantMessageIndex
) {
  throw new Error('shared session returned messages out of causal order');
}
if (
  !sharedHistory.messages[sharedUserMessageIndex]?.attachments[0]?.restricted
) {
  throw new Error('shared session exposed another user private attachment');
}

const messageMemoryResponse = await jsonRequest(
  '/api/v1/memories',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(inviteeCookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      content: 'invitee private message memory',
      visibility: 'private',
      sourceType: 'message',
      sourceId: userMessage.id,
    }),
  },
  201,
);
const messageMemory = (await messageMemoryResponse.json()).memory;
const fileMemoryResponse = await jsonRequest(
  '/api/v1/memories',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(inviteeCookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      content: 'restart proof attachment memory',
      visibility: 'private',
      sourceType: 'file',
      sourceId: fileId,
    }),
  },
  201,
);
const fileMemory = (await fileMemoryResponse.json()).memory;

const adminRecallResponse = await jsonRequest('/api/v1/memories/recall', {
  method: 'POST',
  headers: {
    ...tenantHeaders(loginCookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ workspaceId, query: 'private memory', limit: 10 }),
});
if ((await adminRecallResponse.json()).results.length !== 0) {
  throw new Error('admin recall exposed another user private memory');
}
const inviteeRecallResponse = await jsonRequest('/api/v1/memories/recall', {
  method: 'POST',
  headers: {
    ...tenantHeaders(inviteeCookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ workspaceId, query: 'private memory', limit: 10 }),
});
const inviteeRecall = await inviteeRecallResponse.json();
if (!inviteeRecall.results.some((result) => result.id === messageMemory.id)) {
  throw new Error('owner recall did not return private memory');
}

console.info('AllRice identity and employee workspace HTTP smoke passed');
console.info(
  `ALLRICE_SMOKE_STATE=${Buffer.from(
    JSON.stringify({
      signedUrl: signed.url,
      persistedContent,
      organizationId,
      workspaceId,
      inviteeEmail,
      inviteePassword,
      sessionId: session.id,
      userMessageId: userMessage.id,
      fileId,
      messageMemoryId: messageMemory.id,
      fileMemoryId: fileMemory.id,
    }),
  ).toString('base64url')}`,
);
