import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const stateEncoded = process.env.ALLRICE_SMOKE_STATE;
const capabilityStateEncoded = process.env.ALLRICE_CAPABILITY_SMOKE_STATE;
if (!baseUrl || !stateEncoded || !capabilityStateEncoded) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL, ALLRICE_SMOKE_STATE and ALLRICE_CAPABILITY_SMOKE_STATE are required',
  );
}

const state = JSON.parse(
  Buffer.from(stateEncoded, 'base64url').toString('utf8'),
);
const capabilityState = JSON.parse(
  Buffer.from(capabilityStateEncoded, 'base64url').toString('utf8'),
);
const { organizationId, workspaceId, secondWorkspaceId } = state;
const { employeeId, workflowRevisionId } = capabilityState;

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

async function login() {
  const response = await jsonRequest('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'phase0-invitee@example.com',
      password: 'allrice-invitee-password',
    }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('workflow smoke login did not set a session');
  return cookie;
}

async function waitForRun(cookie, runId, expectedStatuses) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await jsonRequest(
      `/api/v1/workflow-runs/${runId}?workspaceId=${workspaceId}`,
      { headers: tenantHeaders(cookie) },
    );
    const run = (await response.json()).workflowRun;
    if (expectedStatuses.includes(run.status)) return run;
    if (['failed', 'canceled', 'needs_attention'].includes(run.status)) {
      throw new Error(`workflow ${runId} stopped unexpectedly: ${run.status}`);
    }
    await delay(250);
  }
  throw new Error(
    `workflow ${runId} did not reach ${expectedStatuses.join(' or ')}`,
  );
}

async function startWorkflow(cookie, label) {
  const response = await jsonRequest(
    '/api/v1/workflow-runs',
    {
      method: 'POST',
      headers: {
        ...tenantHeaders(cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId,
        employeeId,
        workflowRevisionId,
        input: { query: label },
        idempotencyKey: `met73:${label}:${randomUUID()}`,
      }),
    },
    201,
  );
  return (await response.json()).workflowRun;
}

async function decide(cookie, approvalId, decision, reason) {
  return jsonRequest(`/api/v1/workflow-approvals/${approvalId}`, {
    method: 'POST',
    headers: {
      ...tenantHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId, decision, reason }),
  });
}

const cookie = await login();
const started = await startWorkflow(cookie, 'approve-and-resume');
const waiting = await waitForRun(cookie, started.runId, ['waiting_approval']);
const approvalId = waiting.steps.find(
  (step) => step.status === 'waiting_approval',
)?.approvalId;
if (!approvalId) throw new Error('workflow did not persist an Approval');

// No browser connection is kept while approval is pending. The durable API state
// remains authoritative and the queued Worker resumes after this decision.
await decide(cookie, approvalId, 'approved', 'MET-73 smoke approval');
const completed = await waitForRun(cookie, started.runId, ['succeeded']);
if (!completed.steps.every((step) => step.status === 'succeeded')) {
  throw new Error('approved workflow did not complete every step');
}

const rejectedStart = await startWorkflow(cookie, 'reject-and-stop');
const rejectedWaiting = await waitForRun(cookie, rejectedStart.runId, [
  'waiting_approval',
]);
const rejectedApprovalId = rejectedWaiting.steps.find(
  (step) => step.status === 'waiting_approval',
)?.approvalId;
if (!rejectedApprovalId) {
  throw new Error('rejection workflow did not persist an Approval');
}
await decide(cookie, rejectedApprovalId, 'rejected', 'MET-73 smoke rejection');
const rejected = await jsonRequest(
  `/api/v1/workflow-runs/${rejectedStart.runId}?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(cookie) },
);
if ((await rejected.json()).workflowRun.status !== 'failed') {
  throw new Error('rejected workflow did not stop');
}

await jsonRequest(
  `/api/v1/workflow-runs/${started.runId}?workspaceId=${secondWorkspaceId}`,
  { headers: tenantHeaders(cookie, secondWorkspaceId) },
  403,
);

console.info('AllRice durable Workflow HTTP smoke passed');
console.info(
  `ALLRICE_WORKFLOW_SMOKE_STATE=${Buffer.from(
    JSON.stringify({
      runId: started.runId,
      rejectedRunId: rejectedStart.runId,
    }),
  ).toString('base64url')}`,
);
