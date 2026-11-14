import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RequestContext, ReferenceAudience } from '@allrice/contracts';
import * as database from './core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runFixture,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { createSession, authenticateSession } from './identity.ts';
import {
  publishReference,
  changeReferencePublication,
  listReferencePublications,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from './reference-processing.ts';
import {
  queryReferencePublications,
  prepareReferenceText,
  prepareReferenceSearch,
  referenceReadPin,
  referenceTextPage,
  referenceTextCitation,
} from './reference-search.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('R3 publication search uses complete text and current readers', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let owner: RequestContext;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
  }, 120000);
  beforeEach(async () => {
    const fixture = await runFixture(f.db);
    const login = await createSession(fixture.context.actor.id);
    owner = (await authenticateSession(login.token, {
      organizationId: fixture.context.organizationId,
      workspaceId: fixture.context.workspaceId!,
    }))!;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  }, 30000);

  async function member(departmentId: string | null = null) {
    const userId = randomUUID();
    await f.db`insert into allrice_users(id,email,display_name,password_hash)
      values(${userId},${userId + '@example.test'},'Reader','not-login')`;
    await f.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
      values(${randomUUID()},${owner.organizationId},${owner.workspaceId!},${userId},'member')`;
    await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,department_id)
      values(${owner.organizationId},${userId},'Reader',${departmentId})`;
    const login = await createSession(userId);
    return (await authenticateSession(login.token, {
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId!,
    }))!;
  }
  async function publish(
    text: string,
    options: {
      fileName?: string;
      audience?: ReferenceAudience;
      ready?: boolean;
      fullText?: boolean;
      units?: {
        label: string;
        start: number;
        end: number;
        pageNumber?: number;
        sheetName?: string;
      }[];
    } = {},
  ) {
    const saved = await publishReference(
      owner,
      {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        origin: 'upload',
        fileName: options.fileName ?? '企业政策.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(text).toString('base64'),
        audience: options.audience ?? { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(f.db),
    );
    if (options.ready !== false) {
      // Claim only this publication; other tests may intentionally leave a
      // saved item. No parser or authorization boundary is mocked.
      await f.db`update allrice_knowledge_processing set updated_at='2000-01-01' where revision_id=${saved.revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(saved.revisionId);
      await finishReferenceProcessing(
        claim!,
        [
          {
            content: text.slice(0, 1000),
            start: 0,
            end: Math.min(text.length, 1000),
          },
        ],
        options.fullText === false
          ? undefined
          : {
              text,
              kind: 'text',
              warnings: ['Synthetic extraction warning'],
              units: options.units ?? [
                { label: '正文', start: 0, end: text.length },
              ],
            },
      );
    }
    const [reference] = await listReferencePublications(
      owner,
      owner.workspaceId!,
      saved.sourceId,
    );
    return {
      ...saved,
      pin: referenceReadPin(reference!),
      reference: reference!,
    };
  }
  const change = async (sourceId: string, audience?: ReferenceAudience) =>
    changeReferencePublication(owner, sourceId, {
      workspaceId: owner.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 1,
      ...(audience ? { action: 'audience', audience } : { action: 'delete' }),
    });

  it('finds the policy at the end of the full document and returns its exact excerpt and citation', async () => {
    const prefix = '介绍与历史背景。'.repeat(600);
    const text = prefix + '差旅上限：每晚九百元。';
    const saved = await publish(text);
    const result = await queryReferencePublications(owner, {
      query: '差旅上限',
    });
    expect(result.references.map((item) => item.revisionId)).toEqual([
      saved.revisionId,
    ]);
    expect(result.matches[0]).toMatchObject({
      revisionId: saved.revisionId,
      content: '差旅上限：每晚九百元。',
    });
    expect(result.matches[0]!.locations[0]).toMatchObject({
      label: '正文',
      start: 0,
      end: text.length,
    });
    expect(result.fullTextCoverage).toEqual({ ready: 1, unavailable: 0 });
    const searched = await prepareReferenceSearch(owner, { query: '差旅上限' });
    expect(searched.excerpts[0]!.result.citation.reference).toMatchObject(
      saved.pin,
    );
    expect(searched.excerpts[0]!.result.citation.locator.start).toBe(
      prefix.length,
    );
    // Web/prepare reads cannot fabricate model consumption.
    const [row] =
      await f.db`select count(*)::int n from allrice_employee_runs where organization_id=${owner.organizationId} and jsonb_array_length(reference_reads)>0`;
    expect(row!.n).toBe(0);
  });

  it('matches Chinese short text, case-insensitive words and literal SQL pattern characters', async () => {
    const saved = await publish('税率 5%_fixed\\value；API Key 中文政策。');
    for (const query of [
      '税',
      '税率',
      'api key',
      '5%_fixed\\value',
      '%_',
      '中文',
    ]) {
      const result = await queryReferencePublications(owner, { query });
      expect(result.references.map((item) => item.sourceId)).toEqual([
        saved.sourceId,
      ]);
    }
    expect(
      (await queryReferencePublications(owner, { query: '%anything' }))
        .references,
    ).toEqual([]);
  });

  it('preserves natural locations, complete names and surrogate pairs across bounded pages', async () => {
    const text = '甲😀乙\n第二工作表';
    const saved = await publish(text, {
      units: [
        { label: 'Sheet 一', sheetName: '一', start: 0, end: 5 },
        { label: 'Sheet 二', sheetName: '二', start: 5, end: text.length },
      ],
    });
    const prepared = await prepareReferenceText(owner, saved.pin);
    const first = referenceTextPage(prepared, 0, 2);
    expect(first.content).toBe('甲');
    const second = referenceTextPage(prepared, first.nextOffset!, 2);
    expect(second.content).toBe('😀');
    const last = referenceTextPage(prepared, second.nextOffset!, 4000);
    expect(first.content + second.content + last.content).toBe(text);
    expect(last.locations.map((location) => location.sheetName)).toEqual([
      '一',
      '二',
    ]);
    expect(last.warnings).toEqual(['Synthetic extraction warning']);
    expect(last.nextOffset).toBeNull();
    expect(referenceTextCitation(prepared, second).citation).toMatchObject({
      reference: saved.pin,
      locator: { start: 1, end: 3 },
    });
  });

  it('keeps citation offsets in original text after a Unicode lowercase expansion', async () => {
    const saved = await publish('İ前言😀 TARGET政策');
    const result = await prepareReferenceSearch(owner, { query: 'target' });
    expect(result.excerpts[0]!.result.citation.reference).toMatchObject(
      saved.pin,
    );
    expect(result.excerpts[0]!.result.citation.locator.start).toBe(
      'İ前言😀 '.length,
    );
    expect(result.excerpts[0]!.result.content).toBe('TARGET政策');
  });

  it('never treats a pin from another organization or an archived department as permission', async () => {
    const department = randomUUID();
    await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name)
      values(${department},${owner.organizationId},'Finance',${randomUUID()},'Finance')`;
    const saved = await publish('财务政策', {
      audience: { scope: 'departments', departmentIds: [department] },
    });
    const reader = await member(department);
    const foreign = await runFixture(f.db);
    const foreignContext = (await authenticateSession(
      (await createSession(foreign.context.actor.id)).token,
      {
        organizationId: foreign.context.organizationId,
        workspaceId: foreign.context.workspaceId!,
      },
    ))!;
    expect(
      (await queryReferencePublications(foreignContext, { query: '财务政策' }))
        .references,
    ).toEqual([]);
    await expect(
      prepareReferenceText(foreignContext, saved.pin),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    await f.db`update allrice_departments set archived_at=clock_timestamp() where id=${department}`;
    expect(
      (await queryReferencePublications(reader, { query: '政策' })).references,
    ).toEqual([]);
    await expect(prepareReferenceText(reader, saved.pin)).rejects.toMatchObject(
      { code: 'REFERENCE_UNAVAILABLE' },
    );
  });

  it('installs its search index with only the owned schema in search_path', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0243_reference_fulltext_search.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await expect(
      f.db.begin(async (tx) => {
        const [owned] = await tx`select current_schema() as name`;
        await tx`select set_config('search_path', quote_ident(${owned!.name}), true)`;
        const [before] = await tx`select current_schemas(false) as schemas`;
        expect(before!.schemas).toEqual([owned!.name]);
        await tx`drop index allrice_reference_fulltext_search_idx`;
        await tx.unsafe(migration);
        const [index] = await tx`select
          n.nspname as table_schema, c.relname as table_name,
          op.opcname as opclass, op.opcnamespace = e.extnamespace as extension_opclass,
          en.nspname as extension_schema
          from pg_catalog.pg_index i
          join pg_catalog.pg_class c on c.oid = i.indrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          join pg_catalog.pg_opclass op on op.oid = i.indclass[0]
          join pg_catalog.pg_extension e on e.extname = 'pg_trgm'
          join pg_catalog.pg_namespace en on en.oid = e.extnamespace
          where i.indexrelid = 'allrice_reference_fulltext_search_idx'::regclass`;
        expect(index).toMatchObject({
          table_schema: owned!.name,
          table_name: 'allrice_knowledge_documents',
          opclass: 'gin_trgm_ops',
          extension_opclass: true,
        });
        expect(index!.extension_schema).not.toBe(owned!.name);
        const [after] = await tx`select current_schemas(false) as schemas`;
        expect(after!.schemas).toEqual([owned!.name]);
        throw new Error('rollback_owned_index_probe');
      }),
    ).rejects.toThrow('rollback_owned_index_probe');
  });

  it('uses only the complete text tied to the retained bytes and installs its derived search index', async () => {
    const saved = await publish('准确全文');
    const [index] =
      await f.db`select indexdef from pg_indexes where schemaname=current_schema() and indexname='allrice_reference_fulltext_search_idx'`;
    expect(index?.indexdef).toContain('gin (full_text gin_trgm_ops)');
    await f.db`update allrice_knowledge_documents set checksum=${'sha256:' + 'f'.repeat(64)} where knowledge_revision_id=${saved.revisionId}`;
    const result = await queryReferencePublications(owner, {
      query: '准确全文',
    });
    expect(result.references).toEqual([]);
    expect(result.fullTextCoverage).toEqual({ ready: 0, unavailable: 1 });
    await expect(prepareReferenceText(owner, saved.pin)).rejects.toMatchObject({
      code: 'REFERENCE_UNAVAILABLE',
      reason: 'full_text_unavailable',
    });
  });

  it("does not leak another member's private title, excerpt, count or cursor", async () => {
    const hidden = await publish('私人秘密与税率', {
      fileName: '秘密名字.txt',
      audience: { scope: 'personal', departmentIds: [] },
    });
    const visible = await publish('共同税率');
    const reader = await member();
    const result = await queryReferencePublications(reader, {
      query: '税率',
      limit: 1,
    });
    expect(result.references.map((item) => item.sourceId)).toEqual([
      visible.sourceId,
    ]);
    expect(result.fullTextCoverage).toEqual({ ready: 1, unavailable: 0 });
    expect(result.nextCursor).toBeNull();
    expect(JSON.stringify(result)).not.toContain('秘密');
    expect(JSON.stringify(result)).not.toContain(hidden.sourceId);
    await expect(
      prepareReferenceText(reader, hidden.pin),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
  });

  it('uses current departments and current membership, without an admin audience override', async () => {
    const department = randomUUID();
    await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name)
      values(${department},${owner.organizationId},'Sales',${randomUUID()},'Sales')`;
    const saved = await publish('部门指标', {
      audience: { scope: 'departments', departmentIds: [department] },
    });
    const reader = await member(department);
    expect(
      (
        await queryReferencePublications(reader, {
          query: '指标',
          category: 'departments',
        })
      ).references,
    ).toHaveLength(1);
    await f.db`update allrice_organization_people set department_id=null,content_maintenance_level='company' where user_id=${reader.actor.id}`;
    expect(
      (await queryReferencePublications(reader, { query: '指标' })).references,
    ).toEqual([]);
    await expect(prepareReferenceText(reader, saved.pin)).rejects.toMatchObject(
      { code: 'REFERENCE_UNAVAILABLE' },
    );
    await f.db`update allrice_memberships set active=false where user_id=${reader.actor.id}`;
    await expect(
      queryReferencePublications(reader, { query: '指标' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  it('distinguishes an incomplete authorized index from a complete no-match result', async () => {
    const notReady = await publish('末尾待处理秘密', {
      fileName: '待处理政策.txt',
      ready: false,
    });
    const oldReady = await publish('完整文字尚未回填', { fullText: false });
    const result = await queryReferencePublications(owner, {
      query: '不在正文',
    });
    expect(result.references).toEqual([]);
    expect(result.matches).toEqual([]);
    expect(result.fullTextCoverage).toEqual({ ready: 0, unavailable: 2 });
    expect(
      (await queryReferencePublications(owner, { query: '待处理' }))
        .references[0],
    ).toMatchObject({ sourceId: notReady.sourceId, fullTextReady: false });
    await expect(
      prepareReferenceText(owner, oldReady.pin),
    ).rejects.toMatchObject({
      code: 'REFERENCE_UNAVAILABLE',
      reason: 'full_text_unavailable',
    });
  });

  it('has deterministic pages for tied timestamps and binds cursors to the current reader/query', async () => {
    const items = [];
    // Assign tied timestamps at INSERT in this isolated fixture database;
    // published revisions remain immutable throughout the test.
    await f.db`alter table allrice_knowledge_revisions alter column created_at set default '2026-01-01T00:00:00.123456Z'::timestamptz`;
    try {
      for (const label of ['甲', '乙', '丙'])
        items.push(await publish('分页政策 ' + label, { ready: false }));
    } finally {
      await f.db`alter table allrice_knowledge_revisions alter column created_at set default now()`;
    }
    expect(new Set(items.map((item) => item.reference.createdAt))).toEqual(
      new Set(['2026-01-01T00:00:00.123Z']),
    );
    const first = await queryReferencePublications(owner, {
      query: '政策',
      limit: 1,
    });
    const second = await queryReferencePublications(owner, {
      query: '政策',
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = await queryReferencePublications(owner, {
      query: '政策',
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(
      [...first.references, ...second.references, ...third.references].map(
        (item) => item.sourceId,
      ),
    ).toEqual(items.map((item) => item.sourceId).sort());
    expect(third.nextCursor).toBeNull();
    await expect(
      queryReferencePublications(owner, {
        query: 'different',
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow();
    const reader = await member();
    await expect(
      queryReferencePublications(reader, {
        query: '政策',
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow();
  });

  it('rechecks revoke, audience, exact revision and byte checksums on every page', async () => {
    const saved = await publish('完整政策内容');
    const reader = await member();
    expect((await prepareReferenceText(reader, saved.pin)).fullText.text).toBe(
      '完整政策内容',
    );
    await change(saved.sourceId, { scope: 'personal', departmentIds: [] });
    expect(
      (await queryReferencePublications(reader, { query: '政策' })).references,
    ).toEqual([]);
    await expect(prepareReferenceText(reader, saved.pin)).rejects.toMatchObject(
      { code: 'REFERENCE_UNAVAILABLE' },
    );
    await expect(
      prepareReferenceText(owner, {
        ...saved.pin,
        checksum: 'sha256:' + '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    await expect(
      prepareReferenceText(owner, { ...saved.pin, sourceId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
    await changeReferencePublication(owner, saved.sourceId, {
      workspaceId: owner.workspaceId,
      requestId: randomUUID(),
      expectedRevision: 2,
      action: 'delete',
    });
    expect((await queryReferencePublications(owner, {})).references).toEqual(
      [],
    );
  });
});
