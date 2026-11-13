import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { LocalStorageAdapter } from '@allrice/storage';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { processNextReference } from '../../../apps/worker/src/reference-processing.ts';
import * as documentReader from '../../../apps/worker/src/document-reader.ts';
import { generateDeliverable } from '../../../apps/worker/src/deliverable-generator.ts';
import {
  changeReference,
  completeReferenceUpload,
  getReferenceFile,
  prepareReferenceUpload,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  failReferenceProcessing,
  finishReferenceProcessing,
  type ReferenceFullText,
} from './reference-processing.ts';
import {
  captureReferenceSelections,
  retrieveSelectedReferenceKnowledge,
} from './reference-runtime.ts';
import { sendChatMessage } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const body = (text: string): ReferenceFullText => ({
  text,
  kind: 'text',
  warnings: [],
  units: [{ label: '正文', start: 0, end: text.length }],
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

suite(
  'reference full text uses exact leases without locking realtime authority',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'reference-full-text-')),
      );
      await f.db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
      values(${f.context.sessionId!},${f.ownerId},${createHash('sha256').update(randomUUID()).digest('hex')},clock_timestamp()+interval '1 hour')`;
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level)
      values(${f.organizationId},${f.ownerId},'Reference owner','company')`;
    }, 120000);
    beforeEach(async () => {
      // One disposable schema owns every row here. Prior cases must not supply
      // unrelated ready backfill work to the next real Worker call.
      await f.db`update allrice_knowledge_sources set status='archived' where ownership is not null`;
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
      if (root) await rm(root, { recursive: true, force: true });
    }, 30000);

    async function upload(
      bytes: Buffer = Buffer.from('开始正文\n最终中文尾部：总额九千元。'),
      mediaType = 'text/plain',
      fileName = '完整资料.txt',
    ) {
      const saved = await prepareReferenceUpload(f.context, {
        workspaceId: f.workspaceId,
        requestId: randomUUID(),
        scope: 'company',
        fileName,
        purpose: '必须可以读取最后一句',
        mediaType,
        contentBase64: bytes.toString('base64'),
      });
      await new LocalStorageAdapter(root).put(
        saved.object,
        new Blob([new Uint8Array(bytes)]).stream(),
      );
      await completeReferenceUpload(f.context, f.workspaceId, saved.revisionId);
      return saved;
    }
    const action = (sourceId: string, operation: 'archive' | 'retry') =>
      changeReference(f.context, sourceId, {
        workspaceId: f.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: operation,
      });
    async function chat() {
      const sessionId = randomUUID();
      await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
      values(${sessionId},${f.organizationId},${f.workspaceId},${f.ownerId},'资料处理时继续聊天',${f.assignmentId},${f.employeeVersionId})`;
      return sendChatMessage(f.context, f.workspaceId, sessionId, {
        clientMessageId: randomUUID(),
        text: '继续当前工作',
        deliveryMode: 'follow_up',
      });
    }
    async function snapshot() {
      return f.db`select a.pid,a.wait_event_type,a.wait_event,
      l.mode,l.granted,c.relname from pg_stat_activity a
      join pg_locks l on l.pid=a.pid left join pg_class c on c.oid=l.relation
      where a.application_name=${f.schema} or a.query like '%allrice_knowledge_chunks%'
      order by a.pid,l.granted,l.mode`;
    }
    async function guarded<T>(promise: Promise<T>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('reference concurrency deadlock guard')),
              5000,
            );
          }),
        ]);
      } catch (error) {
        console.error('Reference processing lock snapshot', await snapshot());
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    it('writes the real Worker body and natural character locators through the existing upload pipeline', async () => {
      const text = '财务口径\n'.repeat(25_000) + '最后一句：确认九千元。';
      const saved = await upload(Buffer.from(text));
      expect(await processNextReference(root)).toBe(true);
      const [stored] =
        await f.db`select d.full_text,d.full_text_locations,p.state
      from allrice_knowledge_documents d join allrice_knowledge_processing p on p.revision_id=d.knowledge_revision_id
      where d.knowledge_revision_id=${saved.revisionId}`;
      expect(stored!.state).toBe('ready');
      expect(stored!.full_text).toBe(text);
      expect(stored!.full_text_locations.units).toEqual([
        { label: '正文', start: 0, end: text.length },
      ]);
      expect(await claimReferenceProcessing(true)).toBeNull();
    });

    it('returns stored excerpt locators in the same coordinates as the exact saved full text', async () => {
      const text =
        '\ufeff \r\n' +
        '跨行正文与收入\r\n'.repeat(700) +
        '最后唯一结论：本期九千元。\r\n ';
      const saved = await upload(Buffer.from(text));
      await processNextReference(root);
      const rows =
        await f.db`select c.content,c.locator,d.full_text from allrice_knowledge_chunks c
        join allrice_knowledge_documents d on d.id=c.document_id where d.knowledge_revision_id=${saved.revisionId} order by c.ordinal`;
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[0]!.locator.start).toBe('\ufeff \r\n'.length);
      expect(rows.at(-1)!.content).toContain('最后唯一结论');
      for (const row of rows) {
        expect(row.full_text).toBe(text);
        expect(text.slice(row.locator.start, row.locator.end)).toBe(
          row.content,
        );
      }
      const selections = await f.db.begin((tx) =>
        captureReferenceSelections(f.context, [saved.revisionId], tx),
      );
      const results = await retrieveSelectedReferenceKnowledge({
        context: f.context,
        selections,
        query: '最后唯一结论',
      });
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        const locator = result.citation.locator as {
          start: number;
          end: number;
        };
        expect(text.slice(locator.start, locator.end)).toBe(result.content);
      }
    });

    it.each([false, true])(
      'persists exact valid JSON characters for initial processing and old-ready backfill: backfill=%s',
      async (backfill) => {
        const text =
          ' \r\n{ "id":9007199254740993, "tag":"第一次", "tag":"第二次", "tail":"末尾中文" }\r\n ';
        const saved = await upload(
          Buffer.from(text),
          'application/json',
          '原文.json',
        );
        if (backfill) {
          const claim = (await claimReferenceProcessing())!;
          await finishReferenceProcessing(claim, [
            { content: '旧索引', start: 0, end: 3 },
          ]);
        }
        expect(await processNextReference(root)).toBe(true);
        const [stored] =
          await f.db`select d.full_text,d.checksum,d.full_text_locations,p.state
        from allrice_knowledge_documents d join allrice_knowledge_processing p on p.revision_id=d.knowledge_revision_id
        where d.knowledge_revision_id=${saved.revisionId}`;
        expect(stored!.full_text).toBe(text);
        expect(stored!.checksum).toBe(saved.object.checksum);
        expect(stored!.state).toBe('ready');
        expect(stored!.full_text_locations.units).toEqual([
          { label: '正文', start: 0, end: text.length },
        ]);
      },
    );

    it.each([
      { mediaType: 'application/pdf', fileName: '损坏.pdf' },
      {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: '损坏.docx',
      },
      {
        mediaType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: '损坏.xlsx',
      },
      {
        mediaType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        fileName: '损坏.pptx',
      },
    ])(
      'retries old approved-format metadata but leaves malformed bytes failed without full text: $fileName',
      async ({ mediaType, fileName }) => {
        const saved = await upload(
          Buffer.from('not a valid binary document'),
          mediaType,
          fileName,
        );
        await f.db`update allrice_knowledge_processing set state='unsupported',failure='prior unsupported format' where revision_id=${saved.revisionId}`;
        await action(saved.sourceId, 'retry');
        expect(await processNextReference(root)).toBe(true);
        expect(
          (
            await f.db`select state from allrice_knowledge_processing where revision_id=${saved.revisionId}`
          )[0]!.state,
        ).toBe('failed');
        expect(
          await f.db`select id from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`,
        ).toHaveLength(0);
        expect(
          (await getReferenceFile(f.context, f.workspaceId, saved.revisionId))
            .object.checksum,
        ).toBe(saved.object.checksum);
      },
    );

    it('completes real chat and revocation before releasing a paused real parser', async () => {
      const { bytes } = await generateDeliverable({
        format: 'docx',
        content: '完整正文',
      });
      const saved = await upload(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '资料.docx',
      );
      const entered = barrier(),
        release = barrier();
      const parse = documentReader.parseDocument;
      const spy = vi
        .spyOn(documentReader, 'parseDocument')
        .mockImplementationOnce(async (input) => {
          entered.release();
          await release.promise;
          return parse(input);
        });
      const worker = processNextReference(root);
      try {
        await guarded(entered.promise);
        const sent = await guarded(chat());
        expect(sent.run.id).toBeTruthy();
        await guarded(action(saved.sourceId, 'archive'));
        await expect(
          getReferenceFile(f.context, f.workspaceId, saved.revisionId),
        ).rejects.toThrow('not_found');
      } finally {
        release.release();
        await worker;
        spy.mockRestore();
      }
      const [p] =
        await f.db`select state from allrice_knowledge_processing where revision_id=${saved.revisionId}`;
      expect(p!.state).toBe('failed');
      expect(
        await f.db`select id from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`,
      ).toHaveLength(0);
    });

    it('rolls back a real Worker result when its lease is replaced after derived writing starts', async () => {
      const saved = await upload();
      const held = barrier(),
        release = barrier();
      const blocker = f.db.begin(async (tx) => {
        await tx`lock table allrice_knowledge_chunks in access exclusive mode`;
        held.release();
        await release.promise;
      });
      await guarded(held.promise);
      const worker = processNextReference(root);
      let completion: Promise<unknown> | undefined;
      try {
        await guarded(
          (async () => {
            while (
              !(
                await f.db`select pid from pg_locks
          where relation='allrice_knowledge_chunks'::regclass and not granted`
              ).length
            )
              await new Promise<void>((resolve) => setImmediate(resolve));
          })(),
        );
        await f.db`update allrice_knowledge_processing set lease_until=clock_timestamp()-interval '1 second'
        where revision_id=${saved.revisionId}`;
        const replacement = (await guarded(claimReferenceProcessing()))!;
        expect(replacement.revisionId).toBe(saved.revisionId);
        completion = finishReferenceProcessing(
          replacement,
          [{ content: '新lease完整正文', start: 0, end: 10 }],
          body('新lease完整正文'),
        );
      } finally {
        release.release();
        await blocker;
        await worker;
        await completion;
      }
      const [stored] =
        await f.db`select d.full_text,p.state,p.lease_token from allrice_knowledge_documents d
      join allrice_knowledge_processing p on p.revision_id=d.knowledge_revision_id
      where d.knowledge_revision_id=${saved.revisionId}`;
      expect(stored).toMatchObject({
        full_text: '新lease完整正文',
        state: 'ready',
        lease_token: null,
      });
    });

    it('permits real chat and revocation while derived chunk writes wait, including implicit FK key locks', async () => {
      const saved = await upload();
      const held = barrier(),
        release = barrier();
      const blocker = f.db.begin(async (tx) => {
        await tx`lock table allrice_knowledge_chunks in access exclusive mode`;
        held.release();
        await release.promise;
      });
      await guarded(held.promise);
      const worker = processNextReference(root);
      try {
        await guarded(
          (async () => {
            // Wait for the real Worker, not a bare lock-holder fragment, to reach
            // the chunk relation after creating the document/FK references.
            while (true) {
              const waiting = await f.db`select l.pid from pg_locks l
            where l.relation='allrice_knowledge_chunks'::regclass and not l.granted`;
              if (waiting.length) break;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          })(),
        );
        console.info('Reference derived-write lock snapshot', await snapshot());
        const sent = await guarded(chat());
        expect(sent.run.id).toBeTruthy();
        await guarded(action(saved.sourceId, 'archive'));
        const [current] =
          await f.db`select status from allrice_knowledge_sources where id=${saved.sourceId}`;
        expect(current!.status).toBe('archived');
      } finally {
        release.release();
        await blocker;
        await worker;
      }
      expect(
        await f.db`select id from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`,
      ).toHaveLength(0);
      await expect(
        getReferenceFile(f.context, f.workspaceId, saved.revisionId),
      ).rejects.toThrow('not_found');
    });

    it('rejects a replaced lease and a changed checksum without overwriting the exact derived document', async () => {
      const saved = await upload(),
        old = (await claimReferenceProcessing())!;
      await f.db`update allrice_knowledge_processing set lease_until=clock_timestamp()-interval '1 second' where revision_id=${saved.revisionId}`;
      const current = (await claimReferenceProcessing())!;
      expect(current.token).not.toBe(old.token);
      await expect(
        finishReferenceProcessing(
          old,
          [{ content: '旧正文', start: 0, end: 3 }],
          body('旧正文'),
        ),
      ).rejects.toThrow('处理租期或资料版本已变化');
      await failReferenceProcessing(old, '旧lease不能破坏新lease');
      const [leased] =
        await f.db`select lease_token,state from allrice_knowledge_processing where revision_id=${saved.revisionId}`;
      expect(leased!.lease_token).toBe(current.token);
      expect(leased!.state).toBe('processing');
      await expect(
        finishReferenceProcessing(
          {
            ...current,
            object: { ...current.object, checksum: `sha256:${'0'.repeat(64)}` },
          },
          [{ content: '正文', start: 0, end: 2 }],
          body('正文'),
        ),
      ).rejects.toThrow('资料文件校验失败');
      await finishReferenceProcessing(
        current,
        [{ content: '当前正文', start: 0, end: 4 }],
        body('当前正文'),
      );
      expect(
        (
          await f.db`select full_text from allrice_knowledge_documents where knowledge_revision_id=${saved.revisionId}`
        )[0]!.full_text,
      ).toBe('当前正文');
    });

    it('backfills only derived text while retaining old ready state, chunk pins and document identity', async () => {
      const saved = await upload(),
        claim = (await claimReferenceProcessing())!;
      await finishReferenceProcessing(claim, [
        { content: '旧兼容索引', start: 0, end: 5 },
      ]);
      const [before] =
        await f.db`select d.id,d.active,d.indexed_at,p.indexed_at as processing_indexed_at,
      c.id as chunk_id,c.locator,c.content from allrice_knowledge_documents d
      join allrice_knowledge_chunks c on c.document_id=d.id
      join allrice_knowledge_processing p on p.revision_id=d.knowledge_revision_id
      where d.knowledge_revision_id=${saved.revisionId}`;
      const selection = await f.db.begin((tx) =>
        captureReferenceSelections(f.context, [saved.revisionId], tx),
      );
      expect(await claimReferenceProcessing()).toBeNull();
      const backfill = (await claimReferenceProcessing(true))!;
      expect(backfill.backfill).toBe(true);
      expect(
        (
          await f.db`select state from allrice_knowledge_processing where revision_id=${saved.revisionId}`
        )[0]!.state,
      ).toBe('ready');
      await finishReferenceProcessing(
        backfill,
        [{ content: '不替换旧片段', start: 0, end: 6 }],
        body('补全正文尾部'),
      );
      const [after] =
        await f.db`select d.id,d.active,d.indexed_at,p.indexed_at as processing_indexed_at,
      c.id as chunk_id,c.locator,c.content from allrice_knowledge_documents d
      join allrice_knowledge_chunks c on c.document_id=d.id
      join allrice_knowledge_processing p on p.revision_id=d.knowledge_revision_id
      where d.knowledge_revision_id=${saved.revisionId}`;
      expect(after).toEqual(before);
      expect(
        await f.db.begin((tx) =>
          captureReferenceSelections(f.context, [saved.revisionId], tx),
        ),
      ).toEqual(selection);
      expect(await claimReferenceProcessing(true)).toBeNull();
    });

    it('keeps ready on failed backfill, avoids a hot loop, and uses explicit existing retry', async () => {
      const saved = await upload(),
        claim = (await claimReferenceProcessing())!;
      await finishReferenceProcessing(claim, [
        { content: '旧索引', start: 0, end: 3 },
      ]);
      const backfill = (await claimReferenceProcessing(true))!;
      await expect(
        finishReferenceProcessing(backfill, [
          { content: '局部', start: 0, end: 2 },
        ]),
      ).rejects.toThrow('资料正文尚未完整提取');
      await failReferenceProcessing(backfill, '解析失败', true);
      const [p] =
        await f.db`select state,failure,lease_token from allrice_knowledge_processing where revision_id=${saved.revisionId}`;
      expect(p).toMatchObject({
        state: 'ready',
        failure: '解析失败',
        lease_token: null,
      });
      expect(await claimReferenceProcessing(true)).toBeNull();
      await action(saved.sourceId, 'retry');
      expect(
        (
          await f.db`select state from allrice_knowledge_processing where revision_id=${saved.revisionId}`
        )[0]!.state,
      ).toBe('ready');
      expect((await claimReferenceProcessing(true))!.backfill).toBe(true);
    });

    it('recovers expired ready leases within the existing three-attempt bound without withdrawing ready', async () => {
      const saved = await upload(),
        claim = (await claimReferenceProcessing())!;
      await finishReferenceProcessing(claim, [
        { content: '旧索引', start: 0, end: 3 },
      ]);
      const first = (await claimReferenceProcessing(true))!;
      await f.db`update allrice_knowledge_processing set lease_until=clock_timestamp()-interval '1 second' where revision_id=${saved.revisionId}`;
      const recovered = (await claimReferenceProcessing(true))!;
      expect(recovered.token).not.toBe(first.token);
      await expect(
        finishReferenceProcessing(
          first,
          [{ content: '旧', start: 0, end: 1 }],
          body('旧'),
        ),
      ).rejects.toThrow();
      await f.db`update allrice_knowledge_processing set lease_until=clock_timestamp()-interval '1 second' where revision_id=${saved.revisionId}`;
      expect(await claimReferenceProcessing(true)).toBeNull();
      expect(
        (
          await f.db`select state,failure,lease_token from allrice_knowledge_processing where revision_id=${saved.revisionId}`
        )[0],
      ).toMatchObject({
        state: 'ready',
        failure: '处理多次中断，请重试',
        lease_token: null,
      });
    });
  },
);
