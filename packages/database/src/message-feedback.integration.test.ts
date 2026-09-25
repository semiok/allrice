import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  getTenantFeedback,
  listMessageFeedback,
  listTenantFeedback,
  mutateMessageFeedback,
  reviewTenantFeedback,
} from './message-feedback.ts';
import { recordRunFeedback } from './employees/employee-quality.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'tenant feedback: native CAS, tenant scope and platform inbox (no model)',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixture) await fixture.close();
    });
    const setup = () => createExperienceFixture(fixture.db);
    it('serializes cold ratings, rejects stale changes, retracts and rotates opaque versions', async () => {
      const f = await setup();
      const input = {
        messageId: f.assistant,
        rating: 'negative',
        note: '需要补充来源',
        category: 'task-result',
        ifVersion: null,
      };
      const put = (body: unknown) =>
        mutateMessageFeedback(f.owner, f.session.id, 'put', body);
      const results = await Promise.all([put(input), put(input)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toMatchObject([
        { error: { code: 'version-conflict' } },
      ]);
      const before = (await listMessageFeedback(f.owner, f.session.id))
        .items[0]!;
      expect(before).toMatchObject({
        messageId: f.assistant,
        rating: 'negative',
        note: input.note,
        category: input.category,
      });
      expect(
        await mutateMessageFeedback(f.owner, f.session.id, 'delete', {
          messageId: f.assistant,
          ifVersion: before.version,
        }),
      ).toEqual({ ok: true, value: { absent: true } });
      await put(input);
      expect(
        (await listMessageFeedback(f.owner, f.session.id)).items[0]!.version,
      ).not.toBe(before.version);
      expect(await put({ ...input, ifVersion: before.version })).toMatchObject({
        ok: false,
        error: { code: 'version-conflict' },
      });
      await recordRunFeedback(f.owner, f.run, {
        workspaceId: f.workspace,
        messageId: f.assistant,
        helpful: true,
        reason: '旧接口仍兼容',
      });
      expect(
        (await listMessageFeedback(f.owner, f.session.id)).items,
      ).toMatchObject([{ rating: 'positive', note: '旧接口仍兼容' }]);
      expect(
        await fixture.db`select id from allrice_jobs where organization_id=${f.org}`,
      ).toHaveLength(0);
    });
    it('denies other tenants, other members, revoked memberships and non-platform inbox access', async () => {
      const f = await setup(),
        other = await setup();
      const input = {
        messageId: f.assistant,
        rating: 'positive',
        ifVersion: null,
      };
      for (const actor of [f.neighbor, other.owner]) {
        await expect(
          listMessageFeedback(actor, f.session.id),
        ).rejects.toThrow();
        await expect(
          mutateMessageFeedback(actor, f.session.id, 'put', input),
        ).rejects.toThrow();
        await expect(listTenantFeedback(actor, {})).rejects.toThrow(
          'authorization_denied',
        );
      }
      expect(
        await mutateMessageFeedback(f.owner, f.session.id, 'put', {
          ...input,
          messageId: other.assistant,
        }),
      ).toMatchObject({ ok: false, error: { code: 'target-not-found' } });
      expect(
        await mutateMessageFeedback(f.owner, f.session.id, 'put', {
          ...input,
          messageId: f.message,
        }),
      ).toMatchObject({ ok: false });
      await fixture.db`update allrice_messages set status='pending' where id=${f.assistant}`;
      expect(
        await mutateMessageFeedback(f.owner, f.session.id, 'put', input),
      ).toMatchObject({ ok: false });
      await fixture.db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(listMessageFeedback(f.owner, f.session.id)).rejects.toThrow(
        'identity_denied',
      );
    });
    it('shows the real question and reply in the platform inbox, handles filters and protects review races', async () => {
      const f = await setup();
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${f.reviewer.actor.id}@example.test`,
      );
      await mutateMessageFeedback(f.owner, f.session.id, 'put', {
        messageId: f.assistant,
        rating: 'negative',
        category: 'instruction-following',
        note: '没有按要求分段',
        ifVersion: null,
      });
      const inbox = await listTenantFeedback(f.reviewer, {
        organizationId: f.org,
        category: 'instruction-following',
        rating: 'negative',
        status: 'new',
      });
      expect(inbox.total).toBe(1);
      expect(inbox.pending).toBe(1);
      const row = inbox.items[0]!;
      const detail = await getTenantFeedback(f.reviewer, row.id);
      expect(detail).toMatchObject({
        run_id: f.run,
        session_id: f.session.id,
        answer: 'Synthetic task delivered',
      });
      expect(detail.question).toContain('Reconciliation rule');
      expect(detail).not.toHaveProperty('provider_snapshot');
      expect(
        await reviewTenantFeedback(f.reviewer, row.id, {
          ifVersion: row.version,
          status: 'resolved',
          note: '已更新员工提示词',
        }),
      ).toMatchObject({ updated: true });
      expect(
        await reviewTenantFeedback(f.reviewer, row.id, {
          ifVersion: row.version,
          status: 'reviewing',
        }),
      ).toEqual({ updated: false });
      expect(
        (
          await listTenantFeedback(f.reviewer, {
            organizationId: f.org,
            status: 'resolved',
          })
        ).total,
      ).toBe(1);
      const observed = (await listMessageFeedback(f.owner, f.session.id))
        .items[0]!;
      await mutateMessageFeedback(f.owner, f.session.id, 'put', {
        messageId: f.assistant,
        rating: 'positive',
        ifVersion: observed.version,
      });
      expect((await getTenantFeedback(f.reviewer, row.id)).review_status).toBe(
        'new',
      );
      expect(
        (await listTenantFeedback(f.reviewer, { organizationId: randomUUID() }))
          .total,
      ).toBe(0);
    });
  },
);
