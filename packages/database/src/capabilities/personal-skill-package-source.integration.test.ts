import { createHash, randomUUID } from 'node:crypto';
import type { PersonalSkillDefinition } from '@allrice/contracts';
import type { Sql } from 'postgres';
import type * as DatabaseClient from '../core/client.ts';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { createEmployeeInstance } from '../employees/employee-instances.ts';
import { freezePersonalSkills } from '../employees/personal-skills.ts';
import { packageVersionChecksum } from '../employees/personal-skill-model.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { createPostgresPersonalSkillPackageSource } from './personal-skill-package-source.ts';

const client = vi.hoisted(() => ({ db: undefined as Sql | undefined }));
vi.mock('../core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => {
    if (!client.db) throw Error('isolated personal Skill database required');
    return client.db;
  },
}));
const hash = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'real personal Skill rows/bytes/migrations; current is a contract substitute',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let host: Awaited<ReturnType<typeof setup>>;
    async function setup() {
      const publication = await createEmployeeAdministrationFixture(f.db);
      // Existing fixture completes a synthetic publication probe; no model/VM is run.
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
        profile: { name: 'Exact Skill source fixture' },
      });
      return {
        context,
        scope: {
          workspaceId: publication.workspaceId,
          instanceId: instance.id,
        },
        // This closed-over substitute exercises the current contract only. It is
        // not a production current/config producer or a native execution proof.
        requireCurrent: vi.fn(async (signal: AbortSignal) => {
          signal.throwIfAborted();
        }),
      };
    }
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      client.db = f.db;
      host = await setup();
    }, 120000);
    beforeEach(async () => {
      host.requireCurrent.mockReset().mockImplementation(async (signal) => {
        signal.throwIfAborted();
      });
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1
      where organization_id=${host.context.organizationId} and owner_id=${host.context.actor.id}`;
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
        vi.unstubAllEnvs();
      }
    });
    async function install(packaged = false) {
      const installationId = randomUUID(),
        versionId = randomUUID();
      const content = '# 周报\n精确保留 UTF-8 正文。\n';
      const definition: PersonalSkillDefinition = {
        name: 'weekly-' + installationId,
        description: 'Isolated weekly summary.',
        content,
        checksum: hash(content),
        invocation: { modelInvocable: true, userInvocable: true },
        whenToUse: 'When summarizing a week.',
        metadata: { version: '1.2.3', displayName: '周报' },
      };
      const manifestBody = {
        schemaVersion: 1 as const,
        archiveObjectId: randomUUID(),
        sourcePath: 'weekly/SKILL.md',
        resources: [
          {
            path: 'references/rules.md',
            mediaType: 'text/markdown',
            byteLength: 4,
            checksum: hash('rule'),
          },
        ],
      };
      // Only descriptors are stored here; there is deliberately no storage object
      // or archive reader. A manifest result must never claim resource bytes.
      const manifest = packaged
        ? { ...manifestBody, checksum: runtimePolicyDigest(manifestBody) }
        : null;
      const checksum = runtimePolicyDigest(definition);
      const packageChecksum = manifest
        ? packageVersionChecksum(checksum, manifest)
        : null;
      const source = {
        kind: 'attachment',
        objectId: randomUUID(),
        fileName: 'SKILL.md',
        originalChecksum: hash(content),
        byteLength: Buffer.byteLength(content),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
        values(${installationId},${host.context.organizationId},${host.context.actor.id},${definition.name},'installed',${versionId})`;
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum,resource_manifest,package_checksum)
        values(${versionId},${host.context.organizationId},${host.context.actor.id},${installationId},1,${tx.json(source)},${content},${tx.json(definition)},${checksum},${manifest ? tx.json(manifest) : null},${packageChecksum})`;
        await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${host.context.organizationId},${host.scope.workspaceId},${host.context.actor.id},${host.scope.instanceId},${installationId},true)`;
      });
      // Obtain an actual business pin with the existing helper, without a Run.
      const frozen = await freezePersonalSkills(
        host.context,
        { id: host.scope.instanceId },
        { nativeSkills: [] },
      );
      const pin = frozen.personalSkills!.skills.find(
        (item) => item.versionId === versionId,
      )!;
      const read = () =>
        createPostgresPersonalSkillPackageSource(f.db, host).readPackage(
          pin,
          new AbortController().signal,
        );
      return { pin, definition, source, manifest, read };
    }

    it.each([false, true])(
      'reads real frozen definition bytes and manifest/null (package=%s)',
      async (packaged) => {
        const x = await install(packaged),
          result = await x.read();
        expect(result.definition).toEqual(x.definition);
        expect(Buffer.from(result.bodyBytes).toString('utf8')).toBe(
          x.definition.content,
        );
        expect(result.bodyChecksum).toBe(hash(x.definition.content));
        expect(result.pin).toEqual(x.pin);
        expect(result.installationVersion).toBe(1);
        expect(result.manifest).toEqual(x.manifest);
        expect(result).not.toHaveProperty('resourceBytes');
        expect(host.requireCurrent).toHaveBeenCalledTimes(2);
        await expect(
          f.db`update allrice_personal_skill_versions set original_text='changed' where id=${x.pin.versionId}`,
        ).rejects.toThrow('immutable');
      },
    );

    it.each([
      'organizationId',
      'ownerId',
      'instanceId',
      'installationId',
      'versionId',
      'bindingId',
    ] as const)('rejects foreign exact %s', async (field) => {
      const x = await install();
      await expect(
        createPostgresPersonalSkillPackageSource(f.db, host).readPackage(
          { ...x.pin, [field]: randomUUID() },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('keeps an authorized old version after pointer update, but never restores a revoked epoch', async () => {
      const x = await install(),
        nextId = randomUUID();
      const next = {
        ...x.definition,
        content: 'New immutable body',
        checksum: hash('New immutable body'),
      };
      await f.db.begin(async (tx) => {
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
        values(${nextId},${host.context.organizationId},${host.context.actor.id},${x.pin.installationId},2,${tx.json(x.source)},${next.content},${tx.json(next)},${runtimePolicyDigest(next)})`;
        await tx`update allrice_personal_skill_installations set current_version_id=${nextId},revision=revision+1 where id=${x.pin.installationId}`;
      });
      expect((await x.read()).definition).toEqual(x.definition);
      await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where id=${x.pin.bindingId}`;
      await expect(x.read()).rejects.toMatchObject({ code: 'unavailable' });
      await f.db`update allrice_personal_skill_bindings set enabled=true,epoch=epoch+1 where id=${x.pin.bindingId}`;
      await expect(x.read()).rejects.toMatchObject({ code: 'unavailable' });
    });

    it.each([
      'disabled',
      'uninstalled',
      'definitionHash',
      'epoch',
      'workspace',
    ] as const)('rejects current %s mismatch', async (kind) => {
      const x = await install();
      if (kind === 'disabled')
        await f.db`update allrice_personal_skill_bindings set enabled=false where id=${x.pin.bindingId}`;
      if (kind === 'uninstalled')
        await f.db`update allrice_personal_skill_installations set state='uninstalled' where id=${x.pin.installationId}`;
      if (kind === 'definitionHash')
        x.pin.definitionChecksum = hash('not this version');
      if (kind === 'epoch') x.pin.bindingEpoch++;
      const target =
        kind === 'workspace'
          ? {
              ...host,
              context: { ...host.context, workspaceId: null },
              scope: { ...host.scope, workspaceId: randomUUID() },
            }
          : host;
      await expect(
        createPostgresPersonalSkillPackageSource(f.db, target).readPackage(
          x.pin,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('observes a real binding revocation during the second current check using a fresh transaction', async () => {
      const x = await install();
      host.requireCurrent
        .mockImplementationOnce(async () => {})
        .mockImplementationOnce(async () => {
          await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where id=${x.pin.bindingId}`;
        });
      await expect(x.read()).rejects.toMatchObject({ code: 'unavailable' });
      expect(host.requireCurrent).toHaveBeenCalledTimes(2);
    });

    it('propagates the original failed current check without exposing prepared bytes', async () => {
      const x = await install(),
        denied = Error('contract substitute: qualification revoked');
      host.requireCurrent
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(denied);
      await expect(x.read()).rejects.toBe(denied);
    });
  },
);
