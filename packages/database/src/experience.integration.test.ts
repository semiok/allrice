import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from './core/client.ts';
import { createExperienceStore } from './experience.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  createChatSession,
  sendChatMessage,
  correctWorkspaceMemory,
  promoteWorkspaceMemory,
  searchWorkspaceMemories,
  deleteWorkspaceMemory,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { assembleEmployeeKernel } from '../../../apps/worker/src/employee-kernel.ts';
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p20_experience_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const store = createExperienceStore();
async function fixture() {
  return createExperienceFixture(db);
}
const decision = (
  c: { revision: number; digest: string },
  type = 'approve',
) => ({
  decision: type,
  expectedRevision: c.revision,
  expectedDigest: c.digest,
  reason: 'Synthetic exact rule reviewed',
});
suite(
  'P20 actual isolated PostgreSQL — no external model or personal data',
  () => {
    beforeAll(async () => {
      const value = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!value) throw Error('Explicit dedicated test DB required');
      const url = new URL(value);
      if (!(
        (url.hostname === '127.0.0.1' &&
          url.port === '5432' &&
          url.pathname === '/allrice_b2' &&
          url.username === 'a123') ||
        (url.hostname === '127.0.0.1' &&
          url.port === '54329' &&
          url.pathname === '/allrice' &&
          url.username === 'allrice')
      ))
        throw Error('Dedicated B2/CI database only');
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const extensions = await admin<
        { extname: string }[]
      >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
      expect(extensions.map((e) => e.extname).sort()).toEqual([
        'pg_trgm',
        'vector',
      ]);
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 5, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(name, directory), 'utf8'));
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.unstubAllEnvs();
      await db?.end({ timeout: 5 });
      if (admin && /^p20_experience_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema ${schema} cascade`);
      await admin?.end({ timeout: 5 });
    });
    it('lists only completed owned messages and persists a non-recalled private candidate with exact origin', async () => {
      const f = await fixture();
      expect(await store.sources(f.owner, f.session.id)).toHaveLength(2);
      expect(await store.sources(f.neighbor, f.session.id)).toEqual([]);
      const c = await store.create(f.owner, f.input);
      expect(c).toMatchObject({
        status: 'pending',
        revision: 1,
        scope: 'private',
        source: { runId: f.run, messageId: f.message },
        canReview: true,
      });
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: 'Reconciliation rule',
        }),
      ).toEqual([]);
      expect(await store.list(f.reviewer)).toEqual([]);
      const [row] =
        await db`select visibility,lifecycle_state,source_id from allrice_memories where id=${c.id}`;
      expect(row).toEqual({
        visibility: 'private',
        lifecycle_state: 'candidate',
        source_id: null,
      });
    });
    it('deduplicates exact retries and rejects same id with changed content', async () => {
      const f = await fixture();
      const [a, b] = await Promise.all([
        store.create(f.owner, f.input),
        store.create(f.owner, f.input),
      ]);
      expect(a.id).toBe(b.id);
      await expect(
        store.create(f.owner, { ...f.input, content: 'Changed rule' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });
    it.each(['wrong-message', 'running', 'changed-excerpt', 'archived'])(
      'rejects invalid source %s',
      async (kind) => {
        const f = await fixture();
        const input = { ...f.input };
        if (kind === 'wrong-message') input.messageId = randomUUID();
        if (kind === 'running')
          await db`update allrice_employee_runs set status='running' where run_id=${f.run}`;
        if (kind === 'changed-excerpt')
          input.sourceExcerpt = 'invented evidence';
        if (kind === 'archived')
          await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
        await expect(store.create(f.owner, input)).rejects.toMatchObject({
          code: 'invalid_source',
        });
      },
    );
    it('does not accept forged cached roles, cross-tenant or another owner approvals', async () => {
      const f = await fixture(),
        other = await fixture();
      const c = await store.create(f.owner, f.input);
      await expect(
        store.review(f.reviewer, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        store.review(other.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'not_found' });
      await db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'identity_denied' });
    });
    it('shares only owner-approved rewritten text to a current workspace admin; ordinary reply cannot approve', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      expect(await store.list(f.neighbor)).toEqual([]);
      const [review] = await store.list(f.reviewer);
      expect(review).toMatchObject({ source: null, canReview: true });
      expect(JSON.stringify(review)).not.toContain('SYNTHETIC-ONLY');
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'identity_denied' });
      await expect(
        store.review(f.reviewer, c.id, { message: 'yes' }),
      ).rejects.toThrow();
      const approved = await store.review(f.reviewer, c.id, decision(c));
      expect(approved).toMatchObject({ status: 'approved', revision: 2 });
      expect(
        (
          await searchWorkspaceMemories(f.neighbor, {
            workspaceId: f.workspace,
            query: 'Reconciliation rule',
          })
        ).map((m) => m.id),
      ).toContain(c.id);
    });
    it('guards legacy promote/correct endpoints instead of silently bypassing scope review', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      await expect(
        promoteWorkspaceMemory(f.owner, f.workspace, c.id),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        correctWorkspaceMemory(f.owner, f.workspace, c.id, {
          content: 'bypass',
          reason: 'bypass',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect((await store.list(f.owner))[0]?.status).toBe('pending');
    });
    it('allows one exact decision under concurrent approve/reject and keeps one new revision', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, f.input);
      const results = await Promise.allSettled([
        store.review(f.owner, c.id, decision(c)),
        store.review(f.owner, c.id, decision(c, 'reject')),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const revisions =
        await db`select revision from allrice_memory_revisions where memory_id=${c.id} order by revision`;
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    });
    it('refuses a stale digest or changed source and atomically leaves the candidate unapproved', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, f.input);
      await expect(
        store.review(f.owner, c.id, {
          ...decision(c),
          expectedDigest: `sha256:${'0'.repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await db`update allrice_messages set content='{"text":"changed","citations":[]}' where id=${f.message}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'source_changed' });
      expect((await store.list(f.owner))[0]).toMatchObject({
        status: 'pending',
        revision: 1,
      });
    });
    it('keeps a platform handoff private and inactive; even a tenant admin cannot publish it', async () => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'platform',
        shareAcknowledged: true,
      });
      expect(c.canReview).toBe(false);
      expect(await store.list(f.reviewer)).toEqual([]);
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'platform_publication_required' });
      const rejected = await store.review(f.owner, c.id, decision(c, 'reject'));
      expect(rejected.status).toBe('rejected');
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: 'Reconciliation rule',
        }),
      ).toEqual([]);
    });
    it.each([
      'owner-revoked',
      'owner-inactive',
      'reviewer-demoted',
      'source-archived',
    ])('revalidates the current source and reviewer on %s', async (kind) => {
      const f = await fixture();
      const c = await store.create(f.owner, {
        ...f.input,
        scope: 'workspace',
        shareAcknowledged: true,
      });
      if (kind === 'owner-revoked')
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
      if (kind === 'owner-inactive')
        await db`update allrice_users set status='disabled' where id=${f.user}`;
      if (kind === 'reviewer-demoted')
        await db`update allrice_memberships set role='member' where user_id=${f.reviewer.actor.id}`;
      if (kind === 'source-archived')
        await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
      await expect(
        store.review(f.reviewer, c.id, decision(c)),
      ).rejects.toMatchObject({
        code: kind === 'reviewer-demoted' ? 'not_found' : 'invalid_source',
      });
      const [memory] =
        await db`select lifecycle_state,revision from allrice_memories where id=${c.id}`;
      expect(memory).toEqual({ lifecycle_state: 'candidate', revision: 1 });
    });
    it('allows explicit withdrawal after source edits while forbidding new trust', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await db`update allrice_messages set content='{"text":"edited origin","citations":[]}' where id=${f.message}`;
      await expect(
        store.review(f.owner, c.id, decision(c)),
      ).rejects.toMatchObject({ code: 'source_changed' });
      expect(
        await store.review(f.owner, c.id, decision(c, 'reject')),
      ).toMatchObject({ status: 'rejected', archived: true, revision: 2 });
    });
    it('keeps old Memory deletion effective and reports archived approved records honestly', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await store.review(f.owner, c.id, decision(c));
      await deleteWorkspaceMemory(f.owner, f.workspace, c.id);
      expect((await store.list(f.owner))[0]).toMatchObject({
        status: 'approved',
        archived: true,
        canReview: false,
      });
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: f.input.content,
        }),
      ).toEqual([]);
    });
    it('prevents immutable source/scope mutation at the database boundary', async () => {
      const f = await fixture(),
        c = await store.create(f.owner, f.input);
      await expect(
        db`update allrice_experience_reviews set requested_scope='workspace',share_acknowledged=true where memory_id=${c.id}`,
      ).rejects.toThrow('immutable');
      await store.review(f.owner, c.id, decision(c));
      await expect(
        db`update allrice_experience_reviews set review_reason='rewrite approval' where memory_id=${c.id}`,
      ).rejects.toThrow('immutable');
    });
    it('a read-only viewer or disabled feature cannot write candidates', async () => {
      const f = await fixture();
      await db`update allrice_memberships set role='viewer' where user_id=${f.user}`;
      await expect(store.create(f.owner, f.input)).rejects.toMatchObject({
        code: 'identity_denied',
      });
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '0');
      try {
        await expect(store.list(f.owner)).rejects.toMatchObject({
          code: 'disabled',
        });
      } finally {
        vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      }
    });
    it('freezes the approved memory revision into a real next queued Run and actual Worker kernel, preserving earlier Run', async () => {
      const f = await fixture();
      const oldSession = await createChatSession(f.owner, {
        workspaceId: f.workspace,
        title: 'Before experience',
      });
      const before = await sendChatMessage(
        f.owner,
        f.workspace,
        oldSession.id,
        {
          clientMessageId: randomUUID(),
          text: 'Reconciliation rule: preserve original files and use decimal amounts.',
        },
      );
      const c = await store.create(f.owner, f.input);
      await store.review(f.owner, c.id, decision(c));
      const newSession = await createChatSession(f.owner, {
        workspaceId: f.workspace,
        title: 'After experience',
      });
      const after = await sendChatMessage(f.owner, f.workspace, newSession.id, {
        clientMessageId: randomUUID(),
        text: f.input.content,
      });
      const rows = await db<
        {
          run_id: string;
          prompt_snapshot: {
            memories: { id: string; revision?: number; content: string }[];
          };
          employee_assignment_id: string;
          employee_version_id: string;
          user_message_id: string;
          assistant_message_id: string;
        }[]
      >`select * from allrice_employee_runs where session_id in (${oldSession.id},${newSession.id}) order by created_at`;
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.prompt_snapshot.memories).toEqual([]);
      expect(rows[1]!.prompt_snapshot.memories).toEqual([
        expect.objectContaining({
          id: c.id,
          revision: 2,
          content: f.input.content,
        }),
      ]);
      const next = rows[1]!;
      const resolved = await resolveEmployeeExecution({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        runId: next.run_id,
      });
      const kernel = assembleEmployeeKernel({
        resolved,
        sessionId: newSession.id,
        employeeAssignmentId: next.employee_assignment_id,
        employeeVersionId: next.employee_version_id,
        userMessageId: next.user_message_id,
        assistantMessageId: next.assistant_message_id,
      });
      expect(kernel.authorizedMemoryContext).toContain(`revision 2`);
      expect(kernel.authorizedMemoryContext).toContain(f.input.content);
      const [old] =
        await db`select prompt_snapshot from allrice_employee_runs where run_id=${rows[0]!.run_id}`;
      expect(old?.prompt_snapshot.memories).toEqual([]);
    });
  },
);
