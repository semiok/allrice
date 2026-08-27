import {
  createSession,
  getDatabase,
  revokeSession,
} from '../packages/database/src/index.ts';

const baseUrl =
  process.env.ALLRICE_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3001';
const platformEmail =
  process.env.ALLRICE_ACCEPTANCE_PLATFORM_EMAIL ?? 'semiokshen@gmail.com';
const sql = getDatabase();
const users = await sql<{ id: string }[]>`
  select id from allrice_users
  where lower(email) = lower(${platformEmail}) and status = 'active'
  limit 1
`;
const user = users[0];
if (!user) {
  await sql.end();
  throw new Error(`platform user ${platformEmail} was not found`);
}
const identitySession = await createSession(user.id);

async function request(path: string, expected: number, authenticated = false) {
  const response = await fetch(new URL(path, baseUrl), {
    cache: 'no-store',
    redirect: 'manual',
    headers: authenticated
      ? { cookie: `allrice_session=${identitySession.token}` }
      : undefined,
  });
  if (response.status !== expected) {
    throw new Error(
      `${path} returned ${response.status}, expected ${expected}: ${await response.text()}`,
    );
  }
  return response;
}

try {
  for (const path of [
    '/chatflow',
    '/chatflow/employees',
    '/chatflow/governance',
    '/chatflow/admin',
  ]) {
    await request(path, 200);
  }
  const legacy = await request('/workspace', 307);
  if (legacy.headers.get('location') !== '/chatflow') {
    throw new Error('legacy workspace did not redirect to ChatFlow');
  }
  await request('/api/v1/admin/model-governance', 401);

  const capabilities = (await (
    await request('/api/v1/saas/capabilities', 200, true)
  ).json()) as {
    capabilities: { roles: string[]; surfaces: string[] };
  };
  for (const surface of ['chatflow', 'tenant_admin', 'platform_admin']) {
    if (!capabilities.capabilities.surfaces.includes(surface)) {
      throw new Error(`platform UI surface ${surface} is missing`);
    }
  }
  const workspace = (await (
    await request('/api/v1/workspace', 200, true)
  ).json()) as {
    workspace: {
      sessionModels: Array<{
        sessionId: string;
        harness: string;
        provider: string;
        model: string;
      }>;
    };
  };
  if (
    workspace.workspace.sessionModels.some(
      (snapshot) => snapshot.harness !== 'dsh',
    )
  ) {
    throw new Error('a public Session runtime was exposed as a peer Harness');
  }
  const serialized = JSON.stringify(workspace);
  for (const privateField of [
    'credentialReference',
    'credential_reference',
    'baseUrl',
    'base_url',
    'accessToken',
    'refreshToken',
  ]) {
    if (serialized.includes(privateField)) {
      throw new Error(`workspace response exposed ${privateField}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      roles: capabilities.capabilities.roles,
      surfaces: capabilities.capabilities.surfaces,
      sessionRuntimeCount: workspace.workspace.sessionModels.length,
      legacyWorkspace: 'redirected',
      publicHarness: 'dsh',
    })}\n`,
  );
} finally {
  await revokeSession(identitySession.token);
  await sql.end();
}
