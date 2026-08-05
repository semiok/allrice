const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const encodedState = process.env.ALLRICE_SMOKE_STATE;
if (!baseUrl || !encodedState) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL and ALLRICE_SMOKE_STATE are required',
  );
}

const state = JSON.parse(
  Buffer.from(encodedState, 'base64url').toString('utf8'),
);

async function request(path, init = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expectedStatus}, got ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

const download = await request(state.signedUrl);
if ((await download.text()) !== state.persistedContent) {
  throw new Error('storage content changed after restart');
}

const loggedIn = await request('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: state.inviteeEmail,
    password: state.inviteePassword,
  }),
});
const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('restart login did not set a session');
const headers = {
  cookie,
  'x-allrice-organization-id': state.organizationId,
  'x-allrice-workspace-id': state.workspaceId,
};

const workspace = await request('/api/v1/workspace', { headers });
const workspaceBody = (await workspace.json()).workspace;
if (!workspaceBody.sessions.some((session) => session.id === state.sessionId)) {
  throw new Error('session did not survive database restart');
}
const history = await request(
  `/api/v1/sessions/${state.sessionId}?workspaceId=${state.workspaceId}`,
  { headers },
);
const historyBody = (await history.json()).history;
if (
  !historyBody.messages.some((message) => message.id === state.userMessageId)
) {
  throw new Error('message did not survive database restart');
}

await request(
  `/api/v1/memories/${state.messageMemoryId}?workspaceId=${state.workspaceId}`,
  { method: 'DELETE', headers },
  204,
);
await request(
  `/api/v1/files/${state.fileId}`,
  { method: 'DELETE', headers },
  204,
);
await request(state.signedUrl, {}, 403);

const memoriesResponse = await request(
  `/api/v1/memories?workspaceId=${state.workspaceId}`,
  { headers },
);
const memories = (await memoriesResponse.json()).memories;
if (
  memories.some(
    (memory) =>
      memory.id === state.messageMemoryId || memory.id === state.fileMemoryId,
  )
) {
  throw new Error('memory deletion did not propagate after restart');
}
const recallResponse = await request('/api/v1/memories/recall', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    workspaceId: state.workspaceId,
    query: 'restart proof private memory',
    limit: 20,
  }),
});
const recalled = (await recallResponse.json()).results;
if (
  recalled.some(
    (result) =>
      result.id === state.messageMemoryId || result.id === state.fileMemoryId,
  )
) {
  throw new Error('deleted memory remained in vector recall');
}

console.info(
  'AllRice employee workspace restart and delete propagation smoke passed',
);
