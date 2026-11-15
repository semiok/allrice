import { legacyReferenceFixture } from './legacy-reference.fixture.ts';
import { POST as retiredSave } from '../../../apps/web/app/api/v1/references/artifacts/route';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, StoragePort } from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  createSession,
  authenticateSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import {
  changeReference,
  getReferenceFile,
  listReferenceRevisions,
  prepareReferenceUpload,
} from './reference-library.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'artifact reference publication: exact version, current authority and retry boundaries',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      storage: StoragePort;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      storage = runtimeFixtureStorage(f.db);
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
    const file = (owner: RequestContext, id: string) =>
      getReferenceFile(owner, owner.workspaceId!, id);
    async function legacy(
      owner: RequestContext,
      versionId: string,
      extra: Record<string, unknown> = {},
    ) {
      const [v] =
        await f.db`select d.*,o.media_type from allrice_deliverable_versions d
        join allrice_storage_objects o on o.id=d.object_id where d.id=${versionId}`;
      const original = await getWorkbenchArtifact(
        owner,
        v!.session_id,
        versionId,
        f.db,
      );
      const bytes = await readArtifactBytes(storage, original.object);
      const saved = await legacyReferenceFixture(
        owner,
        {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          scope: 'company',
          fileName: v!.file_name,
          purpose: 'PRE_R0_PURPOSE',
          mediaType: v!.media_type,
          contentBase64: bytes.toString('base64'),
          ...extra,
        },
        f.db,
        {
          versionId,
          snapshot: {
            fileName: v!.file_name,
            version: v!.version,
            checksum: original.object.checksum,
            sessionId: v!.session_id,
          },
        },
      );
      await storage.put(
        saved.object,
        new Blob([new Uint8Array(saved.bytes)]).stream(),
      );
      await f.db`update allrice_storage_objects set state='ready' where id=${saved.object.id}`;
      return saved;
    }
    async function post(context: RequestContext | null, input: unknown) {
      browser.context = context;
      return retiredSave(
        new Request('https://example.test/api/v1/references/artifacts', {
          method: 'POST',
          headers: {
            origin: 'https://example.test',
            host: 'example.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        }),
      );
    }
    async function counts(organizationId: string) {
      const [row] = await f.db`select
        (select count(*) from allrice_knowledge_sources where organization_id=${organizationId}) as sources,
        (select count(*) from allrice_knowledge_revisions where organization_id=${organizationId}) as revisions,
        (select count(*) from allrice_storage_objects where organization_id=${organizationId}) as objects,
        (select count(*) from allrice_knowledge_save_requests where organization_id=${organizationId}) as requests,
        (select count(*) from allrice_messages where organization_id=${organizationId}) as messages`;
      return row;
    }
    it('refuses retired artifact saves for every old target and concurrent alias without reading bytes or reserving a copy', async () => {
      const { owner, input } = await setup();
      const departmentId = randomUUID();
      await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name)
        values(${departmentId},${owner.organizationId},'Old target',${randomUUID()},'Old target')`;
      const before = await counts(owner.organizationId);
      const get = vi.spyOn(storage, 'get');
      try {
        for (const scope of ['personal', 'department', 'company', 'platform']) {
          const responses = await Promise.all(
            [input.requestId, randomUUID()].map((requestId) =>
              post(owner, {
                ...input,
                scope,
                requestId,
                ...(scope === 'department' ? { departmentId } : {}),
              }),
            ),
          );
          expect(responses.map((r) => r.status)).toEqual([404, 404]);
          for (const response of responses)
            expect(await response.text()).not.toContain(
              'CLIENT_PATH_MUST_NOT_BE_USED',
            );
        }
        expect(
          (
            await post(owner, {
              ...input,
              objectKey: 'CLIENT_PATH_MUST_NOT_BE_USED',
            })
          ).status,
        ).toBe(404);
        expect(get).not.toHaveBeenCalled();
        expect(await counts(owner.organizationId)).toEqual(before);
        expect((await post(null, input)).status).toBe(401);
      } finally {
        get.mockRestore();
      }
    });
    it('does not reexecute a historical artifact receipt or change retained purpose, digest and object identity', async () => {
      const { owner, input } = await setup();
      const saved = await legacy(owner, input.artifactVersionId);
      await f.db`insert into allrice_knowledge_save_requests(organization_id,actor_id,request_id,operation,input,revision_id)
        values(${owner.organizationId},${owner.actor.id},${input.requestId},'artifact',${f.db.json(input)},${saved.revisionId})`;
      const before =
        await f.db`select description,checksum,request_input,file_object_id from allrice_knowledge_revisions where id=${saved.revisionId}`;
      const beforeCounts = await counts(owner.organizationId);
      for (const request of [
        input,
        { ...input, requestId: randomUUID() },
        { ...input, purpose: 'replacement' },
      ])
        expect((await post(owner, request)).status).toBe(404);
      expect(
        await f.db`select description,checksum,request_input,file_object_id from allrice_knowledge_revisions where id=${saved.revisionId}`,
      ).toEqual(before);
      expect(await counts(owner.organizationId)).toEqual(beforeCounts);
      expect((await file(owner, saved.revisionId)).object.id).toBe(
        saved.object.id,
      );
      expect(await readArtifactBytes(storage, saved.object)).toEqual(
        saved.bytes,
      );
    });
    it('keeps exact historical artifact versions separate and rejects the retired manual version update', async () => {
      const { a, owner, input } = await setup();
      const first = await legacy(owner, input.artifactVersionId);
      const secondArtifact = await a.createArtifact(
        a.task.runId,
        'Corrected v2 amount 125',
      );
      await f.db`update allrice_deliverable_versions set series_id=(select series_id from allrice_deliverable_versions where id=${input.artifactVersionId}),version=2,parent_version_id=${input.artifactVersionId} where id=${secondArtifact.artifactId}`;
      const second = await legacy(owner, secondArtifact.artifactId);
      expect(second.sourceId).not.toBe(first.sourceId);
      expect((await file(owner, first.revisionId)).object.checksum).toBe(
        a.artifact.digest,
      );
      expect((await file(owner, second.revisionId)).object.checksum).toBe(
        secondArtifact.digest,
      );
      await expect(
        prepareReferenceUpload(owner, {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          sourceId: first.sourceId,
          expectedRevision: 1,
          scope: 'company',
          fileName: 'manual.txt',
          mediaType: 'text/plain',
          contentBase64: Buffer.from('manual v2').toString('base64'),
        }),
      ).rejects.toThrow('authorization_denied');
      await expect(
        f.db`update allrice_knowledge_revisions set artifact_snapshot='{}' where id=${first.revisionId}`,
      ).rejects.toThrow('Reference revision is immutable');
      const json = JSON.stringify(
        await listReferenceRevisions(owner, owner.workspaceId!),
      );
      expect(json).not.toContain(a.task.chatSessionId!);
      expect(json).not.toContain(
        (await file(owner, first.revisionId)).object.key,
      );
    });
    it('uses the original owner for an unbound old artifact source even when another member created the company copy', async () => {
      const { owner, reader, input } = await setup();
      await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${owner.organizationId},${owner.workspaceId},${reader.actor.id},'member') on conflict do nothing`;
      const creator = (await authenticateSession(
        (await createSession(reader.actor.id)).token,
        {
          organizationId: owner.organizationId,
          workspaceId: owner.workspaceId!,
        },
      ))!;
      const original = await getWorkbenchArtifact(
        owner,
        (
          await f.db`select session_id from allrice_deliverable_versions where id=${input.artifactVersionId}`
        )[0]!.session_id,
        input.artifactVersionId,
        f.db,
      );
      const bytes = await readArtifactBytes(storage, original.object);
      const saved = await legacyReferenceFixture(
        creator,
        {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          scope: 'company',
          fileName: 'old shared.txt',
          mediaType: 'text/plain',
          contentBase64: bytes.toString('base64'),
        },
        f.db,
        {
          versionId: input.artifactVersionId,
          snapshot: {
            fileName: original.version.fileName,
            version: original.version.version,
            checksum: original.object.checksum,
          },
        },
      );
      await storage.put(
        saved.object,
        new Blob([new Uint8Array(saved.bytes)]).stream(),
      );
      await f.db`update allrice_storage_objects set state='ready' where id=${saved.object.id}`;
      expect(
        await f.db`select source_id from allrice_workbench_reference_bindings where source_id=${saved.sourceId}`,
      ).toHaveLength(0);
      expect((await file(owner, saved.revisionId)).object.checksum).toBe(
        original.object.checksum,
      );
      await expect(file(creator, saved.revisionId)).rejects.toThrow(
        'not_found',
      );
      await expect(file(reader, saved.revisionId)).rejects.toThrow('not_found');
      expect(
        await listReferenceRevisions(
          creator,
          creator.workspaceId!,
          saved.sourceId,
        ),
      ).toEqual([]);
    });
    it('honors an exact old policy-source origin without treating independent company sources as originals', async () => {
      const { a, owner, reader, input } = await setup();
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        input.artifactVersionId,
        f.db,
      );
      const saved = await legacyReferenceFixture(
        owner,
        {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          scope: 'company',
          fileName: 'independent.txt',
          mediaType: 'text/plain',
          contentBase64: Buffer.from('INDEPENDENT_RESOURCE').toString('base64'),
        },
        f.db,
      );
      await storage.put(
        saved.object,
        new Blob([new Uint8Array(saved.bytes)]).stream(),
      );
      await f.db`update allrice_storage_objects set state='ready' where id=${saved.object.id}`;
      expect((await file(reader, saved.revisionId)).object.id).toBe(
        saved.object.id,
      );
      await f.db`insert into allrice_workbench_file_policies(object_id,organization_id,workspace_id,owner_id,file_name,scope,reference_source_id)
        values(${original.object.id},${owner.organizationId},${owner.workspaceId},${owner.actor.id},'old original.txt','company',${saved.sourceId})`;
      expect(
        await f.db`select source_id from allrice_workbench_reference_bindings where source_id=${saved.sourceId}`,
      ).toHaveLength(0);
      expect((await file(owner, saved.revisionId)).object.id).toBe(
        saved.object.id,
      );
      await expect(file(reader, saved.revisionId)).rejects.toThrow('not_found');
      expect(
        await listReferenceRevisions(
          reader,
          reader.workspaceId!,
          saved.sourceId,
        ),
      ).toEqual([]);
      await f.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${original.object.id}`;
      expect(
        await readArtifactBytes(
          storage,
          (await file(owner, saved.revisionId)).object,
        ),
      ).toEqual(saved.bytes);
    });
    it('keeps the owner retained lifetime across original archive/deletion, while current identity and archive still gate new reads', async () => {
      const { a, owner, reader, input } = await setup();
      const saved = await legacy(owner, input.artifactVersionId, {
        scope: 'personal',
      });
      const original = await getWorkbenchArtifact(
        owner,
        a.task.chatSessionId!,
        input.artifactVersionId,
        f.db,
      );
      const before = await counts(owner.organizationId);
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${a.task.chatSessionId}`;
      await f.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${original.object.id}`;
      await unlink(join(f.storageRoot, original.object.key));
      expect(
        await readArtifactBytes(
          storage,
          (await file(owner, saved.revisionId)).object,
        ),
      ).toEqual(saved.bytes);
      await expect(file(reader, saved.revisionId)).rejects.toThrow('not_found');
      await f.db`update allrice_users set status='disabled' where id=${owner.actor.id}`;
      await expect(file(owner, saved.revisionId)).rejects.toThrow('not_found');
      expect(await readArtifactBytes(storage, saved.object)).toEqual(
        saved.bytes,
      );
      await f.db`update allrice_users set status='active' where id=${owner.actor.id}`;
      await changeReference(owner, saved.sourceId, {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'archive',
      });
      await expect(file(owner, saved.revisionId)).rejects.toThrow('not_found');
      await expect(
        changeReference(owner, saved.sourceId, {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'restore',
        }),
      ).rejects.toThrow('source_unavailable');
      expect((await counts(owner.organizationId))!.messages).toBe(
        before!.messages,
      );
      expect(await readArtifactBytes(storage, saved.object)).toEqual(
        saved.bytes,
      );
    });
  },
);
