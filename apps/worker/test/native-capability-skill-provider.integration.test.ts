import { createHash, randomUUID } from 'node:crypto';
import type { PersonalSkillDefinition } from '@allrice/contracts';
import {
  createBuiltinSkillSourcesPort,
  createPostgresPersonalSkillPackageSource,
  runtimePolicyDigest,
} from '@allrice/database';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type * as DatabaseClient from '../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../packages/database/src/runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../packages/database/src/employee-administration.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../packages/database/src/identity.ts';
import { getEmployeeWorkspace } from '../../../packages/database/src/workspace/service.ts';
import { createEmployeeInstance } from '../../../packages/database/src/employees/employee-instances.ts';
import {
  registerNativeCapabilitySkillProvider,
  type NativeCapabilitySkillConfiguration,
} from '../src/native-capability-skill-provider.js';

const client: {
  db?: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'];
} = vi.hoisted(() => ({}));
vi.mock('../../../packages/database/src/core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => {
    if (!client.db) throw Error('isolated native Skill database required');
    return client.db;
  },
}));
const hash = (text: string) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'real PG sources → real DSH registry; current/config are contract substitutes',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let host: Awaited<ReturnType<typeof setup>>;
    const contexts: Context[] = [];
    async function setup() {
      const publication = await createEmployeeAdministrationFixture(f.db);
      // Existing synthetic publication fixture; no provider/model/VM invocation.
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
      const context = (await authenticateSession(
        (await createSession(publication.ownerId)).token,
        {
          organizationId: publication.organizationId,
          workspaceId: publication.workspaceId,
        },
      ))!;
      const assignment = (
        await getEmployeeWorkspace(context, publication.workspaceId)
      ).employees.find(
        (item) => item.employeeKey === publication.definition.key,
      )!;
      const instance = await createEmployeeInstance(context, {
        workspaceId: publication.workspaceId,
        assignmentId: assignment.id,
        requestId: randomUUID(),
        profile: { name: 'Native Skill fixture' },
      });
      return {
        context,
        scope: {
          workspaceId: publication.workspaceId,
          instanceId: instance.id,
        },
        requireCurrent: vi.fn(async (signal: AbortSignal) =>
          signal.throwIfAborted(),
        ),
      };
    }
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      client.db = f.db;
      host = await setup();
    }, 120000);
    beforeEach(async () => {
      host.requireCurrent
        .mockReset()
        .mockImplementation(async (signal) => signal.throwIfAborted());
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
      where organization_id=${host.context.organizationId} and owner_id=${host.context.actor.id}`;
    });
    afterEach(async () => {
      for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
    });
    afterAll(async () => {
      try {
        if (f)
          expect(await f.close()).toMatchObject({
            databaseClosed: true,
            adminClosed: true,
            schemaRemoved: true,
            storageRemoved: true,
          });
      } finally {
        client.db = undefined;
      }
    });
    async function install() {
      const installationId = randomUUID(),
        versionId = randomUUID();
      const definition: PersonalSkillDefinition = {
        name: 'weekly-' + installationId,
        description: 'Use my installed weekly Skill.',
        content: '# 周报\n精确保留本人正文。\n',
        checksum: hash('# 周报\n精确保留本人正文。\n'),
        invocation: { modelInvocable: true, userInvocable: false },
        whenToUse: 'When summarizing a week.',
        metadata: { displayName: '周报' },
      };
      const source = {
        kind: 'attachment',
        objectId: randomUUID(),
        fileName: 'SKILL.md',
        originalChecksum: definition.checksum,
        byteLength: Buffer.byteLength(definition.content),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
        values(${installationId},${host.context.organizationId},${host.context.actor.id},${definition.name},'installed',${versionId})`;
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${versionId},${host.context.organizationId},${host.context.actor.id},${installationId},1,${tx.json(source)},${definition.content},${tx.json(definition)},${runtimePolicyDigest(definition)})`;
        await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${host.context.organizationId},${host.scope.workspaceId},${host.context.actor.id},${host.scope.instanceId},${installationId},true)`;
      });
      return { installationId, versionId, definition, source };
    }
    async function mount() {
      const ctx = new Context();
      contexts.push(ctx);
      await ctx.plugin(SkillRegistry);
      const builtin = createBuiltinSkillSourcesPort();
      const catalog = await builtin.listSources(new AbortController().signal);
      const web = catalog.sources.find((item) => item.name === 'web-research')!;
      let configuration: NativeCapabilitySkillConfiguration = {
        builtinSkills: [web.selector],
        personalSkills: true,
      };
      const personal = createPostgresPersonalSkillPackageSource(f.db, host);
      let mounted!: ReturnType<typeof registerNativeCapabilitySkillProvider>;
      await ctx.inject(['skills'], (target) => {
        mounted = registerNativeCapabilitySkillProvider(target, {
          builtin,
          personal,
          requireCurrent: host.requireCurrent,
          readConfiguration: async (signal) => {
            signal.throwIfAborted();
            return configuration;
          },
        });
      });
      return {
        ctx,
        mounted,
        personal,
        web,
        builtin,
        configure(value: NativeCapabilitySkillConfiguration) {
          configuration = value;
        },
      };
    }

    it('用户要用本人安装的周报Skill：actual list→exact body, update pin, epoch revocation', async () => {
      const installed = await install();
      const m = await mount();
      expect(
        (await m.ctx.skills.list()).map((item) => item.name).sort(),
      ).toEqual(['web-research', installed.definition.name].sort());
      expect(await m.ctx.skills.get(installed.definition.name)).toMatchObject({
        name: installed.definition.name,
        content: installed.definition.content,
        invocation: installed.definition.invocation,
        metadata: installed.definition.metadata,
        resourceBase: { kind: 'opaque' },
      });
      expect((await m.ctx.skills.get(m.web.name))?.content).toBe(
        (
          await m.builtin.readPackage(
            m.web.selector,
            new AbortController().signal,
          )
        ).content,
      );
      const nextId = randomUUID();
      const next = {
        ...installed.definition,
        content: '# 周报第二版\n',
        checksum: hash('# 周报第二版\n'),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${nextId},${host.context.organizationId},${host.context.actor.id},${installed.installationId},2,${tx.json(installed.source)},${next.content},${tx.json(next)},${runtimePolicyDigest(next)})`;
        await tx`update allrice_personal_skill_installations set current_version_id=${nextId} where id=${installed.installationId}`;
      });
      // An ordinary pointer update does not revoke the exact cached candidate.
      expect((await m.ctx.skills.get(next.name))?.content).toBe(
        installed.definition.content,
      );
      m.mounted.invalidate();
      expect((await m.ctx.skills.get(next.name))?.content).toBe(next.content);
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
      where instance_id=${host.scope.instanceId} and installation_id=${installed.installationId}`;
      await expect(m.ctx.skills.get(next.name)).rejects.toThrow(
        'personal_skill_unavailable',
      );
      m.mounted.invalidate();
      expect((await m.ctx.skills.list()).map((item) => item.name)).toEqual([
        m.web.name,
      ]);
      await m.mounted.dispose();
      expect(await m.ctx.skills.list()).toEqual([]);
    });

    it('rechecks actual PG body current/config and keeps an unavailable producer fail closed', async () => {
      const installed = await install();
      const m = await mount();
      await m.ctx.skills.list();
      const denied = Error('current contract substitute revoked');
      host.requireCurrent.mockRejectedValue(denied);
      await expect(m.ctx.skills.get(installed.definition.name)).rejects.toBe(
        denied,
      );
      m.mounted.invalidate();
      expect(await m.ctx.skills.snapshot()).toEqual({
        skills: [],
        complete: false,
      });
      host.requireCurrent.mockImplementation(async (signal) =>
        signal.throwIfAborted(),
      );
      m.configure({ builtinSkills: [], personalSkills: false });
      m.mounted.invalidate();
      expect(await m.ctx.skills.list()).toEqual([]);
      expect(await m.ctx.skills.get(installed.definition.name)).toBeUndefined();
    });
  },
);
