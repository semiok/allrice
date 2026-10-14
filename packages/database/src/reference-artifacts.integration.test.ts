import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, StoragePort } from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  createSession,
  authenticateSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import {
  changeReference,
  completeReferenceUpload,
  getReferenceFile,
  listReferenceRevisions,
  prepareReferenceUpload,
  saveArtifactReference,
} from './reference-library.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'artifact reference publication: exact version, current authority and retry boundaries',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      storage: StoragePort;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      storage = assistantFixtureStorage(f.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);
    async function setup() {
      const a = await tenantValidationFixture(f.db);
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level)
      values(${a.context.organizationId},${a.context.actor.id},'Publisher','company') on conflict(organization_id,user_id) do update set content_maintenance_level='company'`;
      const owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.context.workspaceId,
      };
      const [org] =
        await f.db`select slug,name from allrice_organizations where id=${owner.organizationId}`;
      const person = await ensureBootstrapPortalPrincipal({
        organizationSlug: org!.slug,
        organizationName: org!.name,
        workspaceSlug: 'reader',
        workspaceName: 'Reader',
        email: randomUUID() + '@example.test',
        displayName: 'Reader',
        role: 'member',
      });
      const reader = {
        ...(await authenticateSession(
          (await createSession(person.user.id)).token,
        ))!,
        workspaceId: person.workspaceId,
      };
      const input = {
        workspaceId: owner.workspaceId!,
        requestId: randomUUID(),
        artifactVersionId: a.artifact.artifactId,
        scope: 'company' as const,
        purpose: 'Fixed reference',
      };
      return { a, owner, reader, input };
    }
    const save = (owner: RequestContext, input: unknown, port = storage) =>
      saveArtifactReference(owner, input, port);
    const file = (owner: RequestContext, id: string) =>
      getReferenceFile(owner, owner.workspaceId!, id);
    function storageWith(overrides: Partial<StoragePort>): StoragePort {
      return {
        get: storage.get.bind(storage),
        put: storage.put.bind(storage),
        delete: storage.delete.bind(storage),
        exists: storage.exists.bind(storage),
        ...overrides,
      };
    }
    it('copies exact bytes once under concurrent aliases; does not publish private conversation or link original storage', async () => {
      const { a, owner, reader, input } = await setup();
      const alias = { ...input, requestId: randomUUID() };
      const [one, two] = await Promise.all([
        save(owner, input),
        save(owner, alias),
      ]);
      expect(two).toEqual(one);
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        input.artifactVersionId,
        f.db,
      );
      const retained = await file(reader, one.revisionId);
      expect(retained.object.id).not.toBe(original.object.id);
      expect(retained.object.checksum).toBe(a.artifact.digest);
      expect(retained.object.immutable).toBe(true);
      expect(retained.object.retentionUntil).toBeNull();
      expect(await readArtifactBytes(storage, retained.object)).toEqual(
        await readArtifactBytes(storage, original.object),
      );
      const refs = await listReferenceRevisions(reader, reader.workspaceId!);
      expect(refs).toHaveLength(1);
      expect(refs[0]!.origin).toEqual({
        fileName: original.version.fileName,
        version: 1,
        checksum: original.object.checksum,
      });
      const publicJson = JSON.stringify(refs);
      for (const secret of [
        a.task.chatSessionId!,
        a.task.runId,
        original.object.key,
        'PRIVATE_TEST_SECRET',
      ])
        expect(publicJson).not.toContain(secret);
      await expect(
        getWorkbenchArtifact(
          reader,
          a.task.chatSessionId!,
          input.artifactVersionId,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
      await expect(
        save(reader, {
          ...input,
          workspaceId: reader.workspaceId,
          scope: 'personal',
        }),
      ).rejects.toThrow('source_unavailable');
      await expect(
        save(owner, { ...alias, purpose: 'changed input under same alias' }),
      ).rejects.toThrow('request_conflict');
      await expect(
        save(owner, { ...alias, scope: 'personal' }),
      ).rejects.toThrow('request_conflict');
      expect(
        await save(owner, {
          ...input,
          requestId: randomUUID(),
          purpose: 'does not overwrite canonical purpose',
        }),
      ).toEqual(one);
      const [count] =
        await f.db`select count(*)::int n from allrice_knowledge_revisions where source_artifact_version_id=${input.artifactVersionId}`;
      expect(count!.n).toBe(1);
    });
    it('keeps artifact v1 and v2 independent, including after the saved reference receives a manual revision', async () => {
      const { a, owner, input } = await setup();
      const first = await save(owner, input);
      const secondArtifact = await a.createArtifact(
        a.task.runId,
        'Corrected v2 amount 125',
      );
      await f.db`update allrice_deliverable_versions set series_id=(select series_id from allrice_deliverable_versions where id=${input.artifactVersionId}),version=2,parent_version_id=${input.artifactVersionId} where id=${secondArtifact.artifactId}`;
      const second = await save(owner, {
        ...input,
        requestId: randomUUID(),
        artifactVersionId: secondArtifact.artifactId,
      });
      expect(second.sourceId).not.toBe(first.sourceId);
      expect((await file(owner, first.revisionId)).object.checksum).toBe(
        a.artifact.digest,
      );
      expect((await file(owner, second.revisionId)).object.checksum).toBe(
        secondArtifact.digest,
      );
      const manual = await prepareReferenceUpload(owner, {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        sourceId: first.sourceId,
        expectedRevision: 1,
        scope: 'company',
        fileName: 'manual.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('manual v2').toString('base64'),
      });
      await storage.put(
        manual.object,
        new Blob([new Uint8Array(manual.bytes)]).stream(),
      );
      await completeReferenceUpload(
        owner,
        owner.workspaceId!,
        manual.revisionId,
      );
      expect(await save(owner, { ...input, requestId: randomUUID() })).toEqual(
        first,
      );
      await expect(
        f.db`update allrice_knowledge_revisions set artifact_snapshot='{}' where id=${first.revisionId}`,
      ).rejects.toThrow('Reference revision is immutable');
    });
    it('shares request IDs with uploads and refuses changed operations in both directions', async () => {
      const { owner, input } = await setup();
      const upload = {
        workspaceId: owner.workspaceId,
        requestId: input.requestId,
        scope: 'personal',
        fileName: 'separate.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('upload').toString('base64'),
      };
      await save(owner, input);
      await expect(prepareReferenceUpload(owner, upload)).rejects.toThrow(
        'request_conflict',
      );
      const requestId = randomUUID();
      await prepareReferenceUpload(owner, { ...upload, requestId });
      await expect(save(owner, { ...input, requestId })).rejects.toThrow(
        'request_conflict',
      );
    });
    it('normalizes UUIDs before target identity, dedup and ownership so ordinary department colleagues can read', async () => {
      const { owner, reader, input } = await setup();
      const departmentId = randomUUID();
      await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name) values(${departmentId},${owner.organizationId},'Department',${randomUUID()},'Department')`;
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,department_id) values(${reader.organizationId},${reader.actor.id},'Department reader',${departmentId})`;
      const value = { ...input, scope: 'department', departmentId };
      const upper = {
        ...value,
        requestId: randomUUID().toUpperCase(),
        workspaceId: input.workspaceId.toUpperCase(),
        artifactVersionId: input.artifactVersionId.toUpperCase(),
        departmentId: departmentId.toUpperCase(),
      };
      const [one, two] = await Promise.all([
        save(owner, value),
        save(owner, upper),
      ]);
      expect(one).toEqual(two);
      expect(
        await save(owner, {
          ...upper,
          requestId: upper.requestId.toLowerCase(),
        }),
      ).toEqual(one);
      expect((await file(reader, one.revisionId)).object.checksum).toBe(
        (await file(owner, one.revisionId)).object.checksum,
      );
      const refs = await listReferenceRevisions(reader, reader.workspaceId!);
      expect(refs[0]!.ownership).toEqual({
        scope: 'department',
        organizationId: owner.organizationId,
        departmentId,
      });
      await f.db`update allrice_organization_people set department_id=null where organization_id=${reader.organizationId} and user_id=${reader.actor.id}`;
      await expect(file(reader, one.revisionId)).rejects.toThrow('not_found');
    });
    it('retains a ready reference across original archive/deletion and author deactivation; archive/revocation still closes new reads', async () => {
      const { a, owner, reader, input } = await setup();
      const saved = await save(owner, input);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${a.task.chatSessionId}`;
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        input.artifactVersionId,
        f.db,
      );
      await unlink(join(f.storageRoot, original.object.key));
      expect(await save(owner, input)).toEqual(saved);
      expect(await save(owner, { ...input, requestId: randomUUID() })).toEqual(
        saved,
      );
      await f.db`update allrice_users set status='disabled' where id=${owner.actor.id}`;
      expect(
        (
          await readArtifactBytes(
            storage,
            (await file(reader, saved.revisionId)).object,
          )
        ).length,
      ).toBeGreaterThan(0);
      await expect(save(owner, input)).rejects.toThrow('authorization_denied');
      await f.db`update allrice_users set status='active' where id=${owner.actor.id}`;
      await changeReference(owner, saved.sourceId, {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'archive',
      });
      await expect(file(reader, saved.revisionId)).rejects.toThrow('not_found');
      await expect(save(owner, input)).rejects.toThrow('not_found');
    });
    it('rechecks target authority after reading and after copying, keeping denied copies pending and resumable', async () => {
      const { owner, input } = await setup();
      const revoke = () =>
        f.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${owner.organizationId} and user_id=${owner.actor.id}`;
      const restore = () =>
        f.db`update allrice_organization_people set content_maintenance_level='company' where organization_id=${owner.organizationId} and user_id=${owner.actor.id}`;
      await expect(
        save(
          owner,
          input,
          storageWith({
            get: async (o) => {
              const stream = await storage.get(o);
              await revoke();
              return stream;
            },
          }),
        ),
      ).rejects.toThrow('authorization_denied');
      const [none] =
        await f.db`select count(*)::int n from allrice_knowledge_revisions where source_artifact_version_id=${input.artifactVersionId}`;
      expect(none!.n).toBe(0);
      await restore();
      await expect(
        save(
          owner,
          input,
          storageWith({
            put: async (o, s) => {
              await storage.put(o, s);
              await revoke();
            },
          }),
        ),
      ).rejects.toThrow('not_found');
      const [pending] =
        await f.db`select r.id,o.state from allrice_knowledge_revisions r join allrice_storage_objects o on o.id=r.file_object_id where r.source_artifact_version_id=${input.artifactVersionId}`;
      expect(pending!.state).toBe('pending');
      await expect(file(owner, pending!.id)).rejects.toThrow('not_found');
      await restore();
      expect((await save(owner, input)).revisionId).toBe(pending!.id);
    });
    it('rechecks original source after read and copy without converting a vanished file to a successful reference', async () => {
      const { owner, input } = await setup();
      const setSource = (state: 'ready' | 'pending') =>
        f.db`update allrice_storage_objects set retention_until=${state === 'ready' ? f.db`null` : f.db`clock_timestamp()`} where id=(select object_id from allrice_deliverable_versions where id=${input.artifactVersionId})`;
      await expect(
        save(
          owner,
          input,
          storageWith({
            get: async (o) => {
              const s = await storage.get(o);
              await setSource('pending');
              return s;
            },
          }),
        ),
      ).rejects.toThrow('source_unavailable');
      await setSource('ready');
      await expect(
        save(
          owner,
          input,
          storageWith({
            put: async (o, s) => {
              await storage.put(o, s);
              await setSource('pending');
            },
          }),
        ),
      ).rejects.toThrow('source_unavailable');
      await setSource('ready');
      const recovered = await save(owner, input);
      expect((await file(owner, recovered.revisionId)).object.checksum).toBe(
        (
          await getWorkbenchArtifact(
            owner,
            (
              await f.db`select session_id from allrice_deliverable_versions where id=${input.artifactVersionId}`
            )[0]!.session_id,
            input.artifactVersionId,
            f.db,
          )
        ).object.checksum,
      );
    });
    it('resumes the same object after a storage response loss and rejects corrupted bytes before reservation', async () => {
      const { owner, input } = await setup();
      await expect(
        save(
          owner,
          input,
          storageWith({ get: async () => new Blob(['corrupt']).stream() }),
        ),
      ).rejects.toThrow('content_changed');
      let copied: string | undefined;
      await expect(
        save(
          owner,
          input,
          storageWith({
            put: async (o, s) => {
              copied = o.id;
              await storage.put(o, s);
              throw Error('lost storage acknowledgement');
            },
          }),
        ),
      ).rejects.toThrow('lost storage acknowledgement');
      const result = await save(owner, input);
      expect((await file(owner, result.revisionId)).object.id).toBe(copied);
      const [count] =
        await f.db`select count(*)::int n from allrice_knowledge_revisions where source_artifact_version_id=${input.artifactVersionId}`;
      expect(count!.n).toBe(1);
    });
    it('rejects foreign, tooling and non-root outputs, and never accepts client object paths or platform targets', async () => {
      const { a, owner, input } = await setup();
      const foreign = await setup();
      await expect(
        save(foreign.owner, {
          ...input,
          workspaceId: foreign.owner.workspaceId,
        }),
      ).rejects.toThrow('source_unavailable');
      for (const extra of [
        { scope: 'platform' },
        { objectKey: 'private/path' },
        { ownerId: owner.actor.id },
      ])
        await expect(save(owner, { ...input, ...extra })).rejects.toThrow();
      for (const [kind, provenance] of [
        ['command_output', 'tool_result'],
        ['document', 'project_snapshot'],
      ] as const) {
        const objectId = randomUUID(),
          versionId = randomUUID();
        await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
          select ${objectId},organization_id,workspace_id,owner_id,replace(object_key,id::text,${objectId}),'artifacts',media_type,size_bytes,checksum,'ready',true
          from allrice_storage_objects where id=(select object_id from allrice_deliverable_versions where id=${input.artifactVersionId})`;
        await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
          select ${versionId},organization_id,workspace_id,owner_id,${objectId},${randomUUID()},1,session_id,'not-business.txt','text' from allrice_deliverable_versions where id=${input.artifactVersionId}`;
        await f.db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
          select ${versionId},organization_id,workspace_id,owner_id,run_id,${kind},jsonb_set(provenance,'{kind}',${f.db.json(provenance!)}),${randomUUID()},request_digest
          from allrice_workbench_artifacts where version_id=${input.artifactVersionId}`;
        await expect(
          save(owner, {
            ...input,
            requestId: randomUUID(),
            artifactVersionId: versionId,
          }),
        ).rejects.toThrow('source_unavailable');
      }
      // A child tool's delivery has no root employee Run matching its owner/Session.
      const child = await a.delegate();
      const childArtifact = await a.createArtifact(child.instance.runId);
      await expect(
        save(owner, {
          ...input,
          requestId: randomUUID(),
          artifactVersionId: childArtifact.artifactId,
        }),
      ).rejects.toThrow('source_unavailable');
    });
  },
);
