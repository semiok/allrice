import { describe, expect, it } from 'vitest';

import {
  externalActionDigest,
  isEquivalentManagedBrowserArtifactReplay,
  isEquivalentExternalActionReplay,
  managedBrowserCompletionStatus,
  managedBrowserExecutionScopeMatches,
  projectedExecutionTargetState,
  validateManagedBrowserEvidenceReferences,
} from './p1-runtime.ts';
import {
  ExternalActionSchema,
  DeliverableVersionSchema,
  ManagedBrowserStepSchema,
  ManagedBrowserTaskSchema,
  MemoryRevisionSchema,
  type ExecutionContext,
} from '@allrice/contracts';
import { randomUUID } from 'node:crypto';

describe('MET-98 execution governance', () => {
  it('projects stale Bridge heartbeats offline after five minutes', () => {
    expect(
      projectedExecutionTargetState({
        persistedState: 'online',
        kind: 'rice_bridge',
        lastHeartbeatAt: new Date('2026-08-31T00:00:00.000Z'),
        now: new Date('2026-08-31T00:05:01.000Z'),
      }),
    ).toBe('offline');
  });

  it('keeps revoked targets revoked regardless of heartbeat', () => {
    expect(
      projectedExecutionTargetState({
        persistedState: 'revoked',
        kind: 'cloud_sandbox',
        lastHeartbeatAt: new Date('2026-08-31T00:00:00.000Z'),
        now: new Date('2026-08-31T00:00:01.000Z'),
      }),
    ).toBe('revoked');
  });

  it('generates canonical action digests independent of object key order', () => {
    expect(externalActionDigest({ b: 2, a: 1 })).toBe(
      externalActionDigest({ a: 1, b: 2 }),
    );
  });

  it('only treats an idempotency replay as equivalent when its governed input matches', () => {
    const existing = {
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      actorId: 'user-1',
      action: 'calendar.event.create',
      inputDigest: externalActionDigest({ title: '评审会' }),
    };
    expect(
      isEquivalentExternalActionReplay({
        existing,
        requested: { ...existing },
      }),
    ).toBe(true);
    expect(
      isEquivalentExternalActionReplay({
        existing,
        requested: {
          ...existing,
          inputDigest: externalActionDigest({ title: '另一场会议' }),
        },
      }),
    ).toBe(false);
  });

  it('limits managed browser instructions to the safe, structured action set', () => {
    expect(
      ManagedBrowserStepSchema.parse({
        type: 'follow_link',
        selector: 'main a[data-report]',
      }),
    ).toEqual({ type: 'follow_link', selector: 'main a[data-report]' });
    expect(() =>
      ManagedBrowserStepSchema.parse({
        type: 'evaluate',
        script: 'document.cookie',
      }),
    ).toThrow();
  });

  it('freezes browser mutations to the exact execution run, not merely the same owner', () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const userId = randomUUID();
    const membership = {
      id: randomUUID(),
      userId,
      organizationId,
      workspaceId,
      role: 'member' as const,
      active: true,
    };
    const context = {
      executionId: randomUUID(),
      runId,
      jobId: randomUUID(),
      worker: { type: 'worker' as const, id: randomUUID() },
      delegatedBy: { type: 'user' as const, id: userId },
      organizationId,
      workspaceId,
      policySnapshot: {
        id: randomUUID(),
        organizationId,
        subjectId: userId,
        version: 1,
        issuedAt: '2026-08-31T00:00:00.000Z',
        expiresAt: '2026-08-31T01:00:00.000Z',
        memberships: [membership],
        grants: [],
      },
      startedAt: '2026-08-31T00:00:00.000Z',
    } satisfies ExecutionContext;
    expect(
      managedBrowserExecutionScopeMatches({
        context,
        task: { organizationId, workspaceId, runId },
      }),
    ).toBe(true);
    expect(
      managedBrowserExecutionScopeMatches({
        context,
        task: { organizationId, workspaceId, runId: randomUUID() },
      }),
    ).toBe(false);
  });

  it('lets task or parent cancellation win a completion race', () => {
    expect(
      managedBrowserCompletionStatus({
        requestedStatus: 'succeeded',
        taskCancelRequestedAt: '2026-08-31T00:00:01.000Z',
        parentRunState: 'running',
        parentJobCanceled: false,
      }),
    ).toBe('canceled');
    expect(
      managedBrowserCompletionStatus({
        requestedStatus: 'succeeded',
        taskCancelRequestedAt: null,
        parentRunState: 'canceled',
        parentJobCanceled: false,
      }),
    ).toBe('canceled');
    expect(
      managedBrowserCompletionStatus({
        requestedStatus: 'succeeded',
        taskCancelRequestedAt: null,
        parentRunState: 'running',
        parentJobCanceled: false,
      }),
    ).toBe('succeeded');
  });

  it('accepts only exact immutable browser artifact references and replay metadata', () => {
    const taskId = randomUUID();
    const objectId = randomUUID();
    const checksum = `sha256:${'a'.repeat(64)}`;
    const artifact = {
      id: randomUUID(),
      objectId,
      kind: 'content' as const,
      name: 'page-snapshot.json',
      checksum,
      mediaType: 'application/json',
      sizeBytes: 128,
      createdAt: '2026-08-31T00:00:01.000Z',
    };
    const evidence = {
      url: 'https://example.com/report',
      title: 'Report',
      capturedAt: '2026-08-31T00:00:01.000Z',
      contentChecksum: checksum,
      contentObjectId: objectId,
      screenshotObjectId: null,
      downloadObjectIds: [],
      events: [],
    };
    expect(() =>
      validateManagedBrowserEvidenceReferences({
        status: 'succeeded',
        evidence: [evidence],
        artifacts: [artifact],
      }),
    ).not.toThrow();
    expect(() =>
      validateManagedBrowserEvidenceReferences({
        status: 'succeeded',
        evidence: [
          { ...evidence, contentChecksum: `sha256:${'b'.repeat(64)}` },
        ],
        artifacts: [artifact],
      }),
    ).toThrow();
    expect(
      isEquivalentManagedBrowserArtifactReplay({
        existing: {
          taskId,
          objectId,
          kind: artifact.kind,
          name: artifact.name,
        },
        requested: {
          taskId,
          objectId,
          kind: artifact.kind,
          name: artifact.name,
        },
      }),
    ).toBe(true);
    expect(
      isEquivalentManagedBrowserArtifactReplay({
        existing: {
          taskId,
          objectId,
          kind: artifact.kind,
          name: artifact.name,
        },
        requested: {
          taskId,
          objectId,
          kind: 'screenshot',
          name: artifact.name,
        },
      }),
    ).toBe(false);
  });

  it('keeps governed revision, browser evidence and external action records replayable', () => {
    const ids = {
      organization: '11111111-1111-4111-8111-111111111111',
      workspace: '22222222-2222-4222-8222-222222222222',
      memory: '33333333-3333-4333-8333-333333333333',
      revision: '44444444-4444-4444-8444-444444444444',
      user: '55555555-5555-4555-8555-555555555555',
      run: '66666666-6666-4666-8666-666666666666',
      target: '77777777-7777-4777-8777-777777777777',
      task: '88888888-8888-4888-8888-888888888888',
      action: '99999999-9999-4999-8999-999999999999',
    };
    expect(
      DeliverableVersionSchema.parse({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        organizationId: ids.organization,
        workspaceId: ids.workspace,
        ownerId: ids.user,
        objectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        seriesId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        version: 2,
        parentVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        parentObjectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        platformTestRunId: null,
        fileName: '季度报告.docx',
        format: 'docx',
        changeSummary: '补充风险章节',
        createdAt: '2026-08-31T00:00:00.000Z',
      }).version,
    ).toBe(2);
    expect(
      MemoryRevisionSchema.parse({
        id: ids.revision,
        organizationId: ids.organization,
        workspaceId: ids.workspace,
        memoryId: ids.memory,
        revision: 2,
        content: '用户确认后的项目背景',
        trust: 'user_confirmed',
        lifecycleState: 'durable',
        memoryClass: 'project_fact',
        confidence: 1,
        expiresAt: null,
        reason: '用户更正',
        changedBy: ids.user,
        changedAt: '2026-08-31T00:00:00.000Z',
      }).revision,
    ).toBe(2);
    expect(
      ManagedBrowserTaskSchema.parse({
        id: ids.task,
        organizationId: ids.organization,
        workspaceId: ids.workspace,
        runId: ids.run,
        targetId: ids.target,
        status: 'succeeded',
        startUrl: 'https://example.com/report',
        allowedDomains: ['example.com'],
        steps: [
          {
            type: 'wait_for',
            selector: 'main',
            timeoutMs: 5_000,
          },
        ],
        evidence: [
          {
            url: 'https://example.com/report',
            title: '公开报告',
            capturedAt: '2026-08-31T00:00:01.000Z',
            contentChecksum:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            contentObjectId: '10101010-1010-4010-8010-101010101010',
            screenshotObjectId: '20202020-2020-4020-8020-202020202020',
            downloadObjectIds: [],
            events: [
              {
                sequence: 0,
                kind: 'capture',
                status: 'succeeded',
                label: '页面证据已保存',
                summary: '正文和截图已写入不可变私有对象。',
                occurredAt: '2026-08-31T00:00:01.000Z',
                url: 'https://example.com/report',
              },
            ],
          },
        ],
        createdAt: '2026-08-31T00:00:00.000Z',
        startedAt: '2026-08-31T00:00:00.100Z',
        cancelRequestedAt: null,
        errorCode: null,
        completedAt: '2026-08-31T00:00:01.000Z',
      }).status,
    ).toBe('succeeded');
    expect(
      ExternalActionSchema.parse({
        id: ids.action,
        organizationId: ids.organization,
        workspaceId: ids.workspace,
        runId: ids.run,
        actorId: ids.user,
        targetId: null,
        connectorBindingId: null,
        action: 'calendar.event.create',
        risk: 'external_send',
        status: 'pending_approval',
        inputDigest: externalActionDigest({ title: '评审会' }),
        outputDigest: null,
        approvalId: null,
        idempotencyKey: 'calendar-review-1',
        errorCode: null,
        createdAt: '2026-08-31T00:00:00.000Z',
        completedAt: null,
      }).status,
    ).toBe('pending_approval');
  });
});
