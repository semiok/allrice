import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NativeSubagentControlResultSchema,
  type EmployeeRuntimePackage,
  type NativeSubagentControlInput,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { assertNativeRunAuthority } from '../run-delivery-authority.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../platform-employees/runtime-package.ts';
import { authenticateSession, createSession } from '../identity.ts';
import { bindJobNativeSession } from '../execution/queue.ts';
import { sendChatMessage } from '../workspace/service.ts';
import { newNativeGeneration } from './native-root-origin.ts';
import { readSessionNativeSubagentTarget } from './native-subagent-query.ts';
import { releaseConversationRuntime } from './conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
  deferConversationSteer,
  rejectConversationSteer,
} from './conversation-input.ts';
import {
  enqueueNativeSubagentControl,
  claimNativeSubagentControl,
  getNativeSubagentControl,
  recordNativeSubagentControlResult,
} from './native-subagent-control.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-230 C1 durable child-control ledger (no native dispatch)', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let runtimePackage: EmployeeRuntimePackage;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'c'.repeat(64));
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const employee = await createEmployeeAdministrationFixture(fixture.db);
    runtimePackage = buildEmployeeRuntimePackage({
      revision: 1,
      definition: {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
        },
      },
      skills: [],
    });
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function chat(nativeRootId?: string) {
    const f = await createRunAuthorityFixture(fixture.db, {
      configure: false,
      memberRole: 'member',
      runtimePackage,
      allowedTools: runtimePackage.runtimeManifest.toolNames,
      runtimePolicy: {
        harness: 'dsh',
        provider: runtimePackage.runtimeManifest.provider,
        model: runtimePackage.runtimeManifest.model,
        reasoningEffort: 'xhigh',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'deployment:synthetic-never-resolved',
        baseUrl: null,
      },
      businessCreationOrigin: true,
    });
    expect(f.manifest.securityPolicy.deniedCapabilities).toEqual(
      runtimePackage.runtimeManifest.deniedCapabilities,
    );
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    const [runtime] =
      await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
    const descriptor = nativeBindingDescriptor({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      contextKey: f.session,
      distributionGeneration: newNativeGeneration,
    });
    if (nativeRootId) descriptor.nativeSessionId = nativeRootId;
    const bound = await bindJobNativeSession({
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
    if (!bound.conversation) throw Error('fixture chat binding missing');
    // First binding advances generation. Exercise the same returned identity
    // that the real Worker carries forward, not the pre-bind fixture value.
    expect(bound.conversation).toMatchObject({
      state: 'running',
      activeRunId: f.rootRunId,
      workerId: f.worker.workerId,
      threadId: descriptor.nativeSessionId,
      generation: runtime!.thread_generation + 1,
    });
    const worker = {
      ...f.worker,
      generation: bound.conversation.generation,
      attempt: 1,
    };
    const login = await createSession(f.user);
    const context = await authenticateSession(login.token, {
      organizationId: f.org,
      workspaceId: f.workspace,
    });
    if (!context) throw Error('fixture authentication failed');
    const authority = { ...f.base, worker };
    // Validate the complete immutable package/manifest, policy and lease gates
    // before individual scenarios change authority or exercise the ledger.
    expect(await assertNativeRunAuthority(authority)).toMatchObject({
      ownerId: f.user,
      nativeSessionId: descriptor.nativeSessionId,
    });
    const pin = await readSessionNativeSubagentTarget(fixture.db, {
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.session,
    });
    expect(pin.descriptor).toEqual(descriptor);
    return {
      ...f,
      worker,
      context,
      descriptor,
      authority,
      pin,
    };
  }
  type Chat = Awaited<ReturnType<typeof chat>>;
  const prompt = (f: Chat): NativeSubagentControlInput => ({
    kind: 'prompt',
    requestId: randomUUID(),
    parentSessionId: f.descriptor.nativeSessionId,
    childSessionId: `synthetic-child-${randomUUID()}`,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'Use corrected numbers.' }],
    clientTimeZone: 'Asia/Shanghai',
  });
  const expected = (f: Chat, input: NativeSubagentControlInput) => ({
    rootRunId: f.rootRunId,
    generation: f.worker.generation,
    input,
  });
  const enqueue = (f: Chat, input: NativeSubagentControlInput) =>
    enqueueNativeSubagentControl(f.context, f.session, expected(f, input));
  const read = (f: Chat, id: string) =>
    getNativeSubagentControl(f.context, f.session, id);
  const close = (f: Chat) =>
    releaseConversationRuntime({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      runId: f.rootRunId,
      workerId: f.worker.workerId,
      outcome: 'idle',
    });
  async function executionCounts(f: Chat) {
    const [row] = await fixture.db`select
      (select count(*) from allrice_runs where organization_id=${f.org}) as runs,
      (select count(*) from allrice_jobs where organization_id=${f.org}) as jobs,
      (select count(*) from allrice_conversation_followups where session_id=${f.session}) as followups,
      (select count(*) from allrice_messages where session_id=${f.session}) as messages`;
    return row;
  }

  it('records once through the real DB entry, freezes the server incarnation and creates no execution placeholders', async () => {
    const f = await chat(),
      input = prompt(f),
      before = await executionCounts(f);
    const tickets = await Promise.all([enqueue(f, input), enqueue(f, input)]);
    expect(tickets[0]).toEqual(tickets[1]);
    expect(tickets[0]).toMatchObject({
      requestId: input.requestId,
      result: { status: 'recorded' },
    });
    const saved = await read(f, input.requestId);
    expect(saved?.request.scope).toMatchObject({
      rootRunId: f.rootRunId,
      nativeRootId: f.descriptor.nativeSessionId,
      generation: f.worker.generation,
      jobId: f.worker.jobId,
      jobAttempt: 1,
      rootOriginDigest: f.pin.rootOriginDigest,
      storageNamespace: f.descriptor.storageNamespace,
    });
    expect(JSON.stringify(saved?.ticket)).not.toContain(
      f.descriptor.storageNamespace,
    );
    expect(await executionCounts(f)).toEqual(before);
    await expect(
      enqueue(f, { ...input, childSessionId: 'different' }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, input),
        generation: f.worker.generation + 1,
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const [row] =
      await fixture.db`select followup_run_id,client_user_message_id,expected_turn_id,message,input_kind,delivery_attempts
      from allrice_conversation_commands where id=${input.requestId}`;
    expect(row).toEqual({
      followup_run_id: null,
      client_user_message_id: null,
      expected_turn_id: null,
      message: null,
      input_kind: null,
      delivery_attempts: 0,
    });
    await expect(
      fixture.db`update allrice_conversation_commands set native_input='{}' where id=${input.requestId}`,
    ).rejects.toThrow('immutable native child command');
  });

  it('freezes ordered native text parts and reuses only the same immutable content', async () => {
    const f = await chat();
    const input = {
      ...prompt(f),
      kind: 'prompt' as const,
      delivery: 'queue' as const,
      content: [
        { type: 'text' as const, text: '请按修正数值计算。' },
        { type: 'text' as const, text: '' },
        { type: 'text' as const, text: '第二项改为 500。' },
      ],
    };
    const original = structuredClone(input.content);
    const ticket = await enqueue(f, input);
    input.content[0]!.text = 'changed after enqueue';
    expect((await read(f, input.requestId))?.request.input).toMatchObject({
      content: original,
    });
    expect(await enqueue(f, { ...input, content: original })).toEqual(ticket);
    await expect(enqueue(f, input)).rejects.toThrow('CHILD_CONTROL_CONFLICT');
  });

  it('canonicalizes PG UUID identities on first uppercase submission and retries while retaining opaque native case', async () => {
    const f = await chat('NativeRoot-MixedCase-' + randomUUID());
    const input = {
      ...prompt(f),
      requestId: 'A1000000-A001-4000-8000-000000000001',
      childSessionId: 'NativeChild-MixedCase',
    };
    const ticket = await enqueueNativeSubagentControl(f.context, f.session, {
      ...expected(f, input),
      rootRunId: f.rootRunId.toUpperCase(),
    });
    const canonical = input.requestId.toLowerCase();
    expect(ticket.requestId).toBe(canonical);
    expect(await enqueue(f, { ...input, requestId: canonical })).toEqual(
      ticket,
    );
    expect(await enqueue(f, input)).toEqual(ticket);
    for (const address of [
      { parentSessionId: input.parentSessionId.toLowerCase() },
      { childSessionId: input.childSessionId.toLowerCase() },
    ]) {
      await expect(enqueue(f, { ...input, ...address })).rejects.toThrow(
        'CHILD_CONTROL_CONFLICT',
      );
    }
    const request = await claimNativeSubagentControl({
      ...f.authority,
      rootRunId: f.rootRunId.toUpperCase(),
      worker: {
        ...f.authority.worker,
        jobId: f.worker.jobId.toUpperCase(),
      },
    });
    expect(request?.scope).toMatchObject({
      rootRunId: f.rootRunId,
      jobId: f.worker.jobId,
      nativeRootId: f.descriptor.nativeSessionId,
    });
    expect(request?.input).toMatchObject({
      requestId: canonical,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
    });
    if (!request) throw Error('expected first claim');
    const upperRequest = {
      ...request,
      scope: {
        ...request.scope,
        rootRunId: f.rootRunId.toUpperCase(),
        jobId: f.worker.jobId.toUpperCase(),
      },
      input: { ...request.input, requestId: input.requestId },
    };
    const observation = {
      status: 'accepted' as const,
      acceptance: {
        kind: 'prompt' as const,
        messageId: 'NativeMessage-MixedCase',
      },
      source: { kind: 'user_rpc' as const, rpcId: canonical, sequence: 2 },
    };
    // RPC source is native evidence: only PG input identities canonicalize.
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, upperRequest, {
        ...observation,
        source: { ...observation.source, rpcId: input.requestId },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const accepted = await recordNativeSubagentControlResult(
      f.context,
      f.session,
      upperRequest,
      observation,
    );
    expect(accepted.result).toEqual(observation);
    expect((await read(f, input.requestId))?.ticket).toEqual(accepted);
  });

  it('rejects foreign/currently revoked owners, stale roots and stale generations before storing a ticket', async () => {
    const f = await chat(),
      other = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    await expect(
      getNativeSubagentControl(other.context, f.session, input.requestId),
    ).rejects.toThrow('artifact_not_found');
    await expect(
      enqueueNativeSubagentControl(
        other.context,
        f.session,
        expected(f, prompt(f)),
      ),
    ).rejects.toThrow('artifact_not_found');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, prompt(f)),
        rootRunId: other.rootRunId,
      }),
    ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, prompt(f)),
        generation: f.worker.generation + 1,
      }),
    ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
    await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(enqueue(f, prompt(f))).rejects.toThrow('identity_denied');
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(0);
  });

  it('claims atomically once; stale time and every old steer mutator cannot replay or consume a child command', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    const claims = await Promise.all([
      claimNativeSubagentControl(f.authority),
      claimNativeSubagentControl(f.authority),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.input).toEqual(input);
    await fixture.db`update allrice_conversation_commands set claimed_at=clock_timestamp()-interval '2 minutes' where id=${input.requestId}`;
    const old = { commandId: input.requestId, workerId: f.worker.workerId };
    await deferConversationSteer(old);
    await rejectConversationSteer({ ...old, errorCode: 'OLD_STEER_REJECT' });
    await consumeConversationSteer(old);
    expect(await claimNativeSubagentControl(f.authority)).toBeNull();
    expect((await read(f, input.requestId))?.ticket.result).toEqual({
      status: 'unknown',
    });
    expect(
      (
        await fixture.db`select state,delivery_attempts,native_proof from allrice_conversation_commands where id=${input.requestId}`
      )[0],
    ).toEqual({ state: 'claimed', delivery_attempts: 1, native_proof: null });
  });

  it('never transfers a pending command to a later Job incarnation or an expired execution lease', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      await claimNativeSubagentControl({
        ...f.authority,
        worker: { ...f.authority.worker, attempt: 2 },
      }),
    ).toBeNull();
    await fixture.db`update allrice_jobs set attempt=1,lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(0);
  });

  it('preserves legacy NOT NULL semantics and the real steer defer/reclaim/consume path', async () => {
    const f = await chat(),
      turnId = `${f.descriptor.nativeSessionId}:turn:1`;
    await expect(fixture.db`insert into allrice_conversation_commands
      (organization_id,workspace_id,session_id,owner_id,command_type,expected_generation)
      values(${f.org},${f.workspace},${f.session},${f.user},'steer',${f.worker.generation})`).rejects.toMatchObject(
      { code: '23514' },
    );
    await fixture.db`update allrice_conversation_runtimes set active_turn_id=${turnId} where session_id=${f.session}`;
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${f.rootRunId},1,'turn.started',${fixture.db.json({ turnId, generation: f.worker.generation })})`;
    const sent = await sendChatMessage(f.context, f.workspace, f.session, {
      clientMessageId: randomUUID(),
      text: 'A legacy steer.',
      deliveryMode: 'steer',
      expectedTurnId: turnId,
      expectedGeneration: f.worker.generation,
    });
    expect(sent.delivery).toBe('steer_pending');
    const child = prompt(f);
    await enqueue(f, child);
    const oldInput = {
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      workerId: f.worker.workerId,
      generation: f.worker.generation,
      turnId,
      runId: f.rootRunId,
      drain: true,
    };
    const old = await claimConversationSteer(oldInput);
    expect(old).not.toBeNull();
    expect(old!.id).not.toBe(child.requestId);
    await deferConversationSteer({
      commandId: old!.id,
      workerId: f.worker.workerId,
    });
    await claimConversationSteer(oldInput);
    await fixture.db`update allrice_conversation_commands set claimed_at=clock_timestamp()-interval '2 minutes' where id=${old!.id}`;
    expect((await claimConversationSteer(oldInput))?.id).toBe(old!.id);
    await consumeConversationSteer({
      commandId: old!.id,
      workerId: f.worker.workerId,
      proof: {
        status: 'adopted',
        inputId: old!.clientUserMessageId,
        messageId: randomUUID(),
        turnId,
        runId: f.rootRunId,
        sequence: 3,
        checkpoint: 'step_user_message',
      },
    });
    expect(
      (
        await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${old!.id}`
      )[0],
    ).toEqual({ state: 'consumed', delivery_attempts: 3 });
    expect((await read(f, child.requestId))?.ticket.result).toEqual({
      status: 'recorded',
    });
  });

  it('closes unclaimed input definitively but preserves claimed unknown and only supplements positive original-request receipts', async () => {
    const f = await chat(),
      first = prompt(f),
      pending = prompt(f);
    const before = await executionCounts(f);
    await enqueue(f, first);
    const request = (await claimNativeSubagentControl(f.authority))!;
    await enqueue(f, pending);
    await close(f);
    expect((await read(f, first.requestId))?.ticket.result).toEqual({
      status: 'unknown',
    });
    expect((await read(f, pending.requestId))?.ticket.result).toEqual({
      status: 'rejected',
      code: 'TURN_CLOSED',
    });
    expect((await enqueue(f, first)).result).toEqual({ status: 'unknown' });
    await expect(enqueue(f, prompt(f))).rejects.toThrow(
      'CHILD_CONTROL_UNAVAILABLE',
    );
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    // Synthetic trusted-observer evidence: C3 must verify actual own-suffix
    // user/source.rpcId in the original namespace; this suite never opens DSH.
    const positive = {
      status: 'accepted' as const,
      acceptance: { kind: 'prompt' as const, messageId: 'native-message-17' },
      source: {
        kind: 'user_rpc' as const,
        rpcId: first.requestId,
        sequence: 17,
      },
    };
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        source: { ...positive.source, rpcId: randomUUID() },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    await expect(
      recordNativeSubagentControlResult(
        f.context,
        f.session,
        { ...request, scope: { ...request.scope, rootRunId: randomUUID() } },
        positive,
      ),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const accepted = await recordNativeSubagentControlResult(
      f.context,
      f.session,
      request,
      positive,
    );
    expect(accepted.result).toEqual(positive);
    expect(
      await recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        source: { kind: 'native_ack' },
      }),
    ).toEqual(accepted);
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        acceptance: { kind: 'prompt', messageId: 'ambiguous-other-message' },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    expect(
      await recordNativeSubagentControlResult(f.context, f.session, request, {
        status: 'unknown',
      }),
    ).toEqual(accepted);
    const pendingRequest = (await read(f, pending.requestId))!.request;
    expect(
      (
        await recordNativeSubagentControlResult(
          f.context,
          f.session,
          pendingRequest,
          { ...positive, source: { kind: 'native_ack' } },
        )
      ).result,
    ).toEqual({ status: 'rejected', code: 'TURN_CLOSED' });
    expect(await executionCounts(f)).toEqual(before);
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${first.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(1);
  });

  it('records prompt unknown honestly and interrupt ACK as acceptance, never as stopped/completed', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    const request = (await claimNativeSubagentControl(f.authority))!;
    expect(
      (
        await recordNativeSubagentControlResult(f.context, f.session, request, {
          status: 'unknown',
        })
      ).result,
    ).toEqual({ status: 'unknown' });
    expect(await claimNativeSubagentControl(f.authority)).toBeNull();
    expect(
      NativeSubagentControlResultSchema.safeParse({
        status: 'rejected',
        code: 'INPUT_OUTCOME_UNKNOWN',
      }).success,
    ).toBe(false);
    const stop: NativeSubagentControlInput = {
      kind: 'interrupt',
      requestId: randomUUID(),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      mode: 'continuable',
    };
    await enqueue(f, stop);
    const stopRequest = (await claimNativeSubagentControl(f.authority))!;
    const accepted = {
      status: 'accepted' as const,
      acceptance: { kind: 'interrupt' as const, accepted: true as const },
      source: { kind: 'native_ack' as const },
    };
    expect(
      (
        await recordNativeSubagentControlResult(
          f.context,
          f.session,
          stopRequest,
          accepted,
        )
      ).result,
    ).toEqual(accepted);
    expect((await read(f, stop.requestId))!.request.input).toEqual(stop);
  });
});
