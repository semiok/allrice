import { describe, expect, it } from 'vitest';

import { UserQuestionRequestSchema } from '../user-questions.ts';
import {
  RuntimeActionBindingSchema,
  RuntimeContentRefSchema,
  RuntimeTaskRefSchema,
} from './identity.ts';
import {
  matchesRuntimeActionApproval,
  matchesRuntimeInteractionResponse,
  matchesRuntimeTypedInput,
  RuntimeActionApprovalRequestSchema,
  RuntimeActionApprovalSnapshotSchema,
  RuntimeInputReceiptSchema,
  RuntimeInteractionRequestSchema,
  RuntimeInteractionResponseSchema,
  RuntimeTypedInputSchema,
  type RuntimeInteractionRequest,
  type RuntimeTypedInput,
} from './interactions.ts';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const differentDigest = `sha256:${'b'.repeat(64)}`;
const createdAt = '2026-09-07T10:00:00.000Z';
const now = '2026-09-07T10:01:00.000Z';
const expiresAt = '2026-09-07T10:05:00.000Z';
const scope = { organizationId: id(1), workspaceId: id(2), projectId: id(3) };
const task = RuntimeTaskRefSchema.parse({
  scope,
  chatSessionId: id(4),
  runId: id(5),
  rootRunId: id(5),
  parentRunId: null,
  frozenConfiguration: { employeeVersionId: id(6), digest },
});
const turn = { turnId: 'fixture-turn-2', generation: 2 };
const content = RuntimeContentRefSchema.parse({
  kind: 'deliverable_version',
  id: id(7),
  objectId: id(8),
  seriesId: id(9),
  version: 1,
  checksum: digest,
});

function actionBinding() {
  return RuntimeActionBindingSchema.parse({
    task,
    attempt: {
      operationId: id(10),
      attemptId: id(11),
      attemptNumber: 1,
      generation: 2,
      fence: 1,
    },
    requestedBy: { type: 'user', id: id(12) },
    execution: {
      targetId: id(13),
      targetKind: 'rice_bridge',
      deviceId: id(14),
      grantId: id(15),
      grantVersion: 1,
      scopeDigest: digest,
      workCopy: { id: id(16), kind: 'in_place' },
    },
    action: 'fixture.command.test',
    policy: { snapshotId: id(17), digest },
    inputDigest: digest,
    dataScope: [
      {
        content,
        sourceTargetId: id(13),
        purpose: 'execution_input',
        destination: 'in_place',
        authorizationId: id(18),
        authorizationVersion: 1,
      },
    ],
    baseline: [content],
    command: {
      executableDigest: digest,
      argumentsDigest: digest,
      workingDirectoryDigest: digest,
      effectiveEnvironmentDigest: digest,
      networkPolicyDigest: digest,
      toolchainDigest: digest,
      budgetDigest: digest,
    },
  });
}

function request(kind: RuntimeInteractionRequest['kind']) {
  const common = {
    contractVersion: 1,
    direction: 'request',
    requestId: id(20),
    version: 1,
    requestDigest: digest,
    task,
    respondentId: id(21),
    createdAt,
    expiresAt,
  };
  switch (kind) {
    case 'ask_user':
      return RuntimeInteractionRequestSchema.parse({
        ...common,
        kind,
        turn,
        question: {
          questionId: 'question-1',
          questions: [
            {
              id: 'format',
              question: 'Select a format',
              options: [{ label: 'CSV' }, { label: 'JSON' }],
              multiSelect: false,
            },
          ],
        },
      });
    case 'action_approval':
      return RuntimeInteractionRequestSchema.parse({
        ...common,
        kind,
        approvalId: id(22),
        binding: actionBinding(),
      });
    default:
      return RuntimeInteractionRequestSchema.parse({
        ...common,
        kind,
        content,
        prompt: 'Review this exact version',
      });
  }
}

function response(value: RuntimeInteractionRequest) {
  const common = {
    contractVersion: 1,
    direction: 'response',
    requestId: value.requestId,
    version: value.version,
    requestDigest: value.requestDigest,
    task: value.task,
    responseId: id(23),
    respondedBy: value.respondentId,
    respondedAt: now,
  };
  switch (value.kind) {
    case 'ask_user':
      return RuntimeInteractionResponseSchema.parse({
        ...common,
        kind: value.kind,
        turn: value.turn,
        answer: {
          questionId: value.question.questionId,
          answers: [{ id: 'format', selected: ['CSV'] }],
        },
      });
    case 'action_approval':
      return RuntimeInteractionResponseSchema.parse({
        ...common,
        kind: value.kind,
        approvalId: value.approvalId,
        decision: 'approved',
      });
    case 'plan_review':
      return RuntimeInteractionResponseSchema.parse({
        ...common,
        kind: value.kind,
        content: value.content,
        decision: 'accepted',
        feedback: null,
      });
    case 'version_feedback':
      return RuntimeInteractionResponseSchema.parse({
        ...common,
        kind: value.kind,
        content: value.content,
        feedback: 'Shorten the summary',
      });
  }
}

const matchContext = {
  trustedScope: scope,
  task,
  respondentId: id(21),
  activeTurn: turn,
  now,
};

function approvalSnapshot() {
  const item = request('action_approval');
  return RuntimeActionApprovalSnapshotSchema.parse({
    request: item,
    response: response(item),
    consumedAt: null,
    revokedAt: null,
  });
}

function changed<T>(value: T, path: string, replacement: unknown): T {
  const copy = structuredClone(value);
  const segments = path.split('.');
  let target = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1))
    target = target[segment] as Record<string, unknown>;
  target[segments[segments.length - 1]!] = replacement;
  return copy;
}

describe('Runtime typed interaction contracts', () => {
  it.each([
    'ask_user',
    'plan_review',
    'version_feedback',
    'action_approval',
  ] as const)(
    'keeps %s requests and replies strict and separately typed',
    (kind) => {
      const item = request(kind);
      const reply = response(item);
      expect(matchesRuntimeInteractionResponse(item, reply, matchContext)).toBe(
        true,
      );
      expect(RuntimeInteractionRequestSchema.safeParse(reply).success).toBe(
        false,
      );
      expect(RuntimeInteractionResponseSchema.safeParse(item).success).toBe(
        false,
      );
      expect(
        RuntimeInteractionResponseSchema.safeParse({
          ...reply,
          rawCredential: 'fixture-only',
        }).success,
      ).toBe(false);
      expect(
        RuntimeInteractionRequestSchema.safeParse({
          ...item,
          contractVersion: 99,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ['requestId', id(999)],
    ['version', 2],
    ['requestDigest', differentDigest],
    ['respondedBy', id(999)],
    ['task.scope.organizationId', id(999)],
    ['task.scope.workspaceId', id(999)],
    ['task.scope.projectId', null],
    ['task.chatSessionId', id(999)],
    ['task.frozenConfiguration.digest', differentDigest],
    ['respondedAt', '2026-09-07T09:59:00.000Z'],
    ['respondedAt', expiresAt],
  ])('rejects changed response correlation %s', (path, replacement) => {
    const item = request('plan_review');
    expect(
      matchesRuntimeInteractionResponse(
        item,
        changed(response(item), path as string, replacement),
        matchContext,
      ),
    ).toBe(false);
  });

  it('requires trusted scope/task/actor and a live lifetime, including expiry equality', () => {
    const item = request('plan_review');
    const reply = response(item);
    for (const context of [
      changed(matchContext, 'trustedScope.organizationId', id(999)),
      changed(matchContext, 'respondentId', id(999)),
      changed(matchContext, 'task.frozenConfiguration.digest', differentDigest),
      { ...matchContext, now: expiresAt },
      { ...matchContext, now: '2026-09-07T09:59:00.000Z' },
    ])
      expect(matchesRuntimeInteractionResponse(item, reply, context)).toBe(
        false,
      );
    expect(
      RuntimeInteractionRequestSchema.safeParse({
        ...item,
        expiresAt: createdAt,
      }).success,
    ).toBe(false);
    expect(
      RuntimeActionApprovalRequestSchema.safeParse({
        ...request('action_approval'),
        expiresAt: createdAt,
      }).success,
    ).toBe(false);
  });

  it('binds plan/feedback to an exact content version without granting an action', () => {
    for (const kind of ['plan_review', 'version_feedback'] as const) {
      const item = request(kind);
      const reply = response(item);
      for (const [path, value] of [
        ['content.version', 2],
        ['content.checksum', differentDigest],
        ['content.id', id(999)],
      ] as const) {
        expect(
          matchesRuntimeInteractionResponse(
            item,
            changed(reply, path, value),
            matchContext,
          ),
        ).toBe(false);
      }
      expect(
        matchesRuntimeActionApproval(
          { request: item, response: reply, consumedAt: null, revokedAt: null },
          { ...matchContext, binding: actionBinding() },
        ),
      ).toBe(false);
    }
    const reply = response(request('plan_review'));
    expect(
      RuntimeInteractionResponseSchema.safeParse({
        ...reply,
        decision: 'revision_requested',
        feedback: null,
      }).success,
    ).toBe(false);
    expect(
      RuntimeInteractionResponseSchema.safeParse({
        ...reply,
        decision: 'revision_requested',
        feedback: 'Change the title',
      }).success,
    ).toBe(true);
  });

  it('reuses the DSH question body and demands the exact current turn', () => {
    const item = request('ask_user');
    if (item.kind !== 'ask_user') throw new Error('fixture');
    const reply = response(item);
    expect(UserQuestionRequestSchema.parse(item.question)).toEqual(
      item.question,
    );
    expect(
      matchesRuntimeInteractionResponse(item, reply, {
        ...matchContext,
        activeTurn: null,
      }),
    ).toBe(false);
    for (const [path, value] of [
      ['turn.turnId', 'old-turn'],
      ['turn.generation', 1],
      ['answer.questionId', 'other-question'],
      ['answer.answers.0.id', 'unknown-item'],
      ['answer.answers.0.selected', ['unknown-option']],
      ['answer.answers.0.selected', ['CSV', 'JSON']],
      ['answer.answers.0.selected', ['CSV', 'CSV']],
      ['answer.answers.0.selected', []],
    ] as const)
      expect(
        matchesRuntimeInteractionResponse(
          item,
          changed(reply, path, value),
          matchContext,
        ),
      ).toBe(false);
    expect(
      matchesRuntimeInteractionResponse(item, reply, {
        ...matchContext,
        activeTurn: { ...turn, generation: 3 },
      }),
    ).toBe(false);
    const custom = changed(
      changed(reply, 'answer.answers.0.selected', []),
      'answer.answers.0.custom',
      'Plain text instead',
    );
    expect(matchesRuntimeInteractionResponse(item, custom, matchContext)).toBe(
      true,
    );
    const duplicate = {
      ...item,
      question: {
        ...item.question,
        questions: [item.question.questions[0], item.question.questions[0]],
      },
    };
    expect(RuntimeInteractionRequestSchema.safeParse(duplicate).success).toBe(
      false,
    );
    expect(
      matchesRuntimeActionApproval(
        { request: item, response: reply, consumedAt: null, revokedAt: null },
        { ...matchContext, binding: actionBinding() },
      ),
    ).toBe(false);
  });
});

describe('Runtime approval snapshot matching, not authorization/consumption', () => {
  it('matches an exact unconsumed snapshot without changing it or consuming twice', () => {
    const snapshot = approvalSnapshot();
    const before = structuredClone(snapshot);
    const context = { ...matchContext, binding: actionBinding() };
    expect(matchesRuntimeActionApproval(snapshot, context)).toBe(true);
    expect(matchesRuntimeActionApproval(snapshot, context)).toBe(true);
    expect(snapshot).toEqual(before);
    // Repeated true only means equal immutable input. Atomic consumption is P04.
  });

  it.each([
    ['task.scope.organizationId', id(999)],
    ['task.scope.workspaceId', id(999)],
    ['task.scope.projectId', null],
    ['task.chatSessionId', id(999)],
    ['task.frozenConfiguration.employeeVersionId', id(999)],
    ['task.frozenConfiguration.digest', differentDigest],
    ['attempt.operationId', id(999)],
    ['attempt.attemptId', id(999)],
    ['attempt.attemptNumber', 2],
    ['attempt.generation', 3],
    ['attempt.fence', 2],
    ['requestedBy.id', id(999)],
    ['requestedBy.type', 'service'],
    ['execution.targetId', id(999)],
    ['execution.deviceId', id(999)],
    ['execution.grantId', id(999)],
    ['execution.grantVersion', 2],
    ['execution.scopeDigest', differentDigest],
    ['execution.workCopy.id', id(999)],
    ['execution.workCopy.kind', 'git_worktree'],
    ['action', 'fixture.other'],
    ['inputDigest', differentDigest],
    ['policy.snapshotId', id(999)],
    ['policy.digest', differentDigest],
    ['baseline.0.version', 2],
    ['baseline.0.checksum', differentDigest],
    ['dataScope.0.authorizationId', id(999)],
    ['dataScope.0.authorizationVersion', 2],
    ['dataScope.0.content.version', 2],
    ['dataScope.0.destination', 'cloud_execution'],
    ['dataScope.0.sourceTargetId', id(999)],
    ['command.executableDigest', differentDigest],
    ['command.argumentsDigest', differentDigest],
    ['command.workingDirectoryDigest', differentDigest],
    ['command.effectiveEnvironmentDigest', differentDigest],
    ['command.networkPolicyDigest', differentDigest],
    ['command.toolchainDigest', differentDigest],
    ['command.budgetDigest', differentDigest],
  ])(
    'rejects reused approval when expected binding changes at %s',
    (path, value) => {
      expect(
        matchesRuntimeActionApproval(approvalSnapshot(), {
          ...matchContext,
          binding: changed(actionBinding(), path as string, value),
        }),
      ).toBe(false);
    },
  );

  it.each([
    ['consumedAt', now],
    ['revokedAt', now],
    ['response', null],
    ['response.decision', 'rejected'],
    ['response.approvalId', id(999)],
    ['response.version', 2],
    ['response.requestDigest', differentDigest],
    ['response.respondedBy', id(999)],
    ['request.binding.task.scope.organizationId', id(999)],
  ])(
    'rejects snapshot mismatch or non-active decision at %s',
    (path, value) => {
      expect(
        matchesRuntimeActionApproval(
          changed(approvalSnapshot(), path as string, value),
          { ...matchContext, binding: actionBinding() },
        ),
      ).toBe(false);
    },
  );

  it('does not accept a changed run or cloud target even with otherwise valid identity', () => {
    const nextRun = changed(
      changed(actionBinding(), 'task.runId', id(998)),
      'task.rootRunId',
      id(998),
    );
    expect(
      matchesRuntimeActionApproval(approvalSnapshot(), {
        ...matchContext,
        task: nextRun.task,
        binding: nextRun,
      }),
    ).toBe(false);
    const cloud = changed(
      changed(actionBinding(), 'execution.targetKind', 'cloud_sandbox'),
      'execution.deviceId',
      null,
    );
    expect(
      matchesRuntimeActionApproval(approvalSnapshot(), {
        ...matchContext,
        binding: cloud,
      }),
    ).toBe(false);
    expect(
      matchesRuntimeActionApproval(approvalSnapshot(), {
        ...matchContext,
        now: expiresAt,
        binding: actionBinding(),
      }),
    ).toBe(false);
  });
});

function typedInput(kind: RuntimeTypedInput['kind']) {
  const common = {
    contractVersion: 1,
    inputId: id(30),
    scope,
    chatSessionId: task.chatSessionId,
    actorId: id(21),
    text: 'Use synthetic inputs',
    submittedAt: now,
  };
  return RuntimeTypedInputSchema.parse(
    kind === 'queue_next'
      ? { ...common, kind, afterRunId: task.runId }
      : { ...common, kind, task, turn },
  );
}
const inputContext = {
  trustedScope: scope,
  chatSessionId: id(4),
  actorId: id(21),
  activeTask: task,
  activeTurn: turn,
};

describe('Runtime new-input intent contracts', () => {
  it.each(['steer_current', 'queue_next', 'interrupt_adjust'] as const)(
    'matches %s without performing delivery',
    (kind) => {
      const input = typedInput(kind);
      expect(matchesRuntimeTypedInput(input, inputContext)).toBe(true);
      expect(
        RuntimeTypedInputSchema.safeParse({ ...input, decision: 'approved' })
          .success,
      ).toBe(false);
      expect(
        RuntimeTypedInputSchema.safeParse({ ...input, contractVersion: 2 })
          .success,
      ).toBe(false);
      for (const [path, value] of [
        ['actorId', id(999)],
        ['scope.organizationId', id(999)],
        ['chatSessionId', id(999)],
      ] as const) {
        expect(
          matchesRuntimeTypedInput(changed(input, path, value), inputContext),
        ).toBe(false);
      }
    },
  );

  it.each(['steer_current', 'interrupt_adjust'] as const)(
    'requires a complete and current task/turn for %s',
    (kind) => {
      const input = typedInput(kind);
      for (const [path, value] of [
        ['turn', undefined],
        ['turn.generation', 1],
        ['turn.turnId', 'old-turn'],
        ['task.frozenConfiguration.digest', differentDigest],
        ['task.scope.projectId', null],
      ] as const) {
        expect(
          matchesRuntimeTypedInput(changed(input, path, value), inputContext),
        ).toBe(false);
      }
      expect(
        matchesRuntimeTypedInput(input, {
          ...inputContext,
          activeTask: null,
          activeTurn: null,
        }),
      ).toBe(false);
    },
  );

  it('queues without inventing a future Run or silently targeting an obsolete one', () => {
    const input = typedInput('queue_next');
    expect(
      RuntimeTypedInputSchema.safeParse({ ...input, task, turn }).success,
    ).toBe(false);
    expect(
      matchesRuntimeTypedInput(
        changed(input, 'afterRunId', id(999)),
        inputContext,
      ),
    ).toBe(false);
    expect(
      matchesRuntimeTypedInput(changed(input, 'afterRunId', null), {
        ...inputContext,
        activeTask: null,
        activeTurn: null,
      }),
    ).toBe(true);
    expect(
      matchesRuntimeTypedInput(
        input,
        changed(inputContext, 'activeTask.scope.organizationId', id(999)),
      ),
    ).toBe(false);
  });
});

describe('Runtime input receipt facts', () => {
  const receipt = {
    contractVersion: 1,
    inputId: id(30),
    inputKind: 'steer_current',
    inputDigest: digest,
    scope,
    chatSessionId: id(4),
    recordedAt: now,
  };
  const adoption = {
    ...receipt,
    status: 'adopted',
    appliedTo: task,
    turn,
    evidence: { id: id(31), recordedAt: now, digest },
  };

  it('keeps received/queued/pending/rejected distinct from adopted', () => {
    expect(
      RuntimeInputReceiptSchema.parse({ ...receipt, status: 'received' }),
    ).not.toHaveProperty('evidence');
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        status: 'received',
        evidence: adoption.evidence,
      }).success,
    ).toBe(false);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        status: 'queued',
        position: 0,
      }).success,
    ).toBe(false);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        inputKind: 'queue_next',
        status: 'queued',
        position: 0,
      }).success,
    ).toBe(true);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        status: 'pending',
        reason: 'waiting_runtime',
      }).success,
    ).toBe(true);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        status: 'pending',
        reason: 'waiting_interrupt',
      }).success,
    ).toBe(false);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        inputKind: 'interrupt_adjust',
        status: 'pending',
        reason: 'waiting_interrupt',
      }).success,
    ).toBe(true);
    expect(
      RuntimeInputReceiptSchema.safeParse({
        ...receipt,
        status: 'rejected',
        reason: 'stale_turn',
      }).success,
    ).toBe(true);
  });

  it('requires exact adoption task/turn identities and non-future evidence metadata', () => {
    expect(RuntimeInputReceiptSchema.safeParse(adoption).success).toBe(true);
    for (const [path, value] of [
      ['evidence', undefined],
      ['turn', undefined],
      ['turn.generation', -1],
      ['evidence.recordedAt', expiresAt],
      ['appliedTo.scope.organizationId', id(999)],
      ['appliedTo.scope.projectId', null],
      ['appliedTo.chatSessionId', id(999)],
    ] as const)
      expect(
        RuntimeInputReceiptSchema.safeParse(changed(adoption, path, value))
          .success,
      ).toBe(false);
    // Evidence authenticity and actual DSH adoption require P10 integration tests.
  });
});
