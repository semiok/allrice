import { randomUUID } from 'node:crypto';

import {
  getDatabase,
  listDshRuntimeInventory,
} from '../../../packages/database/src/index.ts';

const baseUrl =
  process.env.ALLRICE_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3001';
const portalHost =
  process.env.ALLRICE_ACCEPTANCE_PORTAL_HOST ?? 'allrice-snow.bplabs.xyz';
const portalUsername = process.env.ALLRICE_SNOW_USER ?? 'snow';
const portalPassword = process.env.ALLRICE_SNOW_PASSWORD;
const portalEmail =
  process.env.ALLRICE_SNOW_BOOTSTRAP_EMAIL ?? 'snow@bootstrap.allrice.local';

if (!portalPassword) {
  throw new Error('ALLRICE_SNOW_PASSWORD is required');
}

const sql = getDatabase();

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(
      `${response.url} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

const loginResponse = await fetch(new URL('/api/v1/auth/login', baseUrl), {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: portalHost },
  body: JSON.stringify({
    username: portalUsername,
    password: portalPassword,
  }),
});
await readJson(loginResponse);
const cookie = loginResponse.headers
  .getSetCookie()
  .map((value) => value.split(';', 1)[0])
  .join('; ');
if (
  !cookie.includes('allrice_session=') ||
  !cookie.includes('allrice_portal_session=')
) {
  throw new Error('portal login did not return both session cookies');
}

const bindingRows = await sql<
  {
    workspace_id: string;
    assignment_id: string;
    employee_version_id: string;
  }[]
>`
  select a.workspace_id, a.id as assignment_id, a.employee_version_id
  from allrice_employee_assignments a
  join allrice_users u on u.id = a.user_id
  join allrice_workspaces w on w.id = a.workspace_id
  join allrice_organizations o on o.id = w.organization_id
  where o.slug = 'snow'
    and lower(u.email) = lower(${portalEmail})
    and a.active
    and a.is_default
  order by a.created_at
  limit 1
`;
const binding = bindingRows[0];
if (!binding) throw new Error('Snow default Rice assignment was not found');

const headers = {
  'content-type': 'application/json',
  host: portalHost,
  cookie,
};

try {
  const created = await readJson<{ session: { id: string } }>(
    await fetch(new URL('/api/v1/sessions', baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: binding.workspace_id,
        employeeAssignmentId: binding.assignment_id,
        employeeVersionId: binding.employee_version_id,
        title: 'MET-90 Runtime Console acceptance',
      }),
    }),
  );
  const submitted = await readJson<{ run: { id: string } }>(
    await fetch(
      new URL(
        `/api/v1/sessions/${created.session.id}/messages?workspaceId=${binding.workspace_id}`,
        baseUrl,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientMessageId: randomUUID(),
          text: '这是 MET-90 Runtime Console 验收，只回复：runtime online。',
          attachmentIds: [],
          deliveryMode: 'auto',
        }),
      },
    ),
  );

  const deadline = Date.now() + 120_000;
  let state = 'queued';
  while (Date.now() < deadline) {
    const rows = await sql<{ state: string }[]>`
      select state from allrice_runs where id = ${submitted.run.id}
    `;
    state = rows[0]?.state ?? 'missing';
    if (
      ['succeeded', 'failed', 'canceled', 'needs_attention'].includes(state)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (state !== 'succeeded') {
    throw new Error(`acceptance run ended as ${state}`);
  }

  const inventoryDeadline = Date.now() + 15_000;
  let runtime:
    Awaited<ReturnType<typeof listDshRuntimeInventory>>[number] | undefined;
  while (Date.now() < inventoryDeadline) {
    const inventory = await listDshRuntimeInventory(100);
    runtime = inventory.find(
      (row) =>
        row.session.id === created.session.id && row.process?.status === 'live',
    );
    if (runtime) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!runtime?.process) {
    throw new Error('the accepted Session has no live DSH worker process');
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      sessionId: created.session.id,
      runId: submitted.run.id,
      processId: runtime.process.id,
      workerId: runtime.process.workerId,
      nativeTools: runtime.process.nativeTools,
    })}\n`,
  );
} finally {
  await fetch(new URL('/api/v1/auth/logout', baseUrl), {
    method: 'POST',
    headers: { host: portalHost, cookie },
  });
  await sql.end();
}
