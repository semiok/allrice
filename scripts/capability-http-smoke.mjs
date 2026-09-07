import { randomUUID } from 'node:crypto';

const baseUrl = process.env.ALLRICE_SMOKE_BASE_URL;
const stateEncoded = process.env.ALLRICE_SMOKE_STATE;
if (!baseUrl || !stateEncoded) {
  throw new Error(
    'ALLRICE_SMOKE_BASE_URL and ALLRICE_SMOKE_STATE are required',
  );
}

const state = JSON.parse(
  Buffer.from(stateEncoded, 'base64url').toString('utf8'),
);
const { organizationId, workspaceId, secondWorkspaceId } = state;

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
    origin: new URL(baseUrl).origin,
    'x-allrice-organization-id': organizationId,
    'x-allrice-workspace-id': selectedWorkspaceId,
  };
}

async function login(email, password) {
  const response = await jsonRequest('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const body = await response.json();
  if (!cookie || !body.user?.id)
    throw new Error('capability smoke login failed');
  return { cookie, userId: body.user.id };
}

const admin = await login('phase0-smoke@example.com', 'allrice-smoke-password');
const member = await login(
  'phase0-invitee@example.com',
  'allrice-invitee-password',
);

const employeeResponse = await jsonRequest(
  `/api/v1/employees?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(admin.cookie) },
);
const employeeHub = (await employeeResponse.json()).employeeHub;
const rice = employeeHub.directory.find(
  (employee) => employee.employeeKey === 'default-assistant',
);
if (!rice) throw new Error('Rice is missing from the admin directory');

const workflowResponse = await jsonRequest(
  '/api/v1/admin/capabilities',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'workflow',
      workspaceId,
      slug: 'met68-smoke-workflow',
      name: 'MET-68 验收工作流',
      description: '验证独立 Workflow revision 与员工绑定。',
      definition: {
        schemaVersion: 1,
        steps: [
          { key: 'research', name: '研究', kind: 'knowledge' },
          {
            key: 'approve',
            name: '确认',
            kind: 'approval',
            dependsOn: ['research'],
          },
        ],
      },
    }),
  },
  201,
);
const workflowRevision = (await workflowResponse.json()).revision;

async function createKnowledge({ slug, name, principalId }) {
  const response = await jsonRequest(
    '/api/v1/admin/capabilities',
    {
      method: 'POST',
      headers: {
        ...tenantHeaders(admin.cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'knowledge',
        workspaceId,
        slug,
        name,
        description: '验证 Knowledge revision、ACL 与员工绑定。',
        definition: {
          schemaVersion: 1,
          sourceKind: 'workspace_files',
          resourceRef: `workspace://files/${slug}`,
          allowedScopes: ['workspace', 'employee', 'user'],
        },
        acl: [
          {
            principalType: principalId === workspaceId ? 'workspace' : 'user',
            principalId,
            permission: 'read',
          },
        ],
      }),
    },
    201,
  );
  return (await response.json()).revision;
}

const workspaceKnowledge = await createKnowledge({
  slug: 'met68-workspace-knowledge',
  name: 'MET-68 工作区知识',
  principalId: workspaceId,
});
const adminOnlyKnowledge = await createKnowledge({
  slug: 'met68-admin-knowledge',
  name: 'MET-68 管理员私有知识',
  principalId: admin.userId,
});

const catalogResponse = await jsonRequest(
  `/api/v1/admin/capabilities?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(admin.cookie) },
);
const catalog = (await catalogResponse.json()).catalog;
if (
  !catalog.workflows.some((item) => item.id === workflowRevision.id) ||
  !catalog.knowledge.some((item) => item.id === workspaceKnowledge.id) ||
  !catalog.knowledge.some((item) => item.id === adminOnlyKnowledge.id)
) {
  throw new Error('capability catalog omitted a published revision');
}

await jsonRequest(`/api/v1/employees/${rice.employeeId}/capabilities`, {
  method: 'PUT',
  headers: {
    ...tenantHeaders(admin.cookie),
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    workspaceId,
    agentSkills: catalog.agentSkills.map((skill) => ({
      installationId: skill.installationId,
      skillVersionId: skill.revision.id,
      grantedCapabilities: skill.grantedCapabilities,
    })),
    workflowRevisionIds: [workflowRevision.id],
    knowledgeRevisionIds: [workspaceKnowledge.id, adminOnlyKnowledge.id],
  }),
});

const directoryResponse = await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(admin.cookie) },
);
const directory = (await directoryResponse.json()).capabilities;
if (directory.workflows.length !== 1 || directory.knowledge.length !== 2) {
  throw new Error('employee capability binding did not persist');
}
await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(member.cookie) },
  403,
);
await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities`,
  {
    method: 'PUT',
    headers: {
      ...tenantHeaders(member.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      agentSkills: [],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
    }),
  },
  403,
);

const foreignWorkflowResponse = await jsonRequest(
  '/api/v1/admin/capabilities',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(admin.cookie, secondWorkspaceId),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'workflow',
      workspaceId: secondWorkspaceId,
      slug: 'met68-foreign-workflow',
      name: 'MET-68 隔离工作流',
      description: '验证跨工作区 revision 不能绑定。',
      definition: {
        schemaVersion: 1,
        steps: [{ key: 'answer', name: '回答', kind: 'model' }],
      },
    }),
  },
  201,
);
const foreignWorkflowRevision = (await foreignWorkflowResponse.json()).revision;
await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities`,
  {
    method: 'PUT',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      agentSkills: catalog.agentSkills.map((skill) => ({
        installationId: skill.installationId,
        skillVersionId: skill.revision.id,
        grantedCapabilities: skill.grantedCapabilities,
      })),
      workflowRevisionIds: [workflowRevision.id, foreignWorkflowRevision.id],
      knowledgeRevisionIds: [workspaceKnowledge.id, adminOnlyKnowledge.id],
    }),
  },
  422,
);

const secondWorkflowResponse = await jsonRequest(
  `/api/v1/admin/capabilities/${workflowRevision.workflowId}/revisions`,
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'workflow',
      workspaceId,
      definition: {
        schemaVersion: 1,
        steps: [
          { key: 'research', name: '研究新版', kind: 'knowledge' },
          {
            key: 'approve',
            name: '确认新版',
            kind: 'approval',
            dependsOn: ['research'],
          },
        ],
      },
    }),
  },
  201,
);
const secondWorkflowRevision = (await secondWorkflowResponse.json()).revision;
if (secondWorkflowRevision.revision !== 2) {
  throw new Error('workflow revision did not advance immutably');
}
await jsonRequest(
  `/api/v1/admin/capabilities/${secondWorkflowRevision.id}/revisions`,
  {
    method: 'PATCH',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      kind: 'workflow',
      status: 'deprecated',
    }),
  },
);
const unchangedDirectory = await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(admin.cookie) },
);
if (
  (await unchangedDirectory.json()).capabilities.workflows[0]?.revision.id !==
  workflowRevision.id
) {
  throw new Error('publishing a revision rewrote an existing employee binding');
}

await jsonRequest(
  `/api/v1/admin/capabilities/${workspaceKnowledge.knowledgeSourceId}`,
  {
    method: 'PATCH',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      kind: 'knowledge',
      status: 'archived',
    }),
  },
);
const archivedDirectory = await jsonRequest(
  `/api/v1/employees/${rice.employeeId}/capabilities?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(admin.cookie) },
);
const archivedKnowledge = (await archivedDirectory.json()).capabilities
  .knowledge;
const archivedBinding = archivedKnowledge.find(
  (item) => item.revision.id === workspaceKnowledge.id,
);
if (
  archivedKnowledge.length !== 2 ||
  archivedBinding?.effective !== false ||
  archivedBinding.disabledReason !== 'revision_unavailable'
) {
  throw new Error('archived Knowledge remained effective');
}
await jsonRequest(
  `/api/v1/admin/capabilities/${workspaceKnowledge.knowledgeSourceId}`,
  {
    method: 'PATCH',
    headers: {
      ...tenantHeaders(admin.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId,
      kind: 'knowledge',
      status: 'active',
    }),
  },
);

const memberEmployeesResponse = await jsonRequest(
  `/api/v1/employees?workspaceId=${workspaceId}`,
  { headers: tenantHeaders(member.cookie) },
);
const memberRice = (
  await memberEmployeesResponse.json()
).employeeHub.assignments.find(
  (employee) => employee.employeeKey === 'default-assistant',
);
if (!memberRice) throw new Error('member Rice assignment is missing');
const sessionResponse = await jsonRequest(
  '/api/v1/sessions',
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(member.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId, title: 'MET-68 snapshot smoke' }),
  },
  201,
);
const session = (await sessionResponse.json()).session;
const messageResponse = await jsonRequest(
  `/api/v1/sessions/${session.id}/messages?workspaceId=${workspaceId}`,
  {
    method: 'POST',
    headers: {
      ...tenantHeaders(member.cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      clientMessageId: randomUUID(),
      text: '验证 MET-68 不可变能力快照。',
      attachmentIds: [],
    }),
  },
  202,
);
const message = await messageResponse.json();
if (!message.run?.id)
  throw new Error('capability snapshot Run was not created');

console.info('AllRice Agent Capability HTTP smoke passed');
console.info(
  `ALLRICE_CAPABILITY_SMOKE_STATE=${Buffer.from(
    JSON.stringify({
      runId: message.run.id,
      memberUserId: member.userId,
      employeeId: memberRice.employeeId,
      workflowRevisionId: workflowRevision.id,
      workspaceKnowledgeRevisionId: workspaceKnowledge.id,
      adminOnlyKnowledgeRevisionId: adminOnlyKnowledge.id,
    }),
  ).toString('base64url')}`,
);
