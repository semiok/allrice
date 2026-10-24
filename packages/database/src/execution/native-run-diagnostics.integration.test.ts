import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import { bindJobNativeSession } from './queue.ts';
import { getRunNativeDiagnosticTarget } from './native-run-diagnostics.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET200 native diagnostic Run authority and immutable reader association',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function chat() {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
      });
      await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
      const [runtime] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: f.session,
      });
      await bindJobNativeSession({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: runtime!.config_checksum,
          generation: runtime!.thread_generation,
          expectedThreadId: runtime!.thread_id,
        },
        descriptor,
      });
      const session = await createSession(f.user);
      const context = await authenticateSession(session.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('fixture authentication failed');
      return { ...f, descriptor, context };
    }
    async function receipts(
      f: Awaited<ReturnType<typeof chat>>,
      thread = f.descriptor.nativeSessionId,
    ) {
      const events = [
        {
          event: 'turn.started',
          payload: {
            source: 'dsh',
            threadId: thread,
            turnId: `${thread}:turn:1`,
            generation: 1,
          },
        },
        {
          event: 'assistant.text.completed',
          payload: {
            source: 'dsh',
            threadId: thread,
            generation: 1,
            attempt: 1,
            sourceEventId: 'dsh:7',
            sourceEventType: 'assistant/message',
            nativePayload: { turn: 1, text: 'not returned in receipt query' },
            text: 'private',
          },
        },
      ];
      for (const [i, item] of events.entries())
        await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${f.org},${f.workspace},${f.task.runId},${100 + i},${item.event},${fixture.db.json(item.payload)})`;
    }
    it('resolves exact Run/attempt/generation/thread/seq and keeps journal paths inside the trusted target', async () => {
      const f = await chat();
      await receipts(f);
      const target = await getRunNativeDiagnosticTarget(
        f.context,
        f.workspace,
        f.task.runId,
      );
      expect(target.slices).toHaveLength(1);
      expect(target.slices[0]).toMatchObject({
        attempt: 1,
        generation: 1,
        nativeSessionId: f.descriptor.nativeSessionId,
        receipts: [{ seq: 7, type: 'assistant/message', turn: 1 }],
        verifiedTurns: [1],
        reasons: [],
        execution: f.descriptor,
        binding: {
          ...f.descriptor,
          contextKind: 'chat',
          contextId: f.session,
          ownerId: f.user,
        },
      });
      expect(JSON.stringify(target)).not.toContain(
        'not returned in receipt query',
      );
      expect(JSON.stringify(target)).not.toContain('private');
      const peer = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${peer},${`${peer}@example.test`},'same-tenant peer','not-login')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${peer},'member')`;
      const peerSession = await createSession(peer);
      const peerContext = await authenticateSession(peerSession.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      await expect(
        getRunNativeDiagnosticTarget(peerContext!, f.workspace, f.task.runId),
      ).rejects.toMatchObject({ code: 'not_found' });
      const foreign = await chat();
      await expect(
        getRunNativeDiagnosticTarget(
          foreign.context,
          foreign.workspace,
          f.task.runId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    it('does not adopt a valid but unrelated conversation reader, and treats cross-Run turn claims as ambiguous', async () => {
      const f = await chat(),
        other = await chat();
      await receipts(f, other.descriptor.nativeSessionId);
      const unrelated = await getRunNativeDiagnosticTarget(
        f.context,
        f.workspace,
        f.task.runId,
      );
      expect(unrelated.slices[0]!.binding).toBeNull();
      expect(unrelated.slices[0]!.reasons).toContain('binding_unavailable');
      // This synthetic sibling belongs to the same tenant. The independent Run
      // start makes turn ownership unknown even when both SQL receipts are valid.
      const sibling = randomUUID();
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${sibling},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
      await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${sibling},0,'turn.started',${fixture.db.json({ source: 'dsh', threadId: other.descriptor.nativeSessionId, turnId: `${other.descriptor.nativeSessionId}:turn:1`, generation: 1 })})`;
      const conflict = await getRunNativeDiagnosticTarget(
        f.context,
        f.workspace,
        f.task.runId,
      );
      expect(conflict.slices[0]!.verifiedTurns).toEqual([]);
      expect(conflict.slices[0]!.reasons).toContain('source_ambiguous');
    });
  },
);
