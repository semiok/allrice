import {
  createSession,
  getDatabase,
  revokeSession,
} from '../packages/database/src/index.ts';

const baseUrl = process.env.ALLRICE_ACCEPTANCE_BASE_URL;
const platformEmail =
  process.env.ALLRICE_ACCEPTANCE_PLATFORM_EMAIL ?? 'semiokshen@gmail.com';

if (!baseUrl) {
  throw new Error('ALLRICE_ACCEPTANCE_BASE_URL is required');
}

async function request<T>(
  token: string,
  path: string,
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    cache: 'no-store',
    headers: { cookie: `allrice_session=${token}` },
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `${path} returned ${response.status}, expected ${expectedStatus}`,
    );
  }
  return (await response.json()) as T;
}

const sql = getDatabase();
const users = await sql<
  { id: string; email: string; role: 'admin' | 'member' | 'viewer' }[]
>`
  select distinct on (u.id) u.id, u.email, m.role
  from allrice_users u
  join allrice_memberships m on m.user_id = u.id
  where u.status = 'active' and m.active
  order by u.id, case m.role when 'admin' then 0 when 'member' then 1 else 2 end
`;
const platformUser = users.find(
  (user) =>
    user.email.toLocaleLowerCase() === platformEmail.toLocaleLowerCase(),
);
if (!platformUser) throw new Error(`platform user ${platformEmail} not found`);

const tokens: string[] = [];
try {
  const platformSession = await createSession(platformUser.id);
  tokens.push(platformSession.token);
  const platformCapabilities = await request<{
    capabilities: { roles: string[]; surfaces: string[] };
  }>(platformSession.token, '/api/v1/saas/capabilities');
  if (!platformCapabilities.capabilities.roles.includes('platform_admin')) {
    throw new Error('platform admin role is missing from capability manifest');
  }
  const hub = await request<{ employeeHub: { canAdminister: boolean } }>(
    platformSession.token,
    '/api/v1/employees',
  );
  if (!hub.employeeHub.canAdminister) {
    throw new Error('tenant employee administration is unavailable');
  }
  await request(platformSession.token, '/api/v1/admin/model-governance');
  const quality = await request<{
    quality: {
      employees: Array<{
        employeeKey: string;
        suite: { id: string; cases: unknown[] } | null;
      }>;
    };
  }>(platformSession.token, '/api/v1/admin/employee-quality');
  if (quality.quality.employees.length < 3) {
    throw new Error('Rice and two professional employees are required');
  }
  if (
    quality.quality.employees.some(
      (employee) => !employee.suite || employee.suite.cases.length < 7,
    )
  ) {
    throw new Error('every employee must have an independent Eval Suite');
  }
  const providerEvidence = await sql<
    { harness: 'codex' | 'dsh'; provider: string; succeeded: number }[]
  >`
    select harness, provider,
      count(*) filter (where status = 'succeeded')::integer as succeeded
    from allrice_route_decisions
    where created_at >= now() - interval '30 days'
    group by harness, provider
  `;
  const successfulProviders = new Set(
    providerEvidence
      .filter((entry) => entry.succeeded > 0)
      .filter((entry) => entry.harness === 'dsh')
      .map((entry) => entry.provider),
  );
  if (
    process.env.ALLRICE_ACCEPTANCE_REQUIRE_PROVIDER_ROUTES !== '0' &&
    (!successfulProviders.has('openai-codex') ||
      ![...successfulProviders].some((provider) =>
        ['openai-compatible', 'deepseek-official'].includes(provider),
      ))
  ) {
    throw new Error(
      'recent successful DSH evidence for Codex subscription and an API Provider is required',
    );
  }
  process.stdout.write(
    `[MET-62] platform, model governance and ${quality.quality.employees.length} employee Eval Suites passed\n`,
  );

  const nonPlatformUser = users.find(
    (user) =>
      user.email.toLocaleLowerCase() !== platformEmail.toLocaleLowerCase(),
  );
  if (nonPlatformUser) {
    const nonPlatformSession = await createSession(nonPlatformUser.id);
    tokens.push(nonPlatformSession.token);
    const nonPlatformCapabilities = await request<{
      capabilities: { roles: string[]; surfaces: string[] };
    }>(nonPlatformSession.token, '/api/v1/saas/capabilities');
    if (
      nonPlatformCapabilities.capabilities.roles.includes('platform_admin') ||
      nonPlatformCapabilities.capabilities.surfaces.includes('platform_admin')
    ) {
      throw new Error('non-platform user received platform capabilities');
    }
    await request(
      nonPlatformSession.token,
      '/api/v1/admin/model-governance',
      403,
    );
    if (nonPlatformUser.role === 'admin') {
      await request(nonPlatformSession.token, '/api/v1/admin/employee-quality');
    } else {
      await request(
        nonPlatformSession.token,
        '/api/v1/admin/employee-quality',
        403,
      );
    }
    process.stdout.write(
      `[MET-62] ${nonPlatformUser.role}/platform authorization isolation passed\n`,
    );
  } else {
    process.stdout.write(
      '[MET-62] non-platform HTTP isolation skipped: no fixture\n',
    );
  }
} finally {
  await Promise.all(tokens.map((token) => revokeSession(token)));
  await sql.end();
}
