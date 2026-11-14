import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as database from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import {
  createSession,
  authenticateSession,
} from '../../../packages/database/src/identity.ts';
import {
  publishReference,
  changeReferencePublication,
} from '../../../packages/database/src/reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../../../packages/database/src/reference-processing.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('./identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('R3 publications HTTP search', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let owner: RequestContext;
  let sourceId: string;
  let revisionId: string;
  const prefix = '开篇资料。'.repeat(1000);
  const text = prefix + '差旅上限为九百元。';
  const warnings = ['图表数值来自文件内的完整缓存，未重新计算公式。'];
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(fixture.db);
    const base = await runFixture(fixture.db);
    owner = (await authenticateSession(
      (await createSession(base.context.actor.id)).token,
      {
        organizationId: base.context.organizationId,
        workspaceId: base.context.workspaceId!,
      },
    ))!;
    browser.context = owner;
    const saved = await publishReference(
      owner,
      {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        origin: 'upload',
        fileName: '差旅手册.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(text).toString('base64'),
        audience: { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(fixture.db),
    );
    sourceId = saved.sourceId;
    revisionId = saved.revisionId;
    const claim = await claimReferenceProcessing();
    expect(claim?.revisionId).toBe(revisionId);
    await finishReferenceProcessing(
      claim!,
      [{ content: text.slice(0, 1000), start: 0, end: 1000 }],
      {
        kind: 'text',
        text,
        units: [{ label: '完整正文', start: 0, end: text.length }],
        warnings,
      },
    );
  }, 120000);
  afterAll(async () => {
    browser.context = null;
    vi.restoreAllMocks();
    await fixture?.close();
  }, 30000);
  async function get(params: Record<string, string> = {}) {
    const { GET } =
      await import('../app/api/v1/references/publications/route.ts');
    return GET(
      new Request(
        'https://example.test/api/v1/references/publications?' +
          new URLSearchParams({ workspaceId: owner.workspaceId!, ...params }),
      ),
    );
  }
  it('“查企业资料里的差旅上限” returns the actual tail, exact pin, viewer and locator', async () => {
    const response = await get({
      query: '差旅上限',
      category: 'company',
      limit: '1',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.viewerId).toBe(owner.actor.id);
    expect(body.references).toHaveLength(1);
    expect(body.references[0]).toMatchObject({
      sourceId,
      revisionId,
      fullTextReady: true,
    });
    expect(body.matches).toEqual([
      {
        revisionId,
        content: '差旅上限为九百元。',
        start: prefix.length,
        end: text.length,
        locations: [{ unit: 0, label: '完整正文', start: 0, end: text.length }],
        warnings,
      },
    ]);
    expect(body.fullTextCoverage).toEqual({ ready: 1, unavailable: 0 });
    expect(body.nextCursor).toBeNull();
    expect(body.options).toHaveProperty('departments');
  });
  it('retains the original unpaginated response for callers without search parameters', async () => {
    const response = await get({ sourceId });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      'options',
      'references',
      'viewerId',
    ]);
    expect(body.references[0].revisionId).toBe(revisionId);
  });
  it('rejects malformed pagination and a caller-selected foreign workspace', async () => {
    for (const parameters of [
      { limit: '0' },
      { limit: 'bad' },
      { cursor: '{}' },
      { cursor: '{broken' },
      { category: 'admin' },
    ]) {
      const response = await get({ query: '差旅', ...parameters });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(sourceId);
    }
    expect(
      (await get({ query: '差旅', workspaceId: randomUUID() })).status,
    ).toBe(403);
  });

  it.each(['excerpt', 'coverage', 'derivation'] as const)(
    'rejects %s changed after text preparation through the real GET without creating a Run or read receipt',
    async (loss) => {
      const readerId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash)
        values(${readerId},${readerId + '@example.test'},'Reader','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${owner.organizationId},${owner.workspaceId},${readerId},'member')`;
      const reader = (await authenticateSession(
        (await createSession(readerId)).token,
        {
          organizationId: owner.organizationId,
          workspaceId: owner.workspaceId!,
        },
      ))!;
      const query = '只读同步-' + loss;
      const retainedText = query + '：必须撤权保护的正文';
      const publish = (fileName: string, content: string) =>
        publishReference(
          owner,
          {
            workspaceId: owner.workspaceId,
            requestId: randomUUID(),
            origin: 'upload',
            fileName,
            mediaType: 'text/plain',
            contentBase64: Buffer.from(content).toString('base64'),
            audience: { scope: 'company', departmentIds: [] },
          },
          runtimeFixtureStorage(fixture.db),
        );
      const excerpt = await publish('命中资料-' + loss + '.txt', retainedText);
      await fixture.db`update allrice_knowledge_processing set updated_at='2000-01-01' where revision_id=${excerpt.revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(excerpt.revisionId);
      await finishReferenceProcessing(
        claim!,
        [{ content: retainedText, start: 0, end: retainedText.length }],
        {
          kind: 'text',
          text: retainedText,
          units: [{ label: '正文', start: 0, end: retainedText.length }],
          warnings,
        },
      );
      const target =
        loss === 'coverage'
          ? await publish('只计覆盖的保密资料.txt', '尚未处理且不命中')
          : excerpt;
      const bookkeeping = () => fixture.db`select
        (select count(*)::int from allrice_runs) as runs,
        (select coalesce(sum(jsonb_array_length(coalesce(reference_reads,'[]'::jsonb))),0)::int from allrice_employee_runs) as reads`;
      const before = await bookkeeping();
      const prepared = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      // Pause after the actual document SELECT resolves, not in a mocked ACL.
      // Wrapping the SQL boundary also exercises the old implementation, where
      // prepareReferenceText is called internally and cannot be module-spied.
      const intercepted = new Proxy(fixture.db, {
        apply(targetSql, receiver, args) {
          const result = Reflect.apply(targetSql, receiver, args);
          if (
            Array.isArray(args[0]) &&
            args[0].join('').includes('d.xmin::text as version') &&
            args.includes(excerpt.revisionId)
          )
            return Promise.resolve(result).then(async (rows) => {
              prepared.resolve();
              await release.promise;
              return rows;
            });
          return result;
        },
      });
      vi.mocked(database.getDatabase).mockReturnValue(intercepted);
      browser.context = reader;
      const pending = get({ query });
      try {
        await Promise.race([
          prepared.promise,
          pending.then(() => {
            throw new Error('GET completed before text barrier');
          }),
        ]);
        if (loss === 'derivation')
          await fixture.db`update allrice_knowledge_documents set full_text=full_text||' changed' where knowledge_revision_id=${target.revisionId}`;
        else
          await changeReferencePublication(owner, target.sourceId, {
            workspaceId: owner.workspaceId,
            requestId: randomUUID(),
            expectedRevision: 1,
            action: 'audience',
            audience: { scope: 'personal', departmentIds: [] },
          });
        // This commit must finish before releasing the reader; full-text work
        // must never hold the publication/identity locks needed by revocation.
        release.resolve();
        const response = await pending;
        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).not.toContain(retainedText);
        expect(body).not.toContain(target.sourceId);
        expect(body).not.toContain('fullTextCoverage');
        expect(await bookkeeping()).toEqual(before);
      } finally {
        release.resolve();
        await pending;
        vi.mocked(database.getDatabase).mockReturnValue(fixture.db);
        browser.context = owner;
      }
    },
    30000,
  );
});
