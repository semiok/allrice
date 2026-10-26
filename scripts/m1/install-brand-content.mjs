#!/usr/bin/env node
// Install the built-in "品牌内容运营" employee (MET-194) for one person: a custom employee
// on their Rice assignment, the standard brand-content method, and the five brand-content
// workflow packages, bound and enabled. Stopgap until the product has its own entry for
// this (MET-216, user decision 2026-10-26); it calls the same database functions the
// MET-194 acceptance used, in the person's own name, through a server session cut to 30
// minutes and revoked before the script exits (also on INT, TERM and HUP).
//
// Run it from a checkout of this repository with the environment of the target Web:
//   with-env web node scripts/m1/install-brand-content.mjs --root <release dir> \
//     --user <username> --company <organization name>
//     [--name 品牌内容运营] [--base default-assistant] [--state <file>]
//
// --root is the release the target Web runs (templates and database code come from it).
// The state file keeps every request id, so a rerun after a failure resumes the same
// installation instead of creating a second one. Without a state file the script refuses
// when the person already has a live employee of that name. One installation per person
// and name runs at a time (a PostgreSQL advisory lock, held until exit).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
  const value = process.argv[++i];
  if (value === undefined || value.startsWith('--'))
    throw new Error(`${flag} needs a value`);
  args[flag.slice(2)] = value;
}
const root = args.root && path.resolve(args.root);
const username = args.user;
const company = args.company;
const baseKey = args.base ?? 'default-assistant';
if (!root || !username || !company) {
  console.error(
    'usage: install-brand-content.mjs --root <release dir> --user <username> --company <organization name>',
  );
  process.exit(2);
}
const storageRoot = process.env.ALLRICE_STORAGE_ROOT ?? '';
if (!process.env.DATABASE_URL || !path.isAbsolute(storageRoot)) {
  console.error(
    'install-brand-content: needs DATABASE_URL and an absolute ALLRICE_STORAGE_ROOT (run it under with-env web)',
  );
  process.exit(2);
}
const step = (s) => console.log(`[brand-content] ${s}`);
const load = (pkg) =>
  import(pathToFileURL(`${root}/packages/${pkg}/dist/index.js`));
const db = await load('database');
const c = await load('contracts');
const { LocalStorageAdapter } = await load('storage');
const storage = new LocalStorageAdapter(storageRoot);
const sql = db.getDatabase();
const hash = (bytes) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
// Parsed by the same contract createEmployeeInstance uses, so the duplicate check below
// sees the name exactly as it will be stored.
const profile = c.EmployeeInstanceProfileSchema.parse({
  name: args.name ?? '品牌内容运营',
  description: '将品牌资料沉淀为选题、稿件、图文审核和发布交接。',
  role: '品牌内容运营',
  mission:
    '依据品牌真实资料策划内容，保留稿件与配图版本，交真人采纳、审稿和确认发布。',
  workStyle:
    '先核对资料与事实，再生成候选、按准确版本审核；缺失信息明确说明，不编造指标，不自动向外部平台发帖。',
  expressionStyle: 'structured',
});
const name = profile.name;

let token, lock, lockKey, cleaning;
// Revoke the session, drop the lock, close the pool; each step runs even if one fails.
const cleanup = () =>
  (cleaning ??= (async () => {
    try {
      if (token) await db.revokeSession(token);
    } finally {
      try {
        if (lock) {
          await lock`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
          lock.release();
        }
      } finally {
        await db.closeDatabase();
      }
    }
  })());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => {
    console.error(`[brand-content] ${signal}: revoking the session, stopping`);
    cleanup().finally(() => process.exit(130));
  });
try {
  // 1. Who and where: one active member, one workspace, one active base assignment.
  const [scope] = await sql`
    select u.id user_id, o.id organization_id, w.id workspace_id
    from allrice_users u
    join allrice_organizations o on o.name=${company} and o.archived_at is null
    join allrice_memberships m on m.user_id=u.id and m.organization_id=o.id and m.active
    join allrice_workspaces w on w.organization_id=o.id and w.archived_at is null
    where u.username=${username} and u.status='active'`;
  const [{ workspaces }] = await sql`
    select count(*)::int workspaces from allrice_workspaces w
    join allrice_organizations o on o.id=w.organization_id
    where o.name=${company} and o.archived_at is null and w.archived_at is null`;
  assert.ok(scope, `${username} is not an active member of ${company}`);
  assert.equal(workspaces, 1, `${company} must have exactly one workspace`);
  const assignments = await sql`
    select a.id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id
    where a.user_id=${scope.user_id} and a.organization_id=${scope.organization_id}
      and a.workspace_id=${scope.workspace_id} and a.active and e.employee_key=${baseKey}`;
  assert.equal(
    assignments.length,
    1,
    `${username} needs exactly one active ${baseKey} assignment`,
  );
  const assignmentId = assignments[0].id;

  // Before reading any state: one installation per person and name at a time, whatever
  // state file each run was given.
  lockKey = `install-brand-content:${scope.organization_id}:${scope.workspace_id}:${scope.user_id}:${name}`;
  lock = await sql.reserve();
  const [{ locked }] =
    await lock`select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) locked`;
  if (!locked) {
    lock.release();
    lock = undefined;
    throw new Error(
      `another installation of ${name} for ${username} is running`,
    );
  }

  const stateFile =
    args.state ??
    `${os.homedir()}/allrice-dev/qa/brand-content-install/${scope.organization_id}-${username}.json`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(stateFile);
  if (fresh) {
    const [existing] = await sql`
      select id from allrice_employee_instances
      where owner_id=${scope.user_id} and organization_id=${scope.organization_id}
        and kind='custom' and archived_at is null and profile->>'name'=${name}`;
    assert.ok(
      !existing,
      `${username} already has a live employee named ${name} (${existing?.id}); pass its --state file to resume`,
    );
  }
  const state = fresh
    ? {
        schemaVersion: 1,
        organizationId: scope.organization_id,
        workspaceId: scope.workspace_id,
        ownerId: scope.user_id,
        assignmentId,
        name,
        createRequestId: randomUUID(),
        setId: randomUUID(),
        methodId: randomUUID(),
        methodRevisionId: randomUUID(),
        methodsDraftRequestId: randomUUID(),
        methodsValidateRequestId: randomUUID(),
        methodsActivateRequestId: randomUUID(),
        flowsDraftRequestId: randomUUID(),
        flowsValidateRequestId: randomUUID(),
        flowsActivateRequestId: randomUUID(),
        packages: {},
        createdAt: new Date().toISOString(),
      }
    : JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const [key, value] of Object.entries({
    organizationId: scope.organization_id,
    workspaceId: scope.workspace_id,
    ownerId: scope.user_id,
    assignmentId,
    name,
  }))
    assert.equal(state[key], value, `state file does not match ${key}`);
  const templateDigest = hash(
    JSON.stringify({
      method: c.brandContentMethodText.trim(),
      templates: c.brandContentWorkflowTemplates,
    }),
  );
  if (state.templateDigest)
    assert.equal(
      state.templateDigest,
      templateDigest,
      'templates changed since this installation started',
    );
  state.templateDigest = templateDigest;
  state.root = root;
  // Write a temporary file, sync it, then rename over the state: a failed or killed save
  // leaves the previous complete state in place.
  const save = () => {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, stateFile);
  };
  save();
  step(`state ${stateFile}`);

  // 2. Act as the person. createSession issues a 7-day session; cut it to 30 minutes at
  //    once so a run killed before cleanup leaves nothing usable for long.
  const login = await db.createSession(scope.user_id);
  token = login.token;
  await sql`update allrice_sessions set expires_at=least(expires_at, now() + interval '30 minutes')
    where id=${login.id}`;
  const context = await db.authenticateSession(
    token,
    { organizationId: scope.organization_id, workspaceId: scope.workspace_id },
    'employee',
  );
  assert.ok(context, 'could not open a session for the person');

  // 3. The custom employee on the Rice assignment.
  const instance = await db.createEmployeeInstance(context, {
    workspaceId: scope.workspace_id,
    assignmentId,
    requestId: state.createRequestId,
    profile,
  });
  if (state.instanceId) assert.equal(instance.id, state.instanceId);
  state.instanceId = instance.id;
  save();
  step(`employee ${instance.id}`);

  // 4. The standard method, then each workflow package bound and enabled, then the
  //    employee's content pointing at all of them.
  const common = {
    workspaceId: scope.workspace_id,
    setId: state.setId,
    ownership: {
      scope: 'personal',
      organizationId: scope.organization_id,
      ownerId: scope.user_id,
    },
    target: { kind: 'instance', instanceId: instance.id },
    changeSummary: 'MET-216 迁移后恢复品牌内容运营；按当前版本的内置模板安装',
  };
  const publish = async (label, expectedRevision, textEdits, manifest) => {
    const draft = await db.mutateEmployeeContent(context, {
      ...common,
      operation: 'save_draft',
      requestId: state[`${label}DraftRequestId`],
      expectedRevision,
      textEdits,
      manifest,
    });
    const checked = await db.mutateEmployeeContent(context, {
      ...common,
      operation: 'validate',
      requestId: state[`${label}ValidateRequestId`],
      expectedRevision: draft.revision,
      candidateRevisionId: draft.candidate.id,
      candidateDigest: draft.candidate.digest,
    });
    assert.equal(
      checked.validation.valid,
      true,
      JSON.stringify(checked.validation),
    );
    return db.mutateEmployeeContent(context, {
      ...common,
      operation: 'activate',
      requestId: state[`${label}ActivateRequestId`],
      expectedRevision: checked.revision,
      candidateRevisionId: checked.candidate.id,
      candidateDigest: checked.candidate.digest,
    });
  };
  if (!state.methodReceipt) {
    state.methodReceipt = await publish(
      'methods',
      0,
      [
        {
          contentId: state.methodId,
          revisionId: state.methodRevisionId,
          expectedRevision: 0,
          kind: 'procedure',
          title: '品牌内容运营标准方法',
          body: c.brandContentMethodText.trim(),
        },
      ],
      {
        schemaVersion: 1,
        common: [{ sourceKind: 'draft_text', contentId: state.methodId }],
        scenes: [],
        declaredConflicts: [],
      },
    );
    save();
  }
  const effective = await db.getEffectiveEmployeeContent(context, instance.id);
  const method = effective.sources.find(
    (s) => s.reference.contentId === state.methodId,
  );
  assert.ok(
    method?.available && method.body === c.brandContentMethodText.trim(),
  );
  const methodRef = { ...method.reference, sourceKind: 'procedure' };
  step('method active');

  for (const template of c.brandContentWorkflowTemplates) {
    const item = (state.packages[template.stage] ??= {
      sourceId: randomUUID(),
      registerRequestId: randomUUID(),
      bindRequestId: randomUUID(),
    });
    save();
    const files = [
      ['workflow.json', JSON.stringify(template.definition)],
      ['method.md', method.body],
    ].map(([file, body]) => {
      const bytes = Buffer.from(body);
      return {
        path: file,
        checksum: hash(bytes),
        contentBase64: bytes.toString('base64'),
      };
    });
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
    const [prior] =
      await sql`select * from allrice_storage_objects where id=${item.sourceId}`;
    if (prior) {
      // A rerun: the source object must be exactly the one this installation made.
      assert.equal(prior.organization_id, scope.organization_id);
      assert.equal(prior.owner_id, scope.user_id);
      assert.equal(prior.checksum, hash(bytes));
      assert.equal(Number(prior.size_bytes), bytes.length);
      assert.equal(prior.deleted_at, null);
      const object = c.StorageObjectSchema.parse({
        id: prior.id,
        organizationId: prior.organization_id,
        workspaceId: prior.workspace_id,
        ownerId: prior.owner_id,
        key: prior.object_key,
        sizeBytes: Number(prior.size_bytes),
        mediaType: prior.media_type,
        checksum: prior.checksum,
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      });
      if (prior.state === 'pending') {
        await storage.put(object, new Blob([bytes]).stream());
        item.source = (await db.markStorageReady(context, object.id)).object;
      } else {
        const actual = Buffer.from(
          await new Response(await storage.get(object)).arrayBuffer(),
        );
        assert.equal(hash(actual), hash(bytes));
        item.source = object;
      }
    } else {
      const stored = await db.createStorageMetadata(context, {
        id: item.sourceId,
        workspaceId: scope.workspace_id,
        category: 'exports',
        mediaType: 'application/json',
        sizeBytes: bytes.length,
        checksum: hash(bytes),
        visibility: 'private',
        retentionUntil: null,
        immutable: true,
      });
      await storage.put(stored.object, new Blob([bytes]).stream());
      item.source = (
        await db.markStorageReady(context, stored.object.id)
      ).object;
    }
    save();
    item.package = await db.registerWorkflowPackage(
      context,
      {
        workspaceId: scope.workspace_id,
        instanceId: instance.id,
        sceneId: null,
        requestId: item.registerRequestId,
        expectedRevision: 0,
        slug: template.slug,
        name: template.name,
        description: template.description,
        definition: template.definition,
        manifest: {
          schemaVersion: 1,
          templateKey: template.templateKey,
          method: methodRef,
          definitionChecksum: db.runtimePolicyDigest(template.definition),
          source: { objectId: item.source.id, checksum: item.source.checksum },
          files: files.map(({ path: file, checksum }) => ({
            path: file,
            checksum,
          })),
          assets: [],
        },
      },
      { storage },
    );
    save();
    item.binding = await db.setWorkflowPackageBinding(context, {
      workspaceId: scope.workspace_id,
      instanceId: instance.id,
      sceneId: null,
      workflowRevisionId: item.package.workflow.id,
      requestId: item.bindRequestId,
      expectedRevision: 0,
      enabled: true,
    });
    save();
    step(`workflow ${template.name} registered and enabled`);
  }
  const packages = Object.values(state.packages).map((item) => item.package);
  if (!state.flowsReceipt) {
    state.flowsReceipt = await publish(
      'flows',
      state.methodReceipt.revision,
      [],
      {
        schemaVersion: 1,
        common: [
          methodRef,
          ...packages.map((p) => ({
            sourceKind: 'workflow',
            contentId: p.workflow.workflowId,
            revisionId: p.workflow.id,
            digest: p.workflow.checksum,
          })),
        ],
        scenes: [],
        declaredConflicts: [],
      },
    );
    save();
  }

  // 5. Read back through the same functions the chat panel uses.
  const final = await db.getEffectiveEmployeeContent(context, instance.id);
  assert.equal(
    final.sources.filter(
      (s) => s.reference.sourceKind === 'workflow' && s.available,
    ).length,
    c.brandContentWorkflowTemplates.length,
  );
  const catalog = await db.listWorkflowPackages(context, {
    workspaceId: scope.workspace_id,
    instanceId: instance.id,
    sceneId: null,
  });
  for (const template of c.brandContentWorkflowTemplates) {
    const installed = catalog.find(
      (v) =>
        v.package.manifest.templateKey === template.templateKey &&
        v.binding?.enabled &&
        v.binding.workflowRevisionId === v.package.workflow.id,
    );
    assert.ok(installed, `${template.name} is not enabled`);
    assert.equal(installed.syncStatus, 'in_sync');
    assert.deepEqual(
      installed.package.workflow.definition,
      template.definition,
    );
  }
  state.verifiedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      verified: true,
      user: username,
      company,
      instanceId: instance.id,
      workflows: c.brandContentWorkflowTemplates.map((t) => t.name),
      templateDigest,
      stateFile,
    }),
  );
} finally {
  await cleanup();
}
