#!/usr/bin/env node
// Prepare a usable tenant on an AllRice web instance through the real admin APIs
// (no browser): publish the standard Rice, create a company + employee account,
// auto-assign Rice. Idempotent. Talks to http://127.0.0.1:<port> with the admin
// portal Host/Origin so the normal portal authentication and same-origin checks apply.
//
//   node qa-bootstrap.mjs --port <webPort> --company <name> --username <user> --creds <file>
//                         [--env ~/allrice-dev/.env] [--rice <file>]  (default: rice-standard.json next to this script)
//                         [--no-cloud --drop-skills <id,id>]
// --no-cloud publishes Rice without the cloud-sandbox tools (and the given skills
// that require them), for instances whose cloud execution is switched off.
//
// The employee password is generated once and written to --creds (0600); it is
// never printed. Re-running reuses the company/account; a lost password is reset.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { URLSearchParams, fileURLToPath } from 'node:url';

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
const company = args.company;
const username = args.username;
const credsPath = args.creds;
const envPath = args.env ?? `${home}/allrice-dev/.env`;
// The standard definition ships next to this script, so it matches the installed tools.
const ricePath =
  args.rice ?? fileURLToPath(new URL('./rice-standard.json', import.meta.url));
if (!port || !company || !username || !credsPath) {
  console.error(
    'usage: qa-bootstrap.mjs --port <webPort> --company <name> --username <user> --creds <file>',
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
          const set = res.headers['set-cookie'];
          if (set) {
            const jar = new Map(
              cookie
                ? cookie.split('; ').map((c) => c.split(/=(.*)/s).slice(0, 2))
                : [],
            );
            for (const c of set) {
              const [kv] = c.split(';');
              const [k, v] = kv.split(/=(.*)/s);
              jar.set(k, v);
            }
            cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
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
const step = (s) => console.log(`[bootstrap] ${s}`);

// 1. Platform admin login (env credentials on the admin portal host).
await call('POST', '/api/v1/auth/login', {
  username: env.ALLRICE_PLATFORM_ADMIN_USER,
  password: env.ALLRICE_PLATFORM_ADMIN_PASSWORD,
});
step('admin logged in');

// 2. Standard Rice: publish the reviewed definition unless already published with it.
const list = await call('GET', '/api/v1/admin/platform-employees');
const employees = list.employees ?? list.items ?? list;
const rice = employees.find((e) => e.employeeKey === 'rice');
if (!rice)
  throw new Error(
    'platform employee "rice" not found (did db:prepare / content:sync run?)',
  );
const standard = JSON.parse(fs.readFileSync(ricePath, 'utf8'));
if ('no-cloud' in args) {
  const CLOUD_TOOLS = new Set([
    'cloud.process.execute',
    'cloud.mcp.call',
    'python.execute',
    'workspace.reconciliation.export',
  ]);
  const dropSkills = new Set(
    (args['drop-skills'] ?? '').split(',').filter(Boolean),
  );
  const c = standard.capabilities;
  c.toolNames = c.toolNames.filter((t) => !CLOUD_TOOLS.has(t));
  c.explicitToolNames = (c.explicitToolNames ?? []).filter(
    (t) => !CLOUD_TOOLS.has(t),
  );
  c.nativeSkillIds = (c.nativeSkillIds ?? []).filter(
    (id) => !dropSkills.has(id),
  );
  step(
    `no-cloud Rice: ${c.toolNames.length} tools, ${c.nativeSkillIds.length} skills`,
  );
}
let detail = await call('GET', `/api/v1/admin/platform-employees/${rice.id}`);
const published =
  detail.employee.publishedRevision ?? detail.employee.currentPublished ?? null;
// Every top-level field of the standard definition is managed here and must match
// exactly (key order ignored); fields the standard does not list are left alone.
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const sameAsStandard = (rev) =>
  Boolean(rev?.definition) &&
  Object.keys(standard).every(
    (k) =>
      JSON.stringify(canonical(rev.definition[k] ?? null)) ===
      JSON.stringify(canonical(standard[k])),
  );
let publishedRevisionId = published?.id ?? null;
if (!sameAsStandard(published) || !publishedRevisionId) {
  const saved = await call(
    'PUT',
    `/api/v1/admin/platform-employees/${rice.id}`,
    {
      definition: standard,
      expectedRevisionId: detail.employee.currentDraft?.id ?? null,
    },
  );
  if (saved.validation && !saved.validation.valid)
    throw new Error(
      'standard Rice invalid: ' + saved.validation.errors.join('; '),
    );
  const check = await call(
    'POST',
    `/api/v1/admin/platform-employees/${rice.id}/review`,
    { scope: 'assigned' },
  );
  if (!check.valid)
    throw new Error('review failed: ' + (check.errors ?? []).join('; '));
  const result = await call(
    'POST',
    `/api/v1/admin/platform-employees/${rice.id}/publish`,
    {
      scope: 'assigned',
      expectedRevisionId: check.revisionId,
      expectedPublishedRevisionId: check.publishedRevisionId,
      expectedPackageChecksum: check.packageChecksum,
      policyVersions: check.policyVersions,
    },
  );
  if (!result.valid)
    throw new Error('publish failed: ' + (result.errors ?? []).join('; '));
  publishedRevisionId = result.revisionId;
  step(`standard Rice published (revision ${publishedRevisionId})`);
} else step('standard Rice already published');

// 3. Company (reuse by name).
const orgs = await call('GET', '/api/v1/admin/organizations');
let org = (orgs.organizations ?? orgs.items ?? []).find(
  (o) => o.name === company,
);
if (!org) {
  const created = await call('POST', '/api/v1/admin/organizations', {
    name: company,
    businessContext: `${company}：AllRice 验收与冒烟测试用公司，不放真实业务数据。`,
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
    'could not resolve company workspace id: ' +
      JSON.stringify(orgDetail).slice(0, 300),
  );

// 4. Employee account: create (reusing the password in --creds when present), or reset
// the password when our creds file is missing.
let creds = fs.existsSync(credsPath)
  ? JSON.parse(fs.readFileSync(credsPath, 'utf8'))
  : null;
const people = await call(
  'GET',
  `/api/v1/admin/organizations/${org.id}/people`,
);
const person = (people.people ?? people.items ?? []).find(
  (p) => p.username === username,
);
if (!person) {
  // A fresh database with an existing creds file (e.g. after a Dev rebuild): keep the
  // password people already have instead of issuing a new one.
  if (!creds || creds.username !== username) {
    creds = {
      username,
      password: 'Qa-' + crypto.randomBytes(12).toString('base64url'),
    };
  }
  await call('POST', `/api/v1/admin/organizations/${org.id}/people`, {
    people: [
      {
        username,
        displayName: `${company} 体验号`,
        jobTitle: '验收测试',
        responsibilities: '冒烟与验收测试账号',
        departmentId: null,
        password: creds.password,
      },
    ],
  });
  step(`account created: ${username}`);
} else if (!creds || creds.username !== username) {
  creds = {
    username,
    password: 'Qa-' + crypto.randomBytes(12).toString('base64url'),
  };
  await call(
    'PUT',
    `/api/v1/admin/organizations/${org.id}/people/${person.userId}/password`,
    { password: creds.password },
    [200, 204],
  );
  step(`account exists, password reset: ${username}`);
} else step(`account exists: ${username}`);
fs.writeFileSync(credsPath, JSON.stringify({ ...creds, company, port }), {
  mode: 0o600,
});

// 5. Auto-assign Rice to everyone in the company (same request the admin UI sends).
const assignments = `/api/v1/admin/organizations/${org.id}/ai-employees`;
const target = JSON.stringify({ type: 'all' });
const catalog = await call(
  'GET',
  `${assignments}?${new URLSearchParams({ workspaceId, target })}`,
);
const entry = (catalog.employees ?? []).find((e) => e.employeeId === rice.id);
if (!entry)
  throw new Error(
    'Rice missing from the company AI catalog: ' +
      JSON.stringify(catalog).slice(0, 300),
  );
if (entry.inheritedByDefault === true) step('Rice already auto-assigned');
else {
  await call('POST', assignments, {
    workspaceId,
    employeeId: entry.employeeId,
    revisionId: entry.revisionId,
    expectedVersion: entry.deployment?.version ?? null,
    action: 'default',
    target: { type: 'all' },
    defaultEnabled: true,
  });
  step('Rice auto-assigned to the company');
}
console.log(
  JSON.stringify({
    ok: true,
    company,
    organizationId: org.id,
    workspaceId,
    username,
    credsPath,
  }),
);
