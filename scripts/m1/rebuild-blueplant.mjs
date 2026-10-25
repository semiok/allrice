#!/usr/bin/env node
// One-off for the M1 move (MET-216, user decision 2026-10-25): recreate the BluePlant
// company on the M1 Dev through the real admin APIs, carrying over only its departments,
// people (name, job title, responsibilities, department) and their password hashes, and
// assigning the standard AI employees. Chats, runs, files, memories, knowledge, company
// assets, workflows and schedules are deliberately not carried over. Idempotent.
//
// Run it from a checkout of this repository (it is not installed into ~/allrice-dev/bin):
//   node scripts/m1/rebuild-blueplant.mjs --port <webPort> --source-db <db>
//        [--source-host <ssh host>] [--company BluePlant] [--env ~/allrice-dev/.env]
//        [--skip-users admin] [--assign "Office 文档助手"] [--target-db allrice_dev]
//
// The source is read with psql (over ssh when --source-host is given) and is never
// written. Password hashes go from the source psql straight into the target psql and are
// never printed; the script only reports whether each one now matches.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { URLSearchParams } from 'node:url';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, v, i, a) =>
        v.startsWith('--')
          ? [...acc, [v.slice(2), a[i + 1]?.startsWith('--') ? '' : a[i + 1]]]
          : acc,
      [],
    ),
);
const home = os.homedir();
const port = Number(args.port);
const company = args.company ?? 'BluePlant';
const sourceDb = args['source-db'];
const sourceHost = args['source-host'] || null;
const targetDb = args['target-db'] ?? 'allrice_dev';
const skipUsers = new Set(
  (args['skip-users'] ?? 'admin').split(',').filter(Boolean),
);
const extraAssign = (args.assign ?? 'Office 文档助手')
  .split(',')
  .filter(Boolean);
const envPath = args.env ?? `${home}/allrice-dev/.env`;
if (!port || !sourceDb) {
  console.error(
    'usage: rebuild-blueplant.mjs --port <webPort> --source-db <db> [--source-host <ssh host>]',
  );
  process.exit(2);
}
const ADMIN_HOST = 'allrice-admin.bplabs.xyz';
const env = Object.fromEntries(
  fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
    }),
);
let cookie = '';
const step = (s) => console.log(`[blueplant] ${s}`);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: ADMIN_HOST,
          origin: `https://${ADMIN_HOST}`,
          'sec-fetch-site': 'same-origin',
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(data
            ? {
                'content-type': 'application/json',
                'content-length': data.length,
              }
            : {}),
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of res.headers['set-cookie'] ?? []) {
            const jar = new Map(
              cookie
                ? cookie.split('; ').map((x) => x.split(/=(.*)/s).slice(0, 2))
                : [],
            );
            const [k, v] = c.split(';')[0].split(/=(.*)/s);
            jar.set(k, v);
            cookie = [...jar].map(([a, b]) => `${a}=${b}`).join('; ');
          }
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`timeout ${method} ${path}`)),
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function call(method, path, body, ok = [200, 201]) {
  const r = await request(method, path, body);
  if (!ok.includes(r.status))
    throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

// psql against the source (optionally over ssh); returns stdout, never echoes it.
function sourcePsql(sql) {
  const cmd = sourceHost ? 'ssh' : 'psql';
  const argv = sourceHost
    ? [
        sourceHost,
        `PATH=/opt/homebrew/opt/postgresql@17/bin:/usr/local/opt/postgresql@17/bin:$PATH psql -X -At -v ON_ERROR_STOP=1 -d ${sourceDb}`,
      ]
    : ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', sourceDb];
  const r = spawnSync(cmd, argv, {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  });
  if (r.status !== 0)
    throw new Error(`source psql failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}
function targetPsql(sql) {
  const r = spawnSync(
    'psql',
    ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-d', targetDb],
    {
      input: sql,
      encoding: 'utf8',
    },
  );
  if (r.status !== 0)
    throw new Error(`target psql failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

// 1. What BluePlant looks like in the source (no hashes here).
const source = JSON.parse(
  sourcePsql(`select json_build_object(
  'businessContext', o.business_context,
  'departments', (select coalesce(json_agg(json_build_object('name', d.name) order by d.created_at), '[]')
                    from allrice_departments d where d.organization_id = o.id and d.archived_at is null),
  'people', (select coalesce(json_agg(json_build_object(
                'username', u.username, 'displayName', p.display_name, 'jobTitle', p.job_title,
                'responsibilities', p.responsibilities, 'email', u.email, 'status', u.status,
                'department', d.name) order by u.username), '[]')
             from allrice_organization_people p join allrice_users u on u.id = p.user_id
             left join allrice_departments d on d.id = p.department_id
             where p.organization_id = o.id))
from allrice_organizations o where o.name = ${lit(company)} and o.archived_at is null;`).trim(),
);
const people = source.people.filter((p) => !skipUsers.has(p.username));
step(
  `source: ${source.departments.length} departments, ${people.length} people (skipped ${[...skipUsers].join(',')})`,
);

// 2. Admin login.
await call('POST', '/api/v1/auth/login', {
  username: env.ALLRICE_PLATFORM_ADMIN_USER,
  password: env.ALLRICE_PLATFORM_ADMIN_PASSWORD,
});

// 3. Company.
const orgs = await call('GET', '/api/v1/admin/organizations');
let org = (orgs.organizations ?? orgs.items ?? []).find(
  (o) => o.name === company,
);
if (!org) {
  const created = await call('POST', '/api/v1/admin/organizations', {
    name: company,
    businessContext: source.businessContext ?? '',
  });
  org = { id: created.organizationId };
  step(`company created: ${company}`);
} else step(`company exists: ${company}`);
const orgDetail = await call('GET', `/api/v1/admin/organizations/${org.id}`);
const workspaceId =
  orgDetail.organization?.workspaceId ??
  orgDetail.workspaceId ??
  orgDetail.organization?.workspaces?.[0]?.id;
if (!workspaceId)
  throw new Error(
    'no workspace id: ' + JSON.stringify(orgDetail).slice(0, 300),
  );

// 4. Departments by name.
const deptPath = `/api/v1/admin/organizations/${org.id}/departments`;
const listDepartments = async () => {
  const r = await call('GET', deptPath);
  return r.departments ?? r.items ?? [];
};
let departments = await listDepartments();
for (const { name } of source.departments) {
  if (departments.some((d) => d.name === name)) continue;
  await call('POST', deptPath, { name, requestId: crypto.randomUUID() });
  step(`department created: ${name}`);
}
departments = await listDepartments();
const deptId = (name) =>
  name ? (departments.find((d) => d.name === name)?.id ?? null) : null;

// 5. People: created with a throwaway password, replaced by the source hash in step 8.
const peoplePath = `/api/v1/admin/organizations/${org.id}/people`;
const existing = await call('GET', peoplePath);
const have = new Set(
  (existing.people ?? existing.items ?? []).map((p) => p.username),
);
const missing = people.filter((p) => !have.has(p.username));
if (missing.length) {
  await call('POST', peoplePath, {
    people: missing.map((p) => ({
      username: p.username,
      displayName: p.displayName,
      jobTitle: p.jobTitle ?? '',
      responsibilities: p.responsibilities ?? '',
      departmentId: deptId(p.department),
      ...(p.email ? { email: p.email } : {}),
      password: 'Mv-' + crypto.randomBytes(18).toString('base64url'),
    })),
  });
}
// People that already exist (an earlier rehearsal or run) take the source's current
// profile, so a change made on the source after the rehearsal is not lost.
let updated = 0;
for (const current of existing.people ?? existing.items ?? []) {
  const p = people.find((x) => x.username === current.username);
  if (!p) continue;
  const want = {
    displayName: p.displayName,
    jobTitle: p.jobTitle ?? '',
    responsibilities: p.responsibilities ?? '',
    departmentId: deptId(p.department),
  };
  if (
    Object.entries(want).every(([k, v]) => (current[k] ?? null) === (v ?? null))
  )
    continue;
  await call('PATCH', `${peoplePath}/${current.userId}`, {
    username: p.username,
    ...want,
    expectedVersion: current.version,
  });
  updated += 1;
}
step(
  `people: ${missing.length} created, ${updated} updated, ${people.length - missing.length - updated} unchanged`,
);

// 6. Platform employees BluePlant used that this instance does not ship (e.g. the Office
// assistant made on huihuimac for MET-157): recreate them from the source's published
// definition, keeping this instance's model policy, then review and publish them.
const listPlatform = async () => {
  const r = await call('GET', '/api/v1/admin/platform-employees');
  return r.employees ?? r.items ?? [];
};
for (const name of extraAssign) {
  if ((await listPlatform()).some((e) => e.name === name)) continue;
  const row = sourcePsql(
    `select json_build_object('key', e.employee_key, 'definition', r.definition)
     from allrice_platform_employees e join allrice_platform_employee_revisions r on r.id = e.current_published_revision_id
     where e.name = ${lit(name)} and e.status <> 'archived';`,
  ).trim();
  if (!row) {
    step(`source has no published "${name}"; skipped`);
    continue;
  }
  const { key, definition } = JSON.parse(row);
  const created = await call('POST', '/api/v1/admin/platform-employees', {
    key,
    name,
  });
  const id =
    created.employee?.id ?? created.employee?.employee?.id ?? created.id;
  const detail = await call('GET', `/api/v1/admin/platform-employees/${id}`);
  const draft = detail.employee.currentDraft;
  const saved = await call('PUT', `/api/v1/admin/platform-employees/${id}`, {
    definition: { ...definition, modelPolicy: draft.definition.modelPolicy },
    expectedRevisionId: draft.id,
  });
  if (saved.validation && !saved.validation.valid)
    throw new Error(
      `${name} definition invalid here: ${saved.validation.errors.join('; ')}`,
    );
  const check = await call(
    'POST',
    `/api/v1/admin/platform-employees/${id}/review`,
    { scope: 'assigned' },
  );
  if (!check.valid)
    throw new Error(
      `${name} review failed: ${(check.errors ?? []).join('; ')}`,
    );
  const result = await call(
    'POST',
    `/api/v1/admin/platform-employees/${id}/publish`,
    {
      scope: 'assigned',
      expectedRevisionId: check.revisionId,
      expectedPublishedRevisionId: check.publishedRevisionId,
      expectedPackageChecksum: check.packageChecksum,
      policyVersions: check.policyVersions,
    },
  );
  if (!result.valid)
    throw new Error(
      `${name} publish failed: ${(result.errors ?? []).join('; ')}`,
    );
  step(`platform employee recreated and published: ${name}`);
}

// 7. AI employees assigned to everyone in the company, as the admin UI does.
const assignments = `/api/v1/admin/organizations/${org.id}/ai-employees`;
const catalog = await call(
  'GET',
  `${assignments}?${new URLSearchParams({ workspaceId, target: JSON.stringify({ type: 'all' }) })}`,
);
const platform = { employees: await listPlatform() };
const wanted = ['Rice', ...extraAssign];
for (const name of wanted) {
  const def = (platform.employees ?? platform.items ?? []).find(
    (e) => e.name === name,
  );
  const entry =
    def && (catalog.employees ?? []).find((e) => e.employeeId === def.id);
  if (!entry) {
    step(`NOT ASSIGNED (not published on this instance): ${name}`);
    continue;
  }
  if (entry.inheritedByDefault === true) {
    step(`already assigned: ${name}`);
    continue;
  }
  await call('POST', assignments, {
    workspaceId,
    employeeId: entry.employeeId,
    revisionId: entry.revisionId,
    expectedVersion: entry.deployment?.version ?? null,
    action: 'default',
    target: { type: 'all' },
    defaultEnabled: true,
  });
  step(`assigned to everyone: ${name}`);
}

// 8. Password hashes: source -> target, never printed.
const names = people.map((p) => lit(p.username)).join(',');
const updates = sourcePsql(
  `select format('update allrice_users set password_hash = %L, updated_at = now() where username = %L;', password_hash, username)
   from allrice_users where username in (${names}) and password_hash is not null;`,
);
targetPsql(`begin;\n${updates}\ncommit;`);
const digest = (out) =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('|')),
  );
const q = `select username, md5(password_hash) from allrice_users where username in (${names});`;
const src = digest(sourcePsql(q));
const dst = digest(targetPsql(q));
const matched = people.filter(
  (p) => src[p.username] && src[p.username] === dst[p.username],
).length;
step(`password hashes carried over: ${matched}/${people.length}`);
if (matched !== people.length) process.exitCode = 1;

console.log(
  JSON.stringify({
    ok: matched === people.length,
    organizationId: org.id,
    workspaceId,
    people: people.length,
  }),
);
