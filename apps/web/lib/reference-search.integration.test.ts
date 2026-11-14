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
import { publishReference } from '../../../packages/database/src/reference-library.ts';
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
        warnings: [],
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
});
