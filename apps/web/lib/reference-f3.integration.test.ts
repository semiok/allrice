import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ReferenceSaveResultSchema,
  WorkbenchDeliverablesCatalogSchema,
  SessionReferenceEligibilitySchema,
  StorageObjectSchema,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import { SignedAccessService } from '@allrice/storage';
import * as client from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
  runtimeTaskFixture,
} from '../../../packages/database/src/runtime.fixture.ts';
import { tenantValidationFixture } from '../../../packages/database/src/tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../../../packages/database/src/identity.ts';
import { allocateWorkbenchFileName } from '../../../packages/database/src/workbench-file-name.ts';
import { lockWorkspaceStorageQuota } from '../../../packages/database/src/core/storage-quota.ts';
import {
  assertReferenceSelections,
  captureReferenceSelections,
  retrieveSelectedReferenceKnowledge,
} from '../../../packages/database/src/reference-runtime.ts';
import {
  claimReferenceProcessing,
  failReferenceProcessing,
  finishReferenceProcessing,
} from '../../../packages/database/src/reference-processing.ts';
import { readArtifactBytes } from '../../../packages/database/src/artifact-review.ts';
import { getRequestContext } from './identity/session';
import { resolvePortal } from './portal/config';
import { createPortalSession } from './portal/session';
import { POST as createFile } from '../app/api/v1/files/route';
import { POST as signFile } from '../app/api/v1/files/[id]/sign/route';
import {
  GET as readSignedFile,
  DELETE as deleteFile,
} from '../app/api/v1/files/[id]/route';
import { GET as downloadOriginal } from '../app/api/v1/files/[id]/download/route';
import * as publications from '../app/api/v1/references/publications/route';
import { POST as changePublication } from '../app/api/v1/references/publications/[id]/route';
import { POST as retryReference } from '../app/api/v1/references/[id]/route';
import * as deliverables from '../app/api/v1/workbench/files/route';
import { GET as preview } from '../app/api/v1/references/revisions/[id]/preview/route';
import { GET as download } from '../app/api/v1/references/revisions/[id]/download/route';
import { GET as eligibility } from '../app/api/v1/sessions/[id]/reference-eligibility/route';

const browser = vi.hoisted(() => ({
  token: '',
  portalToken: '',
  storage: null as StoragePort | null,
  signer: null as SignedAccessService | null,
}));
// Only the Next cookie transport is substituted. Identity is authenticated in PostgreSQL.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) => {
      const value =
        key === 'allrice_session'
          ? browser.token
          : key === 'allrice_portal_session'
            ? browser.portalToken
            : '';
      return value ? { value } : undefined;
    },
  }),
}));
vi.mock('./storage/runtime', () => ({
  getStorageAdapter: () => browser.storage!,
  getSignedAccessService: () => browser.signer!,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('F3 backend facts through real browser session identity', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    browser.storage = runtimeFixtureStorage(f.db);
    browser.signer = new SignedAccessService(
      'r0-isolated-signing-secret-' + 'x'.repeat(32),
    );
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  }, 30000);

  async function login(userId: string, selection: RequestContext) {
    const workspaceId = selection.workspaceId;
    if (!workspaceId) throw Error('Fixture requires an exact workspace');
    const session = await createSession(userId);
    const context = (await authenticateSession(session.token, {
      organizationId: selection.organizationId,
      workspaceId,
    }))!;
    expect(context.actor.id).toBe(userId);
    browser.token = session.token;
    return { context, token: session.token };
  }
  async function setup() {
    const fixture = await tenantValidationFixture(f.db);
    return {
      ...fixture,
      ...(await login(fixture.context.actor.id, fixture.context)),
    };
  }
  async function colleague(context: RequestContext) {
    const [organization] =
      await f.db`select slug,name from allrice_organizations where id=${context.organizationId}`;
    const person = await ensureBootstrapPortalPrincipal({
      organizationSlug: organization!.slug,
      organizationName: organization!.name,
      workspaceSlug: 'test',
      workspaceName: 'P25 fixture',
      email: `${randomUUID()}@example.test`,
      displayName: 'Other actual browser user',
      role: 'member',
    });
    return login(person.user.id, context);
  }
  function request(
    context: RequestContext,
    path: string,
    input?: unknown,
    extra: Record<string, string> = {},
  ) {
    return new Request(`https://example.test/api/v1/${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        'content-type': 'application/json',
        'x-allrice-organization-id': context.organizationId,
        'x-allrice-workspace-id': context.workspaceId!,
        ...extra,
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  }
  const route = (id: string) => ({ params: Promise.resolve({ id }) });
  const audience = { scope: 'company', departmentIds: [] } as const;
  const upload = (context: RequestContext, fileName = '口径.txt') => ({
    workspaceId: context.workspaceId,
    requestId: randomUUID(),
    origin: 'upload',
    fileName,
    mediaType: 'text/plain',
    contentBase64:
      Buffer.from('完整正文：本期收入为九千元。').toString('base64'),
    audience,
  });
  async function publish(context: RequestContext, input: unknown) {
    const response = await publications.POST(
      request(context, 'references/publications', input),
    );
    expect(response.status).toBe(201);
    return ReferenceSaveResultSchema.parse(await response.json());
  }
  async function catalog(context: RequestContext, objectId: string) {
    const response = await deliverables.GET(
      request(
        context,
        `workbench/files?view=deliverables&objectId=${objectId}`,
      ),
    );
    expect(response.status).toBe(200);
    return WorkbenchDeliverablesCatalogSchema.parse(await response.json());
  }
  async function list(context: RequestContext, sourceId: string) {
    const response = await publications.GET(
      request(context, `references/publications?sourceId=${sourceId}`),
    );
    expect(response.status).toBe(200);
    return response.json();
  }
  async function processThrough(revisionId: string, fullText = true) {
    for (;;) {
      const claim = await claimReferenceProcessing();
      if (!claim) throw Error('Expected pending reference');
      const content = (
        await readArtifactBytes(browser.storage!, claim.object)
      ).toString();
      await finishReferenceProcessing(
        claim,
        [{ content, start: 0, end: content.length }],
        claim.revisionId !== revisionId || fullText
          ? {
              text: content,
              kind: 'text',
              units: [{ label: '正文', start: 0, end: content.length }],
              warnings: [],
            }
          : undefined,
      );
      if (claim.revisionId === revisionId) return;
    }
  }
  async function originalUpload(context: RequestContext) {
    const response = await deliverables.POST(
      request(context, 'workbench/files', {
        ...upload(context),
        origin: undefined,
        audience: undefined,
      }),
    );
    expect(response.status).toBe(201);
    return (await response.json()).objectId as string;
  }

  it('rejects a stale viewer on all reference writes before body parsing or any database/storage mutation', async () => {
    const a = await setup();
    const saved = await publish(a.context, upload(a.context));
    const b = await colleague(a.context);
    expect(
      await getRequestContext(request(a.context, 'references/publications')),
    ).toMatchObject({ actor: { id: b.context.actor.id } });
    expect(await list(b.context, saved.sourceId)).toMatchObject({
      viewerId: b.context.actor.id,
    });
    const counts = async () =>
      (
        await f.db`select
      (select count(*)::int from allrice_knowledge_sources) as sources,
      (select count(*)::int from allrice_knowledge_reference_actions) as actions,
      (select count(*)::int from allrice_storage_objects) as objects`
      )[0];
    const before = await counts();
    const put = vi.spyOn(browser.storage!, 'put');
    for (const [endpoint, handler] of [
      ['references/publications', (r: Request) => publications.POST(r)],
      [
        `references/publications/${saved.sourceId}`,
        (r: Request) => changePublication(r, route(saved.sourceId)),
      ],
      [
        `references/${saved.sourceId}`,
        (r: Request) => retryReference(r, route(saved.sourceId)),
      ],
    ] as const) {
      const r = request(
        b.context,
        endpoint,
        {},
        { 'x-allrice-expected-viewer-id': a.context.actor.id },
      );
      const json = vi.spyOn(r, 'json');
      const response = await handler(r);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('CONFLICT');
      expect(json).not.toHaveBeenCalled();
    }
    expect(await counts()).toEqual(before);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
    const own = await publish(b.context, upload(b.context));
    expect(
      (await list(b.context, own.sourceId)).references[0].publication
        .publisherId,
    ).toBe(b.context.actor.id);
    const spoof = await publications.POST(
      request(
        b.context,
        'references/publications',
        { ...upload(b.context), ownerId: a.context.actor.id },
        { 'x-allrice-expected-viewer-id': b.context.actor.id },
      ),
    );
    expect(spoof.status).toBe(400);
    await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${b.context.sessionId}`;
    expect(
      (await publications.GET(request(b.context, 'references/publications')))
        .status,
    ).toBe(401);
  });

  it('“把我刚上传的这份口径加入企业资料” proves the no-session upload and projects only my exact active publication', async () => {
    const a = await setup(),
      objectId = await originalUpload(a.context);
    expect(
      await f.db`select object_id from allrice_file_references where object_id=${objectId}`,
    ).toHaveLength(0);
    const [proof] =
      await f.db`select o.owner_id,o.organization_id,o.workspace_id,p.upload_request_id,p.upload_digest
      from allrice_storage_objects o join allrice_workbench_file_policies p on p.object_id=o.id where o.id=${objectId}`;
    expect(proof).toMatchObject({
      owner_id: a.context.actor.id,
      organization_id: a.context.organizationId,
      workspace_id: a.context.workspaceId,
    });
    expect(proof!.upload_request_id).toBeTruthy();
    expect(proof!.upload_digest).toMatch(/^sha256:/);
    const input = {
      workspaceId: a.context.workspaceId,
      requestId: randomUUID(),
      origin: 'file',
      objectId,
      audience,
    };
    const saved = await publish(a.context, input);
    expect(await catalog(a.context, objectId)).toMatchObject({
      viewerId: a.context.actor.id,
      files: [
        { canPublishReference: true, publication: { ...saved, audience } },
      ],
    });
    const changed = await changePublication(
      request(a.context, `references/publications/${saved.sourceId}`, {
        workspaceId: a.context.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'audience',
        audience: { scope: 'personal', departmentIds: [] },
      }),
      route(saved.sourceId),
    );
    expect(changed.status).toBe(200);
    expect(
      (await catalog(a.context, objectId)).files[0]!.publication?.audience
        .scope,
    ).toBe('personal');
    const b = await colleague(a.context);
    expect(
      (
        await deliverables.GET(
          request(
            b.context,
            `workbench/files?view=deliverables&objectId=${objectId}`,
          ),
        )
      ).status,
    ).toBe(404);
    browser.token = a.token;
    const visible = (await list(a.context, saved.sourceId)).references[0];
    expect(visible).not.toHaveProperty('originObjectId');
    expect(visible.publication).not.toHaveProperty('originObjectId');
    const withdrawal = await changePublication(
      request(a.context, `references/publications/${saved.sourceId}`, {
        workspaceId: a.context.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 2,
        action: 'revoke',
      }),
      route(saved.sourceId),
    );
    expect(withdrawal.status).toBe(200);
    expect(await publish(a.context, input)).toEqual(saved);
    expect(
      (await catalog(a.context, objectId)).files[0]!.publication,
    ).toBeNull();
    const replacement = await originalUpload(a.context);
    expect(
      (await catalog(a.context, replacement)).files[0]!.publication,
    ).toBeNull();
    const republished = await publish(a.context, {
      ...input,
      requestId: randomUUID(),
    });
    expect(republished.sourceId).not.toBe(saved.sourceId);
    expect(
      (await catalog(a.context, objectId)).files[0]!.publication?.sourceId,
    ).toBe(republished.sourceId);
    expect(
      (await catalog(a.context, replacement)).files[0]!.publication,
    ).toBeNull();
  });

  it('never infers upload provenance from ownership or shared readability, and rechecks it after reading bytes', async () => {
    const a = await setup(),
      objectId = await originalUpload(a.context);
    const input = {
      workspaceId: a.context.workspaceId,
      requestId: randomUUID(),
      origin: 'file',
      objectId,
      audience,
    };
    const [proof] =
      await f.db`select upload_request_id,upload_digest from allrice_workbench_file_policies where object_id=${objectId}`;
    await f.db`update allrice_workbench_file_policies set upload_request_id=null,upload_digest=null where object_id=${objectId}`;
    expect(
      (
        await publications.POST(
          request(a.context, 'references/publications', input),
        )
      ).status,
    ).toBe(409);
    await f.db`update allrice_workbench_file_policies set upload_request_id=${proof!.upload_request_id},upload_digest=${proof!.upload_digest},scope='company' where object_id=${objectId}`;
    const b = await colleague(a.context);
    expect(
      (
        await publications.POST(
          request(b.context, 'references/publications', {
            ...input,
            workspaceId: b.context.workspaceId,
          }),
        )
      ).status,
    ).toBe(409);
    browser.token = a.token;
    const get = browser.storage!.get.bind(browser.storage);
    const read = vi
      .spyOn(browser.storage!, 'get')
      .mockImplementation(async (object) => {
        const stream = await get(object);
        if (object.id === objectId)
          await f.db`update allrice_workbench_file_policies set upload_request_id=null,upload_digest=null where object_id=${objectId}`;
        return stream;
      });
    try {
      expect(
        (
          await publications.POST(
            request(a.context, 'references/publications', input),
          )
        ).status,
      ).toBe(409);
      expect(
        await f.db`select id from allrice_knowledge_sources where publication_origin_object_id=${objectId}`,
      ).toHaveLength(0);
    } finally {
      read.mockRestore();
    }
  });

  it('reports exact publication eligibility instead of equating it with maintenance or ownership', async () => {
    // This generic fixture creates its real Run/session, but no employee Run evidence.
    const fixture = await runtimeTaskFixture(f.db);
    const a = {
      ...fixture,
      ...(await login(fixture.context.actor.id, fixture.context)),
    };
    const delivery = await a.artifact(a.task.runId);
    const [artifact] =
      await f.db`select object_id from allrice_deliverable_versions where id=${delivery.artifactId}`;
    // Still an owned business directory entry, but its required Run provenance is absent.
    expect(
      await f.db`select run_id from allrice_employee_runs where run_id=${a.task.runId}`,
    ).toHaveLength(0);
    expect(
      (await catalog(a.context, artifact!.object_id)).files[0],
    ).toMatchObject({
      ownedByMe: true,
      canMaintain: true,
      canPublishReference: false,
    });
    const objectId = await originalUpload(a.context);
    expect(
      (await catalog(a.context, objectId)).files[0]!.canPublishReference,
    ).toBe(true);
    await f.db`update allrice_memberships set role='viewer' where user_id=${a.context.actor.id}`;
    expect((await catalog(a.context, objectId)).files[0]).toMatchObject({
      ownedByMe: true,
      canMaintain: false,
      canPublishReference: false,
    });
  });

  it('persists F2 final names through 255 UTF-16 units, exact receipt replay, preview, download and reference pins without widening upload inputs', async () => {
    const a = await setup();
    const requestedNames = [
      '长'.repeat(157) + '.txt',
      '📖'.repeat(125) + 'a.txt',
      '📖'.repeat(125) + 'a.txt',
    ];
    for (const requested of requestedNames) {
      const artifact = await a.createArtifact(
        a.task.runId,
        '长名称下的完整原件正文。',
      );
      const [origin] =
        await f.db`select object_id from allrice_deliverable_versions where id=${artifact.artifactId}`;
      const finalName = await f.db.begin(async (tx) => {
        await lockWorkspaceStorageQuota(
          tx,
          a.context.organizationId,
          a.context.workspaceId!,
        );
        const name = await allocateWorkbenchFileName(
          tx,
          {
            organizationId: a.context.organizationId,
            workspaceId: a.context.workspaceId!,
            ownerId: a.context.actor.id,
          },
          origin!.object_id,
          requested,
        );
        await tx`update allrice_deliverable_versions set file_name=${name} where id=${artifact.artifactId}`;
        return name;
      });
      const input = {
        workspaceId: a.context.workspaceId,
        requestId: randomUUID(),
        origin: 'file',
        objectId: origin!.object_id,
        audience,
      };
      const saved = await publish(a.context, input);
      expect(await publish(a.context, input)).toEqual(saved);
      const [persisted] =
        await f.db`select r.file_name,p.file_name as policy_name from allrice_knowledge_revisions r
        join allrice_workbench_file_policies p on p.object_id=r.file_object_id where r.id=${saved.revisionId}`;
      expect(persisted).toEqual({
        file_name: finalName,
        policy_name: finalName,
      });
      const read = request(
        a.context,
        `references/revisions/${saved.revisionId}/download?workspaceId=${a.context.workspaceId}`,
      );
      const downloaded = await download(read, route(saved.revisionId));
      expect(downloaded.status).toBe(200);
      expect(
        decodeURIComponent(
          downloaded.headers.get('content-disposition')!.split("UTF-8''")[1]!,
        ),
      ).toBe(finalName);
      expect(await downloaded.text()).toBe('长名称下的完整原件正文。');
      const viewed = await preview(
        request(
          a.context,
          `references/revisions/${saved.revisionId}/preview?workspaceId=${a.context.workspaceId}`,
        ),
        route(saved.revisionId),
      );
      expect(viewed.status).toBe(200);
      expect(await viewed.text()).toContain('长名称下的完整原件正文');
      await processThrough(saved.revisionId);
      const pins = await f.db.begin((tx) =>
        captureReferenceSelections(a.context, [saved.revisionId], tx),
      );
      expect(pins[0]!.fileName).toBe(finalName);
      await f.db.begin((tx) => assertReferenceSelections(a.context, pins, tx));
      const retrieved = await retrieveSelectedReferenceKnowledge({
        context: a.context,
        selections: pins,
        query: '完整原件正文',
      });
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!.content).toBe('长名称下的完整原件正文。');
      expect(retrieved[0]!.citation.reference).toEqual(pins[0]);
      const label = retrieved[0]!.citation.label;
      expect(label.length).toBeLessThanOrEqual(200);
      expect(Buffer.from(label).toString()).toBe(label);
      if (finalName.length > 195) expect(label).toContain('… · v1');
      else expect(label).toBe(`${finalName} · v1`);
      if (finalName !== requested) {
        expect(finalName).toHaveLength(255);
        expect(finalName).toContain('（2）');
      }
    }
    expect(
      (
        await publications.POST(
          request(
            a.context,
            'references/publications',
            upload(a.context, 'x'.repeat(161)),
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await deliverables.POST(
          request(a.context, 'workbench/files', {
            ...upload(a.context, 'x'.repeat(161)),
            origin: undefined,
            audience: undefined,
          }),
        )
      ).status,
    ).toBe(400);
  }, 120000);

  it('projects fullTextReady from exact derived facts and keeps same-origin publication-only retry and ready-backfill semantics', async () => {
    const a = await setup(),
      saved = await publish(a.context, upload(a.context));
    const current = async () =>
      (await list(a.context, saved.sourceId)).references[0];
    expect((await current()).fullTextReady).toBe(false);
    await processThrough(saved.revisionId, false);
    expect(await current()).toMatchObject({
      processing: 'ready',
      fullTextReady: false,
    });
    const claim = await claimReferenceProcessing(true);
    expect(claim?.revisionId).toBe(saved.revisionId);
    await failReferenceProcessing(claim!, 'Synthetic failed derived backfill');
    const action = {
      workspaceId: a.context.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      action: 'retry',
    };
    expect(
      (
        await retryReference(
          request(a.context, `references/${saved.sourceId}`, action, {
            origin: 'https://foreign.test',
          }),
          route(saved.sourceId),
        )
      ).status,
    ).toBe(403);
    const retried = await retryReference(
      request(a.context, `references/${saved.sourceId}`, action),
      route(saved.sourceId),
    );
    expect(retried.status).toBe(200);
    expect(await current()).toMatchObject({
      processing: 'ready',
      fullTextReady: false,
      failure: null,
    });
    const backfill = await claimReferenceProcessing(true);
    expect(backfill?.revisionId).toBe(saved.revisionId);
    const text = (
      await readArtifactBytes(browser.storage!, backfill!.object)
    ).toString();
    await finishReferenceProcessing(
      backfill!,
      [{ content: text, start: 0, end: text.length }],
      {
        text,
        kind: 'text',
        units: [{ label: '正文', start: 0, end: text.length }],
        warnings: [],
      },
    );
    expect((await current()).fullTextReady).toBe(true);
    const [document] =
      await f.db`select id,checksum,source_ref from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`;
    for (const mismatch of ['checksum', 'source_ref', 'active'] as const) {
      if (mismatch === 'checksum')
        await f.db`update allrice_knowledge_documents set checksum=${`sha256:${'0'.repeat(64)}`} where id=${document!.id}`;
      if (mismatch === 'source_ref')
        await f.db`update allrice_knowledge_documents set source_ref=${'file:' + randomUUID()} where id=${document!.id}`;
      if (mismatch === 'active')
        await f.db`update allrice_knowledge_documents set active=false where id=${document!.id}`;
      expect((await current()).fullTextReady).toBe(false);
      await f.db`update allrice_knowledge_documents set checksum=${document!.checksum},source_ref=${document!.source_ref},active=true where id=${document!.id}`;
    }
    expect(
      (
        await retryReference(
          request(a.context, `references/${saved.sourceId}`, {
            ...action,
            requestId: randomUUID(),
            action: 'archive',
          }),
          route(saved.sourceId),
        )
      ).status,
    ).toBe(409);
    expect((await current()).fullTextReady).toBe(true);
  });

  it('reports empty-history reference eligibility only to the real current owner in its exact workspace', async () => {
    const a = await setup(),
      sessionId = a.task.chatSessionId!;
    const path = `sessions/${sessionId}/reference-eligibility?workspaceId=${a.context.workspaceId}`;
    const response = await eligibility(
      request(a.context, path),
      route(sessionId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(
      SessionReferenceEligibilitySchema.parse(await response.json()),
    ).toEqual({
      viewerId: a.context.actor.id,
      sessionId,
      referenceEligibility: { canContinue: true, reason: null },
    });
    const b = await colleague(a.context);
    expect(
      (await eligibility(request(b.context, path), route(sessionId))).status,
    ).toBe(404);
    const foreign = await setup();
    expect(
      (await eligibility(request(foreign.context, path), route(sessionId)))
        .status,
    ).toBe(403);
    browser.token = a.token;
    await f.db`update allrice_memberships set active=false where user_id=${a.context.actor.id}`;
    expect(
      (await eligibility(request(a.context, path), route(sessionId))).status,
    ).toBe(403);
    // Actual login expiry, distinct from a live login whose membership was withdrawn.
    await f.db`update allrice_sessions set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second'
      where id=${a.context.sessionId}`;
    expect(
      (await eligibility(request(a.context, path), route(sessionId))).status,
    ).toBe(401);
  });

  // Use the real upload/sign/read handlers, signer, session resolver and PG grants.
  // Only Next's cookie accessor and the isolated storage location are adapted.
  async function signedOriginal(
    context: RequestContext,
    category: 'uploads' | 'memory' = 'uploads',
  ) {
    const content = `R0 exact original bytes ${randomUUID()}`;
    const created = await createFile(
      request(context, 'files', {
        workspaceId: context.workspaceId,
        category,
        visibility: 'organization',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(content).toString('base64'),
      }),
    );
    expect(created.status).toBe(201);
    const object = StorageObjectSchema.parse(
      (await created.json()).file.object,
    );
    expect(object.ownerId).toBe(context.actor.id);
    expect(object.key).toContain(`/${category}/${object.id}`);
    expect(
      await f.db`select object_id from allrice_workbench_file_policies where object_id=${object.id}`,
    ).toHaveLength(0);
    const signed = await signFile(
      request(context, `files/${object.id}/sign`, { lifetimeSeconds: 60 }),
      route(object.id),
    );
    expect(signed.status).toBe(200);
    const { url } = (await signed.json()) as { url: string };
    expect(new URL(url, 'https://allrice.bplabs.xyz').pathname).toBe(
      `/api/v1/files/${object.id}`,
    );
    return { objectId: object.id, url, content };
  }
  function signedRequest(url: string, host = 'allrice.bplabs.xyz') {
    // Image fetches and preview/download anchors send cookies without tenant headers.
    return new Request(new URL(url, `https://${host}`), { headers: { host } });
  }
  async function expectSignedBytes(
    file: Awaited<ReturnType<typeof signedOriginal>>,
    host?: string,
  ) {
    const req = signedRequest(file.url, host);
    expect(req.headers.get('x-allrice-organization-id')).toBeNull();
    expect(req.headers.get('x-allrice-workspace-id')).toBeNull();
    const response = await readSignedFile(req, route(file.objectId));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe(file.content);
  }
  async function expectSignedDenied(
    file: Awaited<ReturnType<typeof signedOriginal>>,
    status: number,
    host?: string,
  ) {
    const get = vi.spyOn(browser.storage!, 'get');
    try {
      const response = await readSignedFile(
        signedRequest(file.url, host),
        route(file.objectId),
      );
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(file.content);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  }
  async function additionalScope(context: RequestContext, sameOrg = false) {
    const organizationId = sameOrg ? context.organizationId : randomUUID(),
      workspaceId = randomUUID();
    if (!sameOrg)
      await f.db`insert into allrice_organizations(id,slug,name)
        values(${organizationId},${`r0-${organizationId}`},'R0 isolated scope')`;
    await f.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${workspaceId},${organizationId},${`r0-${workspaceId}`},'R0 second workspace')`;
    await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
      values(${organizationId},${workspaceId},${context.actor.id},'member')`;
    const selected = await authenticateSession(browser.token, {
      organizationId,
      workspaceId,
    });
    expect(selected).toMatchObject({
      actor: context.actor,
      organizationId,
      workspaceId,
    });
    return selected!;
  }

  it.each(['uploads', 'memory'] as const)(
    'R0: an owner can open an ordinary %s upload without scope headers, but a colleague or anonymous visitor cannot borrow its signed URL',
    async (category) => {
      const a = await setup(),
        file = await signedOriginal(a.context, category);
      await expectSignedBytes(file);
      const b = await colleague(a.context);
      const deniedSign = await signFile(
        request(b.context, `files/${file.objectId}/sign`, {}),
        route(file.objectId),
      );
      expect(deniedSign.status).toBe(403);
      await expectSignedDenied(file, 403);
      browser.token = '';
      await expectSignedDenied(file, 401);
      browser.token = a.token;
      await expectSignedBytes(file);
    },
  );

  it.each(['session', 'membership'] as const)(
    'R0: withdrawing the current %s after signing denies the same URL before any original bytes are read',
    async (withdrawn) => {
      const a = await setup(),
        file = await signedOriginal(a.context);
      await expectSignedBytes(file);
      if (withdrawn === 'session')
        await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${a.context.sessionId}`;
      else
        await f.db`update allrice_memberships set active=false
          where user_id=${a.context.actor.id} and organization_id=${a.context.organizationId}`;
      await expectSignedDenied(file, withdrawn === 'session' ? 401 : 403);
    },
  );

  it('R0: a multi-organization owner opens exact original bytes in a non-default organization/workspace without scope headers', async () => {
    const a = await setup(),
      target = await additionalScope(a.context),
      file = await signedOriginal(target);
    expect(
      await getRequestContext(signedRequest('/api/v1/auth/session')),
    ).toMatchObject({
      actor: a.context.actor,
      organizationId: a.context.organizationId,
      workspaceId: null,
    });
    expect(target.organizationId).not.toBe(a.context.organizationId);
    expect(target.workspaceId).not.toBe(a.context.workspaceId);
    await expectSignedBytes(file);
  });

  it('R0: a dedicated portal requires both real cookies and its exact host, organization and workspace when consuming a signed URL', async () => {
    const a = await setup(),
      own = await signedOriginal(a.context),
      otherOrg = await signedOriginal(await additionalScope(a.context)),
      otherWorkspace = await signedOriginal(
        await additionalScope(a.context, true),
      ),
      host = 'allrice-snow.bplabs.xyz',
      portal = resolvePortal(host)!;
    vi.stubEnv(
      'ALLRICE_PORTAL_SESSION_SECRET',
      'r0-isolated-portal-secret-' + 'x'.repeat(32),
    );
    const cookie = createPortalSession({
      portal,
      subject: a.context.actor.id,
      organizationId: a.context.organizationId,
      workspaceId: a.context.workspaceId!,
    }).value;
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '1');
    browser.portalToken = cookie;
    try {
      await expectSignedBytes(own, host);
      await expectSignedDenied(otherOrg, 401, host);
      await expectSignedDenied(otherWorkspace, 401, host);
      await expectSignedDenied(own, 401, 'allrice-drink.bplabs.xyz');
      browser.portalToken = '';
      await expectSignedDenied(own, 401, host);
      browser.portalToken = cookie;
      browser.token = '';
      await expectSignedDenied(own, 401, host);
      browser.token = a.token;
      await expectSignedBytes(own, host);
    } finally {
      browser.portalToken = '';
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
    }
  });

  it('R0: the owner cannot delete a delivery or its published copy through ordinary file DELETE, while ordinary uploads remain deletable', async () => {
    const a = await setup(),
      content = '交付原件与企业资料固定副本均须保留。',
      delivery = await a.createArtifact(a.task.runId, content);
    const [original] =
      await f.db`select object_id from allrice_deliverable_versions where id=${delivery.artifactId}`;
    const objectId = original!.object_id as string;
    const saved = await publish(a.context, {
      workspaceId: a.context.workspaceId,
      requestId: randomUUID(),
      origin: 'file',
      objectId,
      audience,
    });
    const [copy] =
      await f.db`select file_object_id from allrice_knowledge_revisions where id=${saved.revisionId}`;
    expect(copy!.file_object_id).not.toBe(objectId);
    const records = () =>
      Promise.all([
        f.db`select * from allrice_storage_objects where id in (${objectId},${copy!.file_object_id}) order by id`,
        f.db`select * from allrice_deliverable_versions where id=${delivery.artifactId}`,
        f.db`select * from allrice_workbench_artifacts where version_id=${delivery.artifactId}`,
        f.db`select * from allrice_knowledge_sources where id=${saved.sourceId}`,
        f.db`select * from allrice_knowledge_revisions where id=${saved.revisionId}`,
      ]);
    const readBoth = async () => {
      const responses = await Promise.all([
        downloadOriginal(
          request(a.context, `files/${objectId}/download`),
          route(objectId),
        ),
        download(
          request(
            a.context,
            `references/revisions/${saved.revisionId}/download?workspaceId=${a.context.workspaceId}`,
          ),
          route(saved.revisionId),
        ),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(content);
      }
    };
    await readBoth();
    const before = await records();
    expect(before.map((rows) => rows.length)).toEqual([2, 1, 1, 1, 1]);
    const remove = vi.spyOn(browser.storage!, 'delete');
    try {
      // v30:176: neither delivery originals nor retained copies use this delete path.
      for (const protectedId of [objectId, copy!.file_object_id as string]) {
        const response = await deleteFile(
          new Request(request(a.context, `files/${protectedId}`), {
            method: 'DELETE',
          }),
          route(protectedId),
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
      }
      expect(remove).not.toHaveBeenCalled();
      expect(await records()).toEqual(before);
      await readBoth();
      const upload = await signedOriginal(a.context);
      const deleted = await deleteFile(
        new Request(request(a.context, `files/${upload.objectId}`), {
          method: 'DELETE',
        }),
        route(upload.objectId),
      );
      expect(deleted.status).toBe(204);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0].id).toBe(upload.objectId);
      const [state] =
        await f.db`select state,deleted_at from allrice_storage_objects where id=${upload.objectId}`;
      expect(state!.state).toBe('deleted');
      expect(state!.deleted_at).not.toBeNull();
      expect(await records()).toEqual(before);
    } finally {
      remove.mockRestore();
    }
  });
});
