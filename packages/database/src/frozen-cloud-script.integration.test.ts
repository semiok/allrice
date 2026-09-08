import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DshNativeSkillSnapshot } from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { skillBundleChecksum, validateFrozenSkill } from './skill-bundles.ts';
import { resolveCloudToolArguments } from '../../../apps/worker/src/tool-broker/handlers/cloud-frozen-script.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const schema = `p19_frozen_${randomUUID().replaceAll('-', '')}`;
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string,
  skill: DshNativeSkillSnapshot;
const reference = {
  frozenScript: {
    skill: 'business-reconciliation',
    path: 'scripts/reconcile.mjs',
  },
};
function resign(value: DshNativeSkillSnapshot) {
  const { checksum: _ignored, ...bundle } = value.bundle!;
  void _ignored;
  value.bundle!.checksum = skillBundleChecksum(bundle);
  return value;
}
const fixture = (skills = [skill]) =>
  createCloudExecutionFixture(db, storageRoot, {
    workbench: true,
    reconciliationOnly: true,
    dsh: {
      provider: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        credentialReference: 'test:never-resolved',
        baseUrl: null,
      },
      prompt: {
        systemPrompt: 'Synthetic frozen script',
        conversation: [],
        memories: [],
        userRequest: 'Synthetic only',
        imageAttachments: [],
      },
      skills,
    },
  });
suite(
  'P19 frozen cloud script reference authority, actual PostgreSQL without a model/VM',
  () => {
    beforeAll(async () => {
      if (!process.env.ALLRICE_TEST_DATABASE_URL)
        throw Error('dedicated test DB required');
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
      const localDisposable =
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        url.port === '5432' &&
        url.username === 'a123' &&
        ['/allrice_b1', '/allrice_b2'].includes(url.pathname);
      const ciDisposable =
        url.hostname === '127.0.0.1' &&
        url.port === '54329' &&
        url.username === 'allrice' &&
        url.pathname === '/allrice';
      if (!localDisposable && !ciDisposable)
        throw Error(
          'Only the local disposable B1/B2 or CI database is permitted',
        );
      admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
        max: 2,
        onnotice: () => {},
      });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 10, onnotice: () => {} });
      const migrations = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, migrations), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-frozen-cloud-'));
      const catalog = await loadPlatformContentCatalog(
        resolve(import.meta.dirname, '../../..'),
      );
      const found = catalog.skills.find(
        (entry) => entry.name === 'business-reconciliation',
      )!;
      skill = validateFrozenSkill({
        id: found.id,
        name: found.name,
        description: found.description,
        content: found.content,
        checksum: found.checksum,
        invocation: {
          modelInvocable: found.modelInvocable,
          userInvocable: found.userInvocable,
        },
        requiredToolRefs: found.requiredToolRefs,
        bundle: found.bundle,
      });
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^p19_frozen_[a-f0-9]{32}$/.test(schema))
          throw Error('bad schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-frozen-cloud-'))
        await rm(storageRoot, { recursive: true, force: true });
    });
    it('resolves exact persisted bytes including final newline and creates an unchanged exact approval proposal', async () => {
      const f = await fixture();
      const resolved = await resolveCloudToolArguments(
        { context: f.execution, sessionId: f.session, arguments: reference },
        db,
      );
      const source = skill.bundle!.resources.find(
        (resource) => resource.path === reference.frozenScript.path,
      )!;
      expect(Buffer.from(resolved.script)).toEqual(
        Buffer.from(source.contentBase64, 'base64'),
      );
      expect(resolved.script.endsWith('\n')).toBe(true);
      process.env.ALLRICE_CLOUD_RUNNER_ENABLED = '1';
      process.env.ALLRICE_RUNTIME_POLICY_ENABLED = '1';
      try {
        const created = await f.create('reference', resolved);
        expect(created.payload.arguments.script).toBe(resolved.script);
        expect(created.snapshot.status).toBe('waiting_user');
        await expect(
          created.ledger.dispatch({
            scope: created.snapshot.binding.task.scope,
            operationId: created.snapshot.binding.attempt.operationId,
            leaseOwner: f.execution.worker.id,
            leaseMs: 15000,
          }),
        ).rejects.toThrow();
      } finally {
        delete process.env.ALLRICE_CLOUD_RUNNER_ENABLED;
        delete process.env.ALLRICE_RUNTIME_POLICY_ENABLED;
      }
    });
    it('keeps inline scripts byte-for-byte compatible without a resource/session read', async () => {
      const f = await fixture([]);
      const args = await resolveCloudToolArguments(
        { context: f.execution, arguments: { script: 'console.log(1);\n' } },
        db,
      );
      expect(args.script).toBe('console.log(1);\n');
    });
    it.each([
      { ...reference, script: 'conflicting' },
      {},
      { frozenScript: { ...reference.frozenScript, runId: randomUUID() } },
      {
        frozenScript: {
          ...reference.frozenScript,
          path: 'scripts/../../secret.mjs',
        },
      },
      {
        frozenScript: {
          ...reference.frozenScript,
          path: 'references/format.md',
        },
      },
    ])(
      'rejects malformed or authority-expanding reference %#',
      async (args) => {
        const f = await fixture();
        await expect(
          resolveCloudToolArguments(
            { context: f.execution, sessionId: f.session, arguments: args },
            db,
          ),
        ).rejects.toThrow();
      },
    );
    it('requires the exact session, owner, tenant and Run binding', async () => {
      const f = await fixture(),
        other = await fixture();
      for (const input of [
        { context: f.execution, sessionId: other.session },
        { context: { ...f.execution, runId: other.run }, sessionId: f.session },
        {
          context: {
            ...f.execution,
            policySnapshot: {
              ...f.execution.policySnapshot,
              subjectId: other.user,
            },
          },
          sessionId: f.session,
        },
        {
          context: { ...f.execution, organizationId: other.org },
          sessionId: f.session,
        },
      ])
        await expect(
          resolveCloudToolArguments({ ...input, arguments: reference }, db),
        ).rejects.toThrow('frozen_script_run_unavailable');
    });
    it('cannot import a Skill from another Run or mutable catalog', async () => {
      const f = await fixture([]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow();
    });
    it('rejects modified resource bytes under the original frozen checksums', async () => {
      const corrupted = structuredClone(skill);
      corrupted.bundle!.resources.find(
        (r) => r.path === reference.frozenScript.path,
      )!.contentBase64 = Buffer.from('modified').toString('base64');
      const f = await fixture([corrupted]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow('checksum_mismatch');
    });
    it('requires JavaScript media type even for a correctly checksummed bundle', async () => {
      const wrong = structuredClone(skill);
      wrong.bundle!.resources.find(
        (r) => r.path === reference.frozenScript.path,
      )!.mediaType = 'text/plain';
      const f = await fixture([resign(wrong)]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow('frozen_script_media_type_invalid');
    });
    it('requires the frozen Skill read tool authorization; execute alone cannot read resources', async () => {
      const noRead = structuredClone(skill);
      noRead.requiredToolRefs = noRead.requiredToolRefs.filter(
        (name) => name !== 'workspace.skill.read',
      );
      noRead.bundle!.dependencies = noRead.bundle!.dependencies.filter(
        (dep) => dep.kind !== 'tool' || dep.name !== 'workspace.skill.read',
      );
      const f = await fixture([resign(noRead)]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow('frozen_script_tool_not_authorized');
    });
    it('requires the declared fixed Node runtime dependency', async () => {
      const wrong = structuredClone(skill);
      wrong.bundle!.dependencies = wrong.bundle!.dependencies.filter(
        (dep) => dep.kind !== 'runtime',
      );
      const f = await fixture([resign(wrong)]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow('frozen_script_runtime_required');
    });
    it('preserves a UTF-8 BOM and trailing newline in exact approval bytes', async () => {
      const withBom = structuredClone(skill);
      const source = withBom.bundle!.resources.find(
        (resource) => resource.path === reference.frozenScript.path,
      )!;
      const bytes = Buffer.from('\ufeffconsole.log(1);\n');
      source.contentBase64 = bytes.toString('base64');
      source.byteLength = bytes.length;
      source.checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const f = await fixture([resign(withBom)]);
      const resolved = await resolveCloudToolArguments(
        { context: f.execution, sessionId: f.session, arguments: reference },
        db,
      );
      expect(Buffer.from(resolved.script)).toEqual(bytes);
    });
    it('rejects invalid UTF-8 even when every stored resource checksum is valid', async () => {
      const wrong = structuredClone(skill);
      const source = wrong.bundle!.resources.find(
        (resource) => resource.path === reference.frozenScript.path,
      )!;
      const bytes = Buffer.from([0xc0, 0xff]);
      source.contentBase64 = bytes.toString('base64');
      source.byteLength = bytes.length;
      source.checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const f = await fixture([resign(wrong)]);
      await expect(
        resolveCloudToolArguments(
          { context: f.execution, sessionId: f.session, arguments: reference },
          db,
        ),
      ).rejects.toThrow();
    });
  },
);
