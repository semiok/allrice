import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrandMediaPublicationSchema,
  BrandMediaUserCommandSchema,
  transitionBrandMediaPublication,
  type BrandMediaPublicationChange,
} from '@allrice/contracts';
import {
  createRuntimeFixtureDatabase,
  runtimeTaskFixture,
} from './runtime.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Fixture = Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
type Owner = Awaited<ReturnType<typeof owner>>;
let f: Fixture;
async function owner(db: Fixture['db']) {
  const base = await runtimeTaskFixture(db);
  const [instance] = await db<
    { id: string }[]
  >`insert into allrice_employee_instances
    (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
    select id,organization_id,workspace_id,user_id,id,'general',employee_version_id
    from allrice_employee_assignments where user_id=${base.context.actor.id}
    returning id`;
  return { ...base, instanceId: instance!.id };
}
async function topic(a: Owner) {
  const id = randomUUID();
  await f.db`insert into allrice_brand_media_topics
    (id,organization_id,workspace_id,owner_id,instance_id,candidate,direction,source_run_id)
    values (${id},${a.context.organizationId},${a.context.workspaceId!},${a.context.actor.id},${a.instanceId},
      '{"title":"冬季新品","summary":"面向老客户"}','介绍新品',${a.task.runId})`;
  return id;
}
async function article(a: Owner, topicId?: string) {
  const id = randomUUID();
  topicId ??= await topic(a);
  await f.db`insert into allrice_brand_media_articles
    (id,organization_id,workspace_id,owner_id,instance_id,topic_id,title)
    values (${id},${a.context.organizationId},${a.context.workspaceId!},${a.context.actor.id},${a.instanceId},${topicId},'冬季新品')`;
  return { id, topicId };
}
// Exercise the public data contract and actual persistence constraints. P1 has
// no HTTP/Worker implementation; this fixture is not an authorization service.
async function publication(
  id: string,
  expectedRevision: number,
  change: BrandMediaPublicationChange,
) {
  const [row] =
    await f.db`select * from allrice_brand_media_articles where id=${id}`;
  const current = BrandMediaPublicationSchema.parse({
    state: row!.state,
    schedule: row!.planned_at
      ? { plannedAt: row!.planned_at.toISOString(), timezone: row!.timezone }
      : null,
    links:
      row!.state === 'published'
        ? { wechat: row!.wechat_url, xiaohongshu: row!.xiaohongshu_url }
        : null,
  });
  const next = transitionBrandMediaPublication(current, change);
  return f.db`update allrice_brand_media_articles set state=${next.state},
    planned_at=${next.schedule?.plannedAt ?? null},timezone=${next.schedule?.timezone ?? null},
    wechat_url=${next.links?.wechat ?? null},xiaohongshu_url=${next.links?.xiaohongshu ?? null},revision=revision+1
    where id=${id} and revision=${expectedRevision} returning *`;
}
const schedule = {
  plannedAt: '2026-11-24T20:00:00+08:00',
  timezone: 'Asia/Shanghai',
};
const links = { wechat: null, xiaohongshu: null };

suite('MET-224 s1.3 business storage contract', () => {
  let a: Owner;
  let b: Owner;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    a = await owner(f.db);
    b = await owner(f.db);
  }, 120000);
  afterAll(async () => {
    await f?.close();
  }, 30000);

  it('“开始写，排周二晚上，标记已发布，刚才点错了” persists the three states and correction', async () => {
    const { id } = await article(a);
    const [draft] =
      await f.db`select state,body_file,revision from allrice_brand_media_articles where id=${id}`;
    expect(draft).toEqual({ state: 'draft', body_file: null, revision: 1 });
    const command = BrandMediaUserCommandSchema.parse({
      workspaceId: a.context.workspaceId,
      instanceId: a.instanceId,
      requestId: randomUUID(),
      articleId: id,
      expectedRevision: 1,
      operation: 'article.publication',
      change: { action: 'schedule', schedule },
    });
    if (command.operation !== 'article.publication')
      throw Error('Wrong fixture command');
    const [planned] = await publication(
      id,
      command.expectedRevision,
      command.change,
    );
    expect(planned!.state).toBe('scheduled');
    expect(planned!.planned_at.toISOString()).toBe('2026-11-24T12:00:00.000Z');
    const [sent] = await publication(id, 2, {
      action: 'publish',
      links: { ...links, wechat: 'https://mp.weixin.qq.com/s/example' },
    });
    expect(sent!.state).toBe('published');
    expect(sent!.planned_at).toEqual(planned!.planned_at);
    const [corrected] = await publication(id, 3, { action: 'unpublish' });
    expect(corrected).toMatchObject({
      state: 'scheduled',
      wechat_url: null,
      xiaohongshu_url: null,
      revision: 4,
    });
    expect(corrected!.planned_at).toEqual(sent!.planned_at);
    const [cancelled] = await publication(id, 4, { action: 'unschedule' });
    expect(cancelled).toMatchObject({
      state: 'draft',
      planned_at: null,
      timezone: null,
      revision: 5,
    });
  });

  it('starts each topic at most once and the topic FK prevents deleting an in-use topic', async () => {
    const first = await article(a);
    await expect(article(a, first.topicId)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      f.db`delete from allrice_brand_media_topics where id=${first.topicId}`,
    ).rejects.toMatchObject({ code: '23503' });
    const [count] =
      await f.db`select count(*)::int n from allrice_brand_media_topics t
      where id=${first.topicId} and not exists(select 1 from allrice_brand_media_articles a where a.topic_id=t.id)`;
    expect(count!.n).toBe(0);
  });

  it('rejects cross-company topics and a source Run from another workspace', async () => {
    const t = await topic(a);
    await expect(article(b, t)).rejects.toMatchObject({ code: '23503' });
    await expect(
      f.db`update allrice_brand_media_topics set source_run_id=${b.task.runId} where id=${t}`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a topic from another employee instance even with the same owner', async () => {
    const t = await topic(a);
    const instance = randomUUID();
    await f.db`insert into allrice_employee_instances
      (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id,creation_request_id,creation_input)
      select ${instance},organization_id,workspace_id,owner_id,assignment_id,'custom',creation_version_id,${randomUUID()},'{}'
      from allrice_employee_instances where id=${a.instanceId}`;
    await expect(
      article({ ...a, instanceId: instance }, t),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects forged scope and keeps article identity fixed after creation', async () => {
    const { id } = await article(a);
    await expect(
      f.db`update allrice_brand_media_articles set owner_id=${b.context.actor.id},revision=revision+1 where id=${id}`,
    ).rejects.toThrow('brand_media_article_identity_immutable');
    await expect(
      f.db`update allrice_brand_media_topics set instance_id=${b.instanceId} where id=${await topic(a)}`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('preserves the winning content against late CAS writes and invalid revision increments', async () => {
    const { id } = await article(a);
    const winning =
      await f.db`update allrice_brand_media_articles set title='用户的新标题',revision=revision+1 where id=${id} and revision=1 returning id`;
    expect(winning).toHaveLength(1);
    const late =
      await f.db`update allrice_brand_media_articles set title='迟到结果',revision=revision+1 where id=${id} and revision=1 returning id`;
    expect(late).toHaveLength(0);
    await expect(
      f.db`update allrice_brand_media_articles set title='没有修订号' where id=${id}`,
    ).rejects.toThrow('brand_media_revision_conflict');
    const [saved] =
      await f.db`select title,revision from allrice_brand_media_articles where id=${id}`;
    expect(saved).toEqual({ title: '用户的新标题', revision: 2 });
  });

  it('keeps published content read-only, including a combined correction and content edit', async () => {
    const { id } = await article(a);
    await publication(id, 1, { action: 'schedule', schedule });
    await publication(id, 2, { action: 'publish', links });
    await expect(
      f.db`update allrice_brand_media_articles set title='偷偷改字',revision=revision+1 where id=${id}`,
    ).rejects.toThrow('brand_media_invalid_transition');
    await expect(
      f.db`delete from allrice_brand_media_articles where id=${id}`,
    ).rejects.toThrow('brand_media_published_readonly');
    await expect(
      f.db`update allrice_brand_media_articles set state='scheduled',title='混合改字',revision=revision+1 where id=${id}`,
    ).rejects.toThrow('brand_media_published_readonly');
    await publication(id, 3, { action: 'unpublish' });
    await f.db`update allrice_brand_media_articles set title='纠正后再改',revision=revision+1 where id=${id}`;
  });

  it('rejects skipped progress and preserves the scheduled time when publishing', async () => {
    const { id } = await article(a);
    await expect(
      f.db`update allrice_brand_media_articles set state='published',planned_at=${schedule.plannedAt},timezone=${schedule.timezone},revision=revision+1 where id=${id}`,
    ).rejects.toThrow('brand_media_invalid_transition');
    await publication(id, 1, { action: 'schedule', schedule });
    await expect(
      f.db`update allrice_brand_media_articles set state='published',planned_at=planned_at+interval '1 hour',revision=revision+1 where id=${id}`,
    ).rejects.toThrow('brand_media_publication_uses_schedule');
    await expect(
      f.db`update allrice_brand_media_articles set state='draft',revision=revision+1 where id=${id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.db`update allrice_brand_media_articles set wechat_url='https://example.test',revision=revision+1 where id=${id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('removing an article and its topic preserves the original deliverable and source Run', async () => {
    const saved = await a.artifact(a.task.runId, '保留这份交付成果');
    const [object] =
      await f.db`select object_id from allrice_deliverable_versions where id=${saved.artifactId}`;
    const { id, topicId } = await article(a);
    const file = {
      objectId: object!.object_id,
      versionId: saved.artifactId,
      checksum: saved.digest,
    };
    await f.db`update allrice_brand_media_articles set body_file=${f.db.json(file)},revision=revision+1 where id=${id}`;
    await f.db.begin(async (tx) => {
      await tx`delete from allrice_brand_media_articles where id=${id}`;
      await tx`delete from allrice_brand_media_topics where id=${topicId}`;
    });
    const [counts] = await f.db`select
      (select count(*)::int from allrice_workbench_artifacts where version_id=${saved.artifactId}) artifacts,
      (select count(*)::int from allrice_storage_objects where id=${object!.object_id} and state='ready') objects,
      (select count(*)::int from allrice_runs where id=${a.task.runId}) runs`;
    expect(counts).toEqual({ artifacts: 1, objects: 1, runs: 1 });
  });

  it('applies the additive migration after existing deliverables without rewriting them', async () => {
    const previous = await createRuntimeFixtureDatabase({
      throughMigration: '0239_workbench_file_favorites.sql',
    });
    try {
      const directory = new URL('../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter(
          (name) =>
            name > '0239_workbench_file_favorites.sql' &&
            name < '0245_brand_media_contract.sql' &&
            name.endsWith('.sql'),
        )
        .sort())
        await previous.db.begin(async (tx) => {
          await tx.unsafe(await readFile(new URL(name, directory), 'utf8'));
        });
      const actor = await owner(previous.db);
      const saved = await actor.artifact(actor.task.runId, '迁移前已交付');
      const before =
        await previous.db`select to_jsonb(a) row from allrice_workbench_artifacts a where version_id=${saved.artifactId}`;
      await previous.db.begin(async (tx) => {
        await tx.unsafe(
          await readFile(
            new URL('0245_brand_media_contract.sql', directory),
            'utf8',
          ),
        );
      });
      expect(
        await previous.db`select to_jsonb(a) row from allrice_workbench_artifacts a where version_id=${saved.artifactId}`,
      ).toEqual(before);
      expect(
        await previous.db`select * from allrice_brand_media_articles`,
      ).toEqual([]);
      expect(
        await previous.db`select * from allrice_brand_media_topics`,
      ).toEqual([]);
    } finally {
      await previous.close();
    }
  }, 120000);
});
