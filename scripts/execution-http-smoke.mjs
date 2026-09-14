import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const encodedWorkspaceState = process.env.ALLRICE_SMOKE_STATE;
const encodedExecutionState = process.env.ALLRICE_EXECUTION_SMOKE_STATE;
if (!baseUrl || !encodedWorkspaceState) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL and ALLRICE_SMOKE_STATE are required',
  );
}

const workspaceState = JSON.parse(
  Buffer.from(encodedWorkspaceState, 'base64url').toString('utf8'),
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

const login = await request('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: workspaceState.inviteeEmail,
    password: workspaceState.inviteePassword,
  }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('execution smoke login did not set a session');
const tenantHeaders = {
  cookie,
  origin: new URL(baseUrl).origin,
  'x-allrice-organization-id': workspaceState.organizationId,
  'x-allrice-workspace-id': workspaceState.workspaceId,
};

async function enqueue(input, expectedStatus = 201) {
  const init = {
    method: 'POST',
    headers: { ...tenantHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspaceState.workspaceId, ...input }),
  };
  const response =
    expectedStatus === null
      ? await fetch(`${baseUrl}/api/v1/runs`, init)
      : await request('/api/v1/runs', init, expectedStatus);
  if (expectedStatus === null && ![200, 201].includes(response.status)) {
    throw new Error(
      `POST /api/v1/runs: expected 200/201, got ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()).run;
}

async function getRun(runId) {
  const response = await request(
    `/api/v1/runs/${runId}?workspaceId=${workspaceState.workspaceId}`,
    { headers: tenantHeaders },
  );
  return (await response.json()).run;
}

async function waitFor(runId, statuses, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(runId);
    if (statuses.includes(run.status)) return run;
    await delay(250);
  }
  throw new Error(`run ${runId} did not reach ${statuses.join('/')} in time`);
}

if (encodedExecutionState) {
  const state = JSON.parse(
    Buffer.from(encodedExecutionState, 'base64url').toString('utf8'),
  );
  const recovered = await waitFor(state.crashRunId, ['succeeded'], 30_000);
  if (
    recovered.job.attempt < 2 ||
    recovered.result?.echo !== 'crash-recovered'
  ) {
    throw new Error('expired Worker lease did not recover the interrupted run');
  }
  console.info('AllRice Worker crash recovery smoke passed');
  process.exit(0);
}

const idempotencyKey = `smoke:echo:${randomUUID()}`;
const concurrent = await Promise.all([
  enqueue(
    {
      idempotencyKey,
      type: 'allrice.system.echo',
      input: { value: 'durable-echo' },
    },
    null,
  ),
  enqueue(
    {
      idempotencyKey,
      type: 'allrice.system.echo',
      input: { value: 'durable-echo' },
    },
    null,
  ),
]);
if (concurrent[0].id !== concurrent[1].id) {
  throw new Error('concurrent idempotent submission created duplicate runs');
}
const succeeded = await waitFor(concurrent[0].id, ['succeeded']);
if (succeeded.result?.echo !== 'durable-echo') {
  throw new Error('Worker result was not persisted');
}

const eventsResponse = await request(
  `/api/v1/runs/${succeeded.id}/events?workspaceId=${workspaceState.workspaceId}`,
  { headers: tenantHeaders },
);
const eventsText = await eventsResponse.text();
const eventIds = [...eventsText.matchAll(/^id: (.+)$/gm)].map(
  (match) => match[1],
);
if (eventIds.length < 4 || !eventsText.includes('"type":"run.succeeded"')) {
  throw new Error('terminal RunEvent SSE stream is incomplete');
}
const replayResponse = await request(
  `/api/v1/runs/${succeeded.id}/events?workspaceId=${workspaceState.workspaceId}`,
  { headers: { ...tenantHeaders, 'last-event-id': eventIds[0] } },
);
const replayText = await replayResponse.text();
if (
  replayText.includes(`id: ${eventIds[0]}\n`) ||
  !replayText.includes('run.succeeded')
) {
  throw new Error('Last-Event-ID did not replay only later events');
}
await request(
  `/api/v1/runs/${succeeded.id}/events?workspaceId=${workspaceState.workspaceId}`,
  { headers: { ...tenantHeaders, 'last-event-id': `${randomUUID()}:0` } },
  400,
);

const retryRun = await enqueue({
  idempotencyKey: `smoke:retry:${randomUUID()}`,
  type: 'allrice.system.echo',
  input: { value: 'retried', failUntilAttempt: 1 },
  maxAttempts: 2,
});
const retried = await waitFor(retryRun.id, ['succeeded']);
if (retried.job.attempt !== 2 || retried.result?.echo !== 'retried') {
  throw new Error('retry/backoff did not complete on the second attempt');
}

const cancellation = await enqueue({
  idempotencyKey: `smoke:cancel:${randomUUID()}`,
  type: 'allrice.system.echo',
  input: { value: 'must-not-complete', delayMs: 10_000 },
});
await waitFor(cancellation.id, ['running']);
await request(
  `/api/v1/runs/${cancellation.id}/cancel?workspaceId=${workspaceState.workspaceId}`,
  {
    method: 'POST',
    headers: {
      ...tenantHeaders,
      origin: 'https://untrusted.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'cross_origin_must_not_cancel' }),
  },
  403,
);
await request(
  `/api/v1/runs/${cancellation.id}/cancel?workspaceId=${workspaceState.workspaceId}`,
  {
    method: 'POST',
    headers: { ...tenantHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'smoke_cancel' }),
  },
);
await waitFor(cancellation.id, ['canceled']);

const timeout = await enqueue({
  idempotencyKey: `smoke:timeout:${randomUUID()}`,
  type: 'allrice.system.echo',
  input: { value: 'must-time-out', delayMs: 5_000 },
  timeoutMs: 1_000,
});
const timedOut = await waitFor(timeout.id, ['failed']);
if (timedOut.error?.code !== 'JOB_TIMEOUT') {
  throw new Error('timed out job did not retain structured failure evidence');
}

const crash = await enqueue({
  idempotencyKey: `smoke:crash:${randomUUID()}`,
  type: 'allrice.system.echo',
  input: { value: 'crash-recovered', delayMs: 6_000 },
  maxAttempts: 3,
  timeoutMs: 30_000,
});
await waitFor(crash.id, ['running']);
console.info('AllRice durable Queue/Run/SSE smoke passed');
console.info(
  `ALLRICE_EXECUTION_SMOKE_STATE=${Buffer.from(
    JSON.stringify({ crashRunId: crash.id }),
  ).toString('base64url')}`,
);
