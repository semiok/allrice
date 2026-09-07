import { describe, expect, it } from 'vitest';

import {
  BridgeCapabilities,
  BridgeCapabilitySchema,
  BridgeCommandPayloadSchema,
  BridgeCommandStatusSchema,
  BridgeProtocolVersion,
  BridgeProtocolVersionSchema,
  ChatFlowEventEnvelopeSchema,
  ChatMessageContentSchema,
  CreateRunInputSchema,
  HeartbeatBridgeDeviceInputSchema,
  JobSchema,
  JobStatusSchema,
  PairBridgeDeviceInputSchema,
  RunEventSchema,
  RunEventTypeSchema,
  RunStatusSchema,
  SendChatMessageInputSchema,
  UserQuestionAnswerSubmissionSchema,
  UserQuestionRequestSchema,
  canTransitionJob,
  isTerminalRunStatus,
  validateRunEventSequence,
} from '../index.ts';

const id = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const now = '2026-09-07T09:00:00Z';
const bridgeCapabilities = [
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
];

describe('P01 additive contracts preserve the production wire contract', () => {
  it('preserves exact Run and Job states rather than adding operation lifecycle states', () => {
    expect(RunStatusSchema.options).toEqual([
      'queued',
      'running',
      'waiting_approval',
      'succeeded',
      'failed',
      'canceled',
      'needs_attention',
    ]);
    expect(JobStatusSchema.options).toEqual([
      'queued',
      'claimed',
      'running',
      'waiting_approval',
      'retry_wait',
      'succeeded',
      'failed',
      'dead_letter',
      'canceled',
    ]);
    for (const state of [
      'unknown',
      'cancel_requested',
      'partially_completed',
    ]) {
      expect(RunStatusSchema.safeParse(state).success).toBe(false);
      expect(JobStatusSchema.safeParse(state).success).toBe(false);
    }
    expect(isTerminalRunStatus('needs_attention')).toBe(false);
    for (const state of ['succeeded', 'failed', 'canceled'] as const) {
      expect(isTerminalRunStatus(state)).toBe(true);
    }
  });

  it('preserves existing Job transitions, attempt zero and create defaults', () => {
    expect(canTransitionJob('running', 'queued')).toBe(false);
    expect(canTransitionJob('running', 'queued', { leaseExpired: true })).toBe(
      true,
    );
    expect(canTransitionJob('waiting_approval', 'queued')).toBe(true);
    expect(
      canTransitionJob('succeeded', 'queued', { leaseExpired: true }),
    ).toBe(false);
    expect(
      CreateRunInputSchema.parse({
        workspaceId: id,
        idempotencyKey: 'p01-legacy',
        type: 'system.echo',
        input: {},
      }),
    ).toEqual({
      workspaceId: id,
      idempotencyKey: 'p01-legacy',
      type: 'system.echo',
      input: {},
      priority: 0,
      maxAttempts: 3,
      timeoutMs: 300_000,
    });
    const job = {
      id,
      organizationId: id,
      workspaceId: id,
      ownerId: id,
      status: 'queued',
      idempotencyKey: 'p01-legacy',
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      availableAt: now,
      timeoutAt: now,
      payload: { schemaVersion: 1, type: 'system.echo', input: {} },
      lease: null,
    };
    expect(JobSchema.parse(job)).toEqual(job);
  });

  it('locks legacy event names and RunEvent version rather than publishing new events', () => {
    expect(RunEventTypeSchema.options).toEqual([
      'run.created',
      'run.started',
      'run.retrying',
      'session.bound',
      'turn.started',
      'turn.completed',
      'turn.failed',
      'turn.canceled',
      'routing.selected',
      'step.started',
      'step.completed',
      'step.waiting_approval',
      'step.retrying',
      'step.compensating',
      'step.compensated',
      'assistant.text.delta',
      'assistant.text.completed',
      'harness.native',
      'tool.started',
      'tool.completed',
      'tool.failed',
      'artifact.created',
      'approval.requested',
      'approval.decided',
      'knowledge.retrieved',
      'context.compaction.started',
      'context.compaction.completed',
      'context.compaction.failed',
      'context.checkpoint.created',
      'usage.updated',
      'run.succeeded',
      'run.failed',
      'run.canceled',
      'run.needs_attention',
      'heartbeat',
    ]);
    const event = {
      eventId: id,
      runId: id,
      sequence: 0,
      type: 'run.created',
      schemaVersion: 1,
      occurredAt: now,
      payload: {},
    };
    expect(RunEventSchema.parse(event)).toEqual(event);
    expect(
      RunEventSchema.safeParse({ ...event, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({ ...event, type: 'operation.updated' }).success,
    ).toBe(false);
  });

  it('preserves terminal event closure while needs_attention stays nonterminal', () => {
    const event = {
      eventId: id,
      runId: id,
      sequence: 0,
      type: 'run.needs_attention',
      schemaVersion: 1,
      occurredAt: now,
      payload: {},
    };
    const next = RunEventSchema.parse({
      ...event,
      eventId: secondId,
      sequence: 1,
      type: 'heartbeat',
    });
    expect(() =>
      validateRunEventSequence([RunEventSchema.parse(event), next]),
    ).not.toThrow();
    expect(() =>
      validateRunEventSequence([
        RunEventSchema.parse({ ...event, type: 'run.succeeded' }),
        next,
      ]),
    ).toThrow('run event emitted after terminal event');
  });

  it('keeps ChatFlow at envelope v3 with nullable conversation/native source', () => {
    const envelope = {
      schemaVersion: 3,
      eventId: id,
      organizationId: id,
      workspaceId: id,
      conversationId: null,
      runId: id,
      generation: null,
      cursor: `${id}:0`,
      sequence: 0,
      harness: null,
      type: 'run.created',
      occurredAt: now,
      sourceEvent: null,
      payload: {},
    };
    expect(ChatFlowEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
    for (const schemaVersion of [1, 2, 4]) {
      expect(
        ChatFlowEventEnvelopeSchema.safeParse({ ...envelope, schemaVersion })
          .success,
      ).toBe(false);
    }
    expect(
      ChatFlowEventEnvelopeSchema.safeParse({ ...envelope, operationId: id })
        .success,
    ).toBe(false);
  });

  it('does not advertise capabilities an existing Bridge executor cannot execute', () => {
    expect(BridgeCapabilitySchema.options).toEqual(bridgeCapabilities);
    expect(BridgeCapabilities).toEqual(bridgeCapabilities);
    expect(BridgeCommandStatusSchema.options).toEqual([
      'queued',
      'claimed',
      'running',
      'succeeded',
      'failed',
      'expired',
      'canceled',
    ]);
    for (const capability of [
      'local.command.execute',
      'local.shell',
      'local.process.start',
    ]) {
      expect(BridgeCapabilitySchema.safeParse(capability).success).toBe(false);
      expect(
        BridgeCommandPayloadSchema.safeParse({ capability, arguments: {} })
          .success,
      ).toBe(false);
    }
    expect(
      BridgeCommandPayloadSchema.parse({
        capability: 'local.fs.read',
        arguments: { path: 'src/index.ts' },
      }),
    ).toEqual({
      capability: 'local.fs.read',
      arguments: { path: 'src/index.ts', maxBytes: 200_000 },
    });
  });

  it('keeps Bridge record compatibility at v1/v2 and current pairing/heartbeat at v2', () => {
    expect(BridgeProtocolVersion).toBe(2);
    expect(BridgeProtocolVersionSchema.safeParse(1).success).toBe(true);
    expect(BridgeProtocolVersionSchema.safeParse(2).success).toBe(true);
    expect(BridgeProtocolVersionSchema.safeParse(3).success).toBe(false);
    for (const code of ['ABCD1234', 'ABCD-1234', 'abcd-1234']) {
      expect(
        PairBridgeDeviceInputSchema.safeParse({
          code,
          name: 'Synthetic Bridge',
          platform: 'macos-arm64',
          protocolVersion: 2,
          capabilities: bridgeCapabilities,
        }).success,
      ).toBe(true);
    }
    for (const protocolVersion of [1, 3]) {
      expect(
        PairBridgeDeviceInputSchema.safeParse({
          code: 'ABCD1234',
          name: 'Synthetic Bridge',
          platform: 'macos-x64',
          protocolVersion,
          capabilities: bridgeCapabilities,
        }).success,
      ).toBe(false);
      expect(
        HeartbeatBridgeDeviceInputSchema.safeParse({
          protocolVersion,
          capabilities: bridgeCapabilities,
        }).success,
      ).toBe(false);
    }
    expect(
      HeartbeatBridgeDeviceInputSchema.parse({
        protocolVersion: 2,
        capabilities: bridgeCapabilities,
      }),
    ).toEqual({ protocolVersion: 2, capabilities: bridgeCapabilities });
  });

  it('preserves string question IDs, the old answer shape and multiSelect default', () => {
    expect(
      UserQuestionRequestSchema.parse({
        questionId: 'question-1',
        questions: [
          {
            id: 'format',
            question: 'Which format?',
            options: [{ label: 'xlsx' }],
            intent: { kind: 'plan-review', approve: 'Continue' },
          },
        ],
      }),
    ).toEqual({
      questionId: 'question-1',
      questions: [
        {
          id: 'format',
          question: 'Which format?',
          options: [{ label: 'xlsx' }],
          multiSelect: false,
          intent: { kind: 'plan-review', approve: 'Continue' },
        },
      ],
    });
    const answer = {
      questionId: 'question-1',
      answers: [{ id: 'format', selected: ['xlsx'] }],
    };
    expect(UserQuestionAnswerSubmissionSchema.parse(answer)).toEqual(answer);
    expect(
      UserQuestionAnswerSubmissionSchema.safeParse({
        ...answer,
        decision: 'approved',
      }).success,
    ).toBe(false);
    expect(
      ChatMessageContentSchema.parse({
        text: 'xlsx',
        interaction: { type: 'user_question_answer', answer },
      }),
    ).toEqual({
      text: 'xlsx',
      citations: [],
      interaction: { type: 'user_question_answer', answer },
    });
  });

  it('preserves SendChat defaults and exact-turn requirements for Ask User answers', () => {
    const basic = { clientMessageId: id, text: 'hello' };
    expect(SendChatMessageInputSchema.parse(basic)).toEqual({
      ...basic,
      attachmentIds: [],
      deliveryMode: 'auto',
    });
    const answer = {
      ...basic,
      deliveryMode: 'steer',
      expectedTurnId: 'turn-1',
      expectedGeneration: 0,
      userQuestionAnswer: {
        questionId: 'question-1',
        answers: [{ id: 'format', selected: ['xlsx'] }],
      },
    };
    expect(SendChatMessageInputSchema.safeParse(answer).success).toBe(true);
    for (const patch of [
      { deliveryMode: 'auto' },
      { deliveryMode: 'follow_up' },
      { expectedTurnId: undefined },
      { expectedGeneration: undefined },
      { expectedGeneration: -1 },
      { attachmentIds: [id] },
      { approvalId: id },
    ]) {
      expect(
        SendChatMessageInputSchema.safeParse({ ...answer, ...patch }).success,
      ).toBe(false);
    }
  });
});
