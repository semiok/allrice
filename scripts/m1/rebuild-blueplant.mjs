#!/usr/bin/env node
// One-off for the M1 move (MET-216, user decision 2026-10-25): recreate the BluePlant
// company on the M1 Dev through the real admin APIs, carrying over only its departments,
// its people (name, job title, responsibilities, department, content maintenance level,
// account state) with their password hashes, and its two AI employees. Chats, runs,
// files, memories, knowledge, company assets, workflows and schedules are deliberately
// not carried over. Idempotent: a later run brings the target in line with the source.
//
// Run it from a checkout of this repository (it is not installed into ~/allrice-dev/bin):
//   node scripts/m1/rebuild-blueplant.mjs --port <webPort> --source-host <ssh host> --source-db <db>
//   node scripts/m1/rebuild-blueplant.mjs --port <webPort> --source-local --source-db <db>
//        [--company BluePlant] [--assign "Office 文档助手"] [--skip-users admin]
//        [--target-db allrice_dev] [--env ~/allrice-dev/.env]
//
// The source is only read, in read-only transactions. Password hashes travel as COPY
// data from the source psql to the target psql and are never printed or put into SQL
// text; on failure the script reports the step, not the database's message.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { URLSearchParams } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
  const name = flag.slice(2);
  if (name === 'source-local') args[name] = true;
  else {
    const value = process.argv[++i];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} needs a value`);
    args[name] = value;
  }
}
const home = os.homedir();
const port = Number(args.port);
const company = args.company ?? 'BluePlant';
const sourceDb = args['source-db'];
const sourceHost = args['source-host'] ?? null;
const sourceLocal = args['source-local'] === true;
const targetDb = args['target-db'] ?? 'allrice_dev';
const skipUsers = new Set(
  (args['skip-users'] ?? 'admin').split(',').filter(Boolean),
);
const extraAssign = (args.assign ?? 'Office 文档助手')
  .split(',')
  .filter(Boolean);
const envPath = args.env ?? `${home}/allrice-dev/.env`;
const DB_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
if (!port || !sourceDb || sourceLocal === Boolean(sourceHost)) {
  console.error(
    'usage: rebuild-blueplant.mjs --port <webPort> --source-db <db> (--source-host <ssh host> | --source-local)',
  );
  process.exit(2);
}
if (!DB_NAME.test(sourceDb) || !DB_NAME.test(targetDb))
  throw new Error('invalid database name');
if (sourceHost && !SSH_HOST.test(sourceHost))
  throw new Error('invalid ssh host');

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
const problems = [];

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
// Every page of a list endpoint (`?after=<nextCursor>`).
async function listAll(path, key) {
  const items = [];
  let after;
  do {
    const page = await call(
      'GET',
      after ? `${path}?${new URLSearchParams({ after })}` : path,
    );
    items.push(...(page[key] ?? []));
    after = page.nextCursor ?? undefined;
  } while (after);
  return items;
}

// psql, read-only on the source. `quiet` drops psql's own message from errors (used where
// that message could quote data); the step still fails loudly.
const READ_ONLY = "PGOPTIONS='-c default_transaction_read_only=on'";
function psql(which, sql, { quiet = false } = {}) {
  const base = [
    '-X',
    '-q',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    which === 'source' ? sourceDb : targetDb,
  ];
  const [cmd, argv, extraEnv] =
    which === 'target'
      ? ['psql', ['-h', '127.0.0.1', ...base], {}]
      : sourceHost
        ? [
            'ssh',
            [
              '-o',
              'BatchMode=yes',
              '-o',
              'ConnectTimeout=10',
              '--',
              sourceHost,
              `${READ_ONLY} PATH=/opt/homebrew/opt/postgresql@17/bin:/usr/local/opt/postgresql@17/bin:$PATH psql ${base.join(' ')}`,
            ],
            {},
          ]
        : ['psql', base, { PGOPTIONS: '-c default_transaction_read_only=on' }];
  const r = spawnSync(cmd, argv, {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
    timeout: 120_000,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error)
    throw new Error(
      `${which} psql could not run: ${r.error.code ?? r.error.message}`,
    );
  if (r.status !== 0)
    throw new Error(
      `${which} psql failed (exit ${r.status})${quiet ? '' : `: ${r.stderr.slice(0, 300)}`}`,
    );
  return r.stdout;
}
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const norm = (s) => String(s).trim().toLowerCase();

// 0. Both databases answer, and they are not the same database (a forgotten
// --source-host must not turn into syncing the target with itself).
const IDENT = `select (select system_identifier from pg_control_system())::text || '/' || current_database();`;
if (psql('source', IDENT).trim() === psql('target', IDENT).trim())
  throw new Error('source and target are the same database');

// 1. What BluePlant looks like in the source (no hashes here).
const sourceCompany = psql(
  'source',
  `set standard_conforming_strings = on;
select json_build_object(
  'count', (select count(*) from allrice_organizations where name = ${lit(company)} and archived_at is null),
  'org', (select json_build_object(
    'businessContext', o.business_context,
    'departments', (select coalesce(json_agg(d.name order by d.created_at), '[]')
                      from allrice_departments d where d.organization_id = o.id and d.archived_at is null),
    'people', (select coalesce(json_agg(json_build_object(
        'username', u.username,
        'displayName', coalesce(nullif(p.display_name, ''), u.display_name),
        'jobTitle', p.job_title, 'responsibilities', p.responsibilities,
        'email', u.email, 'contentMaintenanceLevel', p.content_maintenance_level,
        'active', u.status = 'active',
        'member', coalesce((select bool_or(m.active) from allrice_memberships m
                   where m.organization_id = o.id and m.user_id = u.id), false),
        'department', d.name) order by u.username), '[]')
      from allrice_organization_people p join allrice_users u on u.id = p.user_id
      left join allrice_departments d on d.id = p.department_id and d.archived_at is null
      where p.organization_id = o.id))
    from allrice_organizations o where o.name = ${lit(company)} and o.archived_at is null limit 1));`,
).trim();
const sourceSnapshot = JSON.parse(sourceCompany.split('\n').at(-1));
if (sourceSnapshot.count !== 1)
  throw new Error(
    `source has ${sourceSnapshot.count} active companies named ${company}`,
  );
const source = sourceSnapshot.org;
// People whose membership is no longer active have left the company: not carried over.
const departed = source.people
  .filter((p) => !skipUsers.has(p.username) && !p.member)
  .map((p) => p.username);
const people = source.people.filter(
  (p) => !skipUsers.has(p.username) && p.member,
);
if (people.length === 0) throw new Error('source has nobody to carry over');
if (departed.length)
  step(
    `not carried over (membership inactive in the source): ${departed.join(', ')}`,
  );
const placeholderEmail = (e) => !e || /@users\.allrice\.invalid$/i.test(e);
step(
  `source: ${source.departments.length} departments, ${people.length} people (skipped ${[...skipUsers].join(',')})`,
);

// Source AI employees beyond Rice, by key with their published definition.
const sourceEmployees = extraAssign.map((name) => {
  const row = psql(
    'source',
    `select json_build_object('key', e.employee_key, 'definition', r.definition)
     from allrice_platform_employees e join allrice_platform_employee_revisions r on r.id = e.current_published_revision_id
     where e.name = ${lit(name)} and e.status <> 'archived';`,
  ).trim();
  const rows = row ? row.split('\n') : [];
  if (rows.length !== 1)
    throw new Error(
      `source has ${rows.length} published platform employees named ${name}`,
    );
  return { name, ...JSON.parse(rows[0]) };
});

// 2. Admin login.
await call('POST', '/api/v1/auth/login', {
  username: env.ALLRICE_PLATFORM_ADMIN_USER,
  password: env.ALLRICE_PLATFORM_ADMIN_PASSWORD,
});

try {
  // 3. Company: exactly one by name, created when missing; it must be in the target
  //    database, which ties the API instance (--port) to --target-db.
  const matches = (
    await listAll('/api/v1/admin/organizations', 'organizations')
  ).filter((o) => o.name === company);
  if (matches.length > 1)
    throw new Error(`target has ${matches.length} companies named ${company}`);
  let orgId = matches[0]?.id;
  if (!orgId) {
    orgId = (
      await call('POST', '/api/v1/admin/organizations', {
        name: company,
        businessContext: source.businessContext ?? '',
      })
    ).organizationId;
    step(`company created: ${company}`);
  } else step(`company exists: ${company}`);
  if (
    psql(
      'target',
      `select count(*) from allrice_organizations where id = ${lit(orgId)};`,
    ).trim() !== '1'
  )
    throw new Error(`--port ${port} does not serve --target-db ${targetDb}`);
  const { organization } = await call(
    'GET',
    `/api/v1/admin/organizations/${orgId}`,
  );
  const workspaceId = organization.defaultWorkspaceId;
  if (
    !workspaceId ||
    !organization.workspaces.some((w) => w.id === workspaceId)
  )
    throw new Error('company has no usable default workspace');

  // 4. Departments, matched like the database does (trimmed, case-insensitive).
  const deptPath = `/api/v1/admin/organizations/${orgId}/departments`;
  let departments = await listAll(deptPath, 'departments');
  for (const name of source.departments) {
    const same = departments.filter((d) => norm(d.name) === norm(name));
    if (same.some((d) => d.active)) continue;
    if (same.length)
      throw new Error(
        `department "${name}" exists but is inactive; reactivate it first`,
      );
    await call('POST', deptPath, { name, requestId: crypto.randomUUID() });
    step(`department created: ${name}`);
  }
  departments = await listAll(deptPath, 'departments');
  const deptId = (name) => {
    if (!name) return null;
    const d = departments.find((x) => x.active && norm(x.name) === norm(name));
    if (!d) throw new Error(`department "${name}" missing on the target`);
    return d.id;
  };

  // 5. People. Usernames are global: refuse to touch an account of another company.
  const names = people.map((p) => lit(p.username)).join(',');
  const foreign = psql(
    'target',
    `select u.username from allrice_users u where u.username in (${names})
       and not exists (select 1 from allrice_organization_people p where p.user_id = u.id and p.organization_id = ${lit(orgId)});`,
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (foreign.length)
    throw new Error(
      `usernames already used outside ${company}: ${foreign.join(', ')}`,
    );
  const peoplePath = `/api/v1/admin/organizations/${orgId}/people`;
  const profile = (p) => ({
    displayName: p.displayName,
    jobTitle: p.jobTitle ?? '',
    responsibilities: p.responsibilities ?? '',
    departmentId: deptId(p.department),
    ...(p.contentMaintenanceLevel
      ? { contentMaintenanceLevel: p.contentMaintenanceLevel }
      : {}),
  });
  let current = await listAll(peoplePath, 'people');
  const missing = people.filter(
    (p) => !current.some((c) => c.username === p.username),
  );
  for (let i = 0; i < missing.length; i += 100)
    await call('POST', peoplePath, {
      people: missing.slice(i, i + 100).map((p) => ({
        username: p.username,
        ...profile(p),
        ...(placeholderEmail(p.email) ? {} : { email: p.email }),
        password: 'Mv-' + crypto.randomBytes(18).toString('base64url'),
      })),
    });
  // Existing people take the source's current profile, so a change made on the source
  // after the rehearsal is not lost.
  let updated = 0;
  for (const c of current) {
    const p = people.find((x) => x.username === c.username);
    if (!p) continue;
    const want = profile(p);
    if (Object.entries(want).every(([k, v]) => (c[k] ?? null) === (v ?? null)))
      continue;
    await call('PATCH', `${peoplePath}/${c.userId}`, {
      username: p.username,
      ...want,
      expectedVersion: c.version,
    });
    updated += 1;
  }
  step(`people: ${missing.length} created, ${updated} updated`);

  // 6. Password hashes, scoped to this company's people, as COPY data (never SQL text,
  //    so a failing statement cannot write a hash to the server log). Accounts whose hash
  //    changed lose their open sessions, as a password reset would.
  const hashes = psql(
    'source',
    `copy (select username, password_hash from allrice_users where username in (${names}) and password_hash is not null) to stdout;`,
    { quiet: true },
  );
  const result = psql(
    'target',
    `\\set VERBOSITY terse
begin;
set local log_min_error_statement = panic;
set local log_error_verbosity = terse;
create temp table migrated_hashes (username text primary key, password_hash text not null) on commit drop;
copy migrated_hashes from stdin;
${hashes}\\.
with changed as (
  update allrice_users u set password_hash = h.password_hash, updated_at = now()
  from migrated_hashes h
  where u.username = h.username and u.password_hash is distinct from h.password_hash
    and u.id in (select user_id from allrice_organization_people where organization_id = ${lit(orgId)})
  returning u.id),
revoked as (
  update allrice_sessions s set revoked_at = now()
  where s.user_id in (select id from changed) and s.revoked_at is null returning 1)
select (select count(*) from changed) || ' ' || (select count(*) from revoked);
commit;
`,
    { quiet: true },
  ).trim();
  const [changedHashes, revokedSessions] = result
    .split('\n')
    .at(-1)
    .split(' ')
    .map(Number);
  const digest = (out) =>
    Object.fromEntries(
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('|')),
    );
  const md5 = (scope) =>
    `select u.username, md5(u.password_hash) from allrice_users u where u.username in (${names})${scope};`;
  const src = digest(psql('source', md5('')));
  const dst = digest(
    psql(
      'target',
      md5(
        ` and u.id in (select user_id from allrice_organization_people where organization_id = ${lit(orgId)})`,
      ),
    ),
  );
  const matched = people.filter(
    (p) => src[p.username] && src[p.username] === dst[p.username],
  ).length;
  step(
    `password hashes: ${matched}/${people.length} match (${changedHashes} changed, ${revokedSessions} sessions revoked)`,
  );
  if (matched !== people.length)
    problems.push('password hashes do not all match');

  // 7. Account state follows the source, so a disabled account stays unable to sign in.
  current = await listAll(peoplePath, 'people');
  let switched = 0;
  for (const p of people) {
    const c = current.find((x) => x.username === p.username);
    if (!c) {
      problems.push(`person missing after import: ${p.username}`);
      continue;
    }
    if ((c.status === 'active') === p.active) continue;
    await call('POST', `${peoplePath}/${c.userId}/status`, {
      active: p.active,
      expectedVersion: c.version,
    });
    switched += 1;
  }
  step(`account state: ${switched} changed to match the source`);

  // 8. Platform employees by key. Rice ships with the platform; the others are rebuilt
  //    from the source's published definition, resuming a half-finished earlier run.
  const platform = async () =>
    (await call('GET', '/api/v1/admin/platform-employees')).employees ?? [];
  const wanted = [{ name: 'Rice', key: 'rice' }, ...sourceEmployees];
  for (const want of wanted) {
    let entry = (await platform()).find((e) => e.employeeKey === want.key);
    if (!entry && !want.definition) {
      problems.push(
        `platform employee ${want.key} missing (run content sync / qa-bootstrap first)`,
      );
      continue;
    }
    if (!entry) {
      await call('POST', '/api/v1/admin/platform-employees', {
        key: want.key,
        name: want.name,
      });
      entry = (await platform()).find((e) => e.employeeKey === want.key);
    }
    if (entry.status === 'archived') {
      problems.push(`platform employee ${want.key} is archived on the target`);
      continue;
    }
    const detail = (
      await call('GET', `/api/v1/admin/platform-employees/${entry.id}`)
    ).employee;
    if (detail.publishedRevision ?? detail.currentPublished) continue;
    if (!want.definition) {
      problems.push(`platform employee ${want.key} has no published revision`);
      continue;
    }
    const draft = detail.currentDraft;
    const saved = await call(
      'PUT',
      `/api/v1/admin/platform-employees/${entry.id}`,
      {
        definition: {
          ...want.definition,
          modelPolicy: draft.definition.modelPolicy,
        },
        expectedRevisionId: draft.id,
      },
    );
    if (saved.validation && !saved.validation.valid)
      throw new Error(
        `${want.name} definition invalid here: ${saved.validation.errors.join('; ')}`,
      );
    const check = await call(
      'POST',
      `/api/v1/admin/platform-employees/${entry.id}/review`,
      { scope: 'assigned' },
    );
    if (!check.valid)
      throw new Error(
        `${want.name} review failed: ${(check.errors ?? []).join('; ')}`,
      );
    const published = await call(
      'POST',
      `/api/v1/admin/platform-employees/${entry.id}/publish`,
      {
        scope: 'assigned',
        expectedRevisionId: check.revisionId,
        expectedPublishedRevisionId: check.publishedRevisionId,
        expectedPackageChecksum: check.packageChecksum,
        policyVersions: check.policyVersions,
      },
    );
    if (!published.valid)
      throw new Error(
        `${want.name} publish failed: ${(published.errors ?? []).join('; ')}`,
      );
    step(`platform employee rebuilt and published: ${want.name}`);
  }

  // 9. Each of them assigned to everyone in the company, as the admin UI does.
  const assignments = `/api/v1/admin/organizations/${orgId}/ai-employees`;
  const catalog = await call(
    'GET',
    `${assignments}?${new URLSearchParams({ workspaceId, target: JSON.stringify({ type: 'all' }) })}`,
  );
  const employees = await platform();
  for (const want of wanted) {
    const id = employees.find((e) => e.employeeKey === want.key)?.id;
    const entry =
      id && (catalog.employees ?? []).find((e) => e.employeeId === id);
    if (!entry) {
      problems.push(`not assignable here: ${want.name}`);
      continue;
    }
    if (entry.inheritedByDefault === true) continue;
    await call('POST', assignments, {
      workspaceId,
      employeeId: entry.employeeId,
      revisionId: entry.revisionId,
      expectedVersion: entry.deployment?.version ?? null,
      action: 'default',
      target: { type: 'all' },
      defaultEnabled: true,
    });
    step(`assigned to everyone: ${want.name}`);
  }

  if (problems.length) {
    for (const p of problems) step(`PROBLEM: ${p}`);
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify({
      ok: problems.length === 0,
      organizationId: orgId,
      workspaceId,
      people: people.length,
    }),
  );
} finally {
  await request('POST', '/api/v1/auth/logout').catch(() => undefined);
}
