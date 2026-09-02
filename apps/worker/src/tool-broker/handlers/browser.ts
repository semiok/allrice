import { randomUUID } from 'node:crypto';

import {
  completeManagedBrowserTask,
  createDefaultManagedBrowserTask,
  isManagedBrowserTaskCancelRequested,
  ManagedBrowserTaskStartError,
  registerManagedBrowserEvidenceArtifact,
  startManagedBrowserTask,
  type ManagedBrowserExecutionLease,
} from '@allrice/database';
import { makeObjectKey, type StorageObject } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { HandlerError } from '../../errors.js';
import { runManagedBrowserTask } from '../../managed-browser.js';
import { limitValue, stringValue } from '../input-values.js';
import {
  managedBrowserStepValues,
  managedBrowserUntrustedContent,
} from '../managed-browser-input.js';
import type {
  ManagedBrowserCancellationCheck,
  RiceToolHandler,
  RiceToolHandlerContext,
} from '../types.js';

function createManagedBrowserEvidenceObject(input: {
  context: RiceToolHandlerContext['input']['context'];
  bytes: Buffer;
  mediaType: string;
  checksum: string;
}) {
  if (!input.context.workspaceId) {
    throw new HandlerError(
      'TOOL_WORKSPACE_REQUIRED',
      '保存浏览器证据需要当前工作区',
      false,
    );
  }
  const objectId = randomUUID();
  const ownerId = input.context.policySnapshot.subjectId;
  return {
    id: objectId,
    organizationId: input.context.organizationId,
    workspaceId: input.context.workspaceId,
    ownerId,
    key: makeObjectKey({
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId,
      ownerId,
      category: 'artifacts',
      objectId,
    }),
    checksum: `sha256:${input.checksum}`,
    mediaType: input.mediaType,
    sizeBytes: input.bytes.byteLength,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  } satisfies StorageObject;
}

async function saveManagedBrowserEvidence(input: {
  context: RiceToolHandlerContext['input']['context'];
  lease: ManagedBrowserExecutionLease;
  storageRoot: string;
  taskId: string;
  kind: 'content' | 'screenshot';
  name: string;
  bytes: Buffer;
  mediaType: string;
  checksum: string;
}) {
  const object = createManagedBrowserEvidenceObject(input);
  const storage = new LocalStorageAdapter(input.storageRoot);
  await storage.put(object, new Blob([Uint8Array.from(input.bytes)]).stream());
  try {
    await registerManagedBrowserEvidenceArtifact({
      context: input.context,
      lease: input.lease,
      taskId: input.taskId,
      kind: input.kind,
      name: input.name,
      object: {
        id: object.id,
        key: object.key,
        checksum: object.checksum,
        mediaType: object.mediaType,
        sizeBytes: object.sizeBytes,
      },
    });
    return object;
  } catch (error) {
    await storage
      .delete({ ...object, immutable: false })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Bridges durable, task-scoped cancellation into the in-process signal used
 * by Playwright. The immutable execution scope is captured when the task is
 * started, so a caller cannot redirect later polls across tenants or runs.
 */
export function createManagedBrowserCancellationMonitor(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  taskId: string;
  parentSignal?: AbortSignal;
  check?: ManagedBrowserCancellationCheck;
  pollIntervalMs?: number;
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const check = input.check ?? isManagedBrowserTaskCancelRequested;
  const scope = Object.freeze({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
  });
  const pollIntervalMs = Math.min(
    Math.max(Math.trunc(input.pollIntervalMs ?? 500), 100),
    10_000,
  );
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(input.parentSignal?.reason);
    }
  };
  if (input.parentSignal?.aborted) {
    abortFromParent();
  } else {
    input.parentSignal?.addEventListener('abort', abortFromParent, {
      once: true,
    });
  }

  const schedule = () => {
    if (disposed || controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, pollIntervalMs);
    timer.unref?.();
  };
  const poll = async () => {
    if (disposed || controller.signal.aborted) return;
    try {
      const cancellation = await check(scope);
      if (disposed || controller.signal.aborted) return;
      if (cancellation.requested) {
        controller.abort('managed_browser_task_cancel_requested');
        return;
      }
    } catch {
      // A transient database error must not create overlapping polls. Parent
      // run cancellation remains active and this task-scoped check retries.
    }
    schedule();
  };

  if (!controller.signal.aborted) void poll();
  if (!controller.signal.aborted && input.timeoutMs !== undefined) {
    const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs));
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      if (!disposed && !controller.signal.aborted) {
        controller.abort('managed_browser_target_timeout');
      }
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timer = undefined;
      timeoutTimer = undefined;
      input.parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export const runManagedBrowser: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const requestedUrl = stringValue(args.url, 'url');
  const steps = managedBrowserStepValues(args.steps);
  if (
    !Number.isInteger(input.managedBrowserJobAttempt) ||
    !input.managedBrowserJobLeaseToken
  ) {
    throw new HandlerError(
      'BROWSER_EXECUTION_LEASE_REQUIRED',
      '云端浏览器缺少当前任务租约，已拒绝执行',
      false,
    );
  }
  const browserLease: ManagedBrowserExecutionLease = {
    attempt: input.managedBrowserJobAttempt!,
    leaseToken: input.managedBrowserJobLeaseToken,
  };
  const browserTask = await createDefaultManagedBrowserTask(
    input.context,
    requestedUrl,
    steps.stored,
    browserLease,
    input.call.id,
  );
  let startedBrowserTask;
  try {
    startedBrowserTask = await startManagedBrowserTask({
      context: input.context,
      taskId: browserTask.id,
      lease: browserLease,
    });
  } catch (error) {
    if (error instanceof ManagedBrowserTaskStartError) {
      throw new HandlerError(
        error.code,
        error.code === 'BROWSER_TARGET_BUSY'
          ? '云端浏览器当前任务已满，请稍后重试'
          : '云端浏览器任务在开始前已超时',
        error.code === 'BROWSER_TARGET_BUSY',
      );
    }
    throw error;
  }
  const browserTimeoutMs = Math.max(
    1,
    Date.parse(startedBrowserTask.deadlineAt) - Date.now(),
  );
  let browserTaskSignal: AbortSignal | undefined;
  try {
    if (!input.context.workspaceId) {
      throw new HandlerError(
        'TOOL_WORKSPACE_REQUIRED',
        '运行云端浏览器需要当前工作区',
        false,
      );
    }
    const cancellationMonitor = createManagedBrowserCancellationMonitor({
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId,
      runId: input.context.runId,
      taskId: browserTask.id,
      parentSignal: input.signal,
      check: input.managedBrowserCancelCheck,
      pollIntervalMs: input.managedBrowserCancelPollIntervalMs,
      timeoutMs: browserTimeoutMs,
    });
    browserTaskSignal = cancellationMonitor.signal;
    const browserResult = await (async () => {
      try {
        return await (input.managedBrowserRun ?? runManagedBrowserTask)({
          startUrl: requestedUrl,
          allowedDomains: browserTask.allowedDomains,
          steps: steps.runtime,
          captureScreenshot: args.captureScreenshot !== false,
          maxCharacters: limitValue(args.maxCharacters, 30_000, 100_000),
          navigationTimeoutMs: Math.min(30_000, browserTimeoutMs),
          signal: cancellationMonitor.signal,
        });
      } finally {
        cancellationMonitor.dispose();
      }
    })();
    const contentObject = await saveManagedBrowserEvidence({
      context: input.context,
      lease: browserLease,
      storageRoot: input.storageRoot,
      taskId: browserTask.id,
      kind: 'content',
      name: 'page-snapshot.json',
      bytes: browserResult.contentSnapshot.bytes,
      mediaType: browserResult.contentSnapshot.mediaType,
      checksum: browserResult.contentSnapshot.checksum,
    });
    const screenshotObject = browserResult.screenshot
      ? await saveManagedBrowserEvidence({
          context: input.context,
          lease: browserLease,
          storageRoot: input.storageRoot,
          taskId: browserTask.id,
          kind: 'screenshot',
          name: 'page-screenshot.png',
          bytes: browserResult.screenshot.bytes,
          mediaType: browserResult.screenshot.mediaType,
          checksum: browserResult.screenshot.checksum,
        })
      : null;
    const events = [
      ...browserResult.actions.map((action, index) => ({
        sequence: index,
        kind: (action.type === 'navigate' ? 'navigation' : 'interaction') as
          'navigation' | 'interaction',
        status: 'succeeded' as const,
        label: action.type.slice(0, 160),
        summary: (action.detail
          ? `${action.type} · ${action.detail}`
          : action.type
        ).slice(0, 1_000),
        occurredAt: action.completedAt,
        url: action.url,
      })),
      {
        sequence: browserResult.actions.length,
        kind: 'capture' as const,
        status: 'succeeded' as const,
        label: 'page snapshot',
        summary: '已保存不可变页面正文快照',
        occurredAt: browserResult.capturedAt,
        url: browserResult.finalUrl,
      },
      ...(screenshotObject
        ? [
            {
              sequence: browserResult.actions.length + 1,
              kind: 'capture' as const,
              status: 'succeeded' as const,
              label: 'page screenshot',
              summary: '已保存不可变视口截图',
              occurredAt: browserResult.capturedAt,
              url: browserResult.finalUrl,
            },
          ]
        : []),
    ];
    await completeManagedBrowserTask({
      context: input.context,
      lease: browserLease,
      taskId: browserTask.id,
      status: 'succeeded',
      evidence: [
        {
          url: browserResult.finalUrl,
          title: browserResult.title.slice(0, 500) || null,
          capturedAt: browserResult.capturedAt,
          contentChecksum: contentObject.checksum,
          contentObjectId: contentObject.id,
          screenshotObjectId: screenshotObject?.id ?? null,
          downloadObjectIds: [],
          events,
        },
      ],
    });
    return {
      modelContent: JSON.stringify({
        source: 'managed-browser',
        untrustedExternalContent: true,
        taskId: browserTask.id,
        capturedAt: browserResult.capturedAt,
        externalContent: {
          source: 'browser.run',
          trust: 'untrusted',
          wrapped: true,
          content: managedBrowserUntrustedContent({
            url: browserResult.finalUrl,
            title: browserResult.title,
            text: browserResult.text,
            actions: browserResult.actions,
          }),
        },
        evidence: {
          contentObjectId: contentObject.id,
          screenshotObjectId: screenshotObject?.id ?? null,
        },
      }),
      summary: `云端浏览器已读取 ${new URL(browserResult.finalUrl).hostname} · ${browserResult.actions.length} 个步骤 · 证据已保存`,
      itemCount: 1,
    };
  } catch (error) {
    const timedOut =
      browserTaskSignal?.reason === 'managed_browser_target_timeout';
    const canceled =
      !timedOut &&
      (input.signal?.aborted ||
        browserTaskSignal?.aborted ||
        (error instanceof HandlerError &&
          error.code === 'BROWSER_TASK_CANCELED'));
    console.error('[M5] Managed browser execution failed', {
      taskId: browserTask.id,
      runId: input.context.runId,
      code: error instanceof HandlerError ? error.code : undefined,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'unknown browser error',
    });
    await completeManagedBrowserTask({
      context: input.context,
      lease: browserLease,
      taskId: browserTask.id,
      status: timedOut ? 'failed' : canceled ? 'canceled' : 'failed',
      errorCode: timedOut
        ? 'BROWSER_TARGET_TIMEOUT'
        : error instanceof HandlerError
          ? error.code
          : 'BROWSER_EXECUTION_FAILED',
    }).catch((completionError: unknown) => {
      console.error('[M5] Managed browser task finalization failed', {
        taskId: browserTask.id,
        runId: input.context.runId,
        message:
          completionError instanceof Error
            ? completionError.message
            : 'unknown error',
      });
    });
    if (timedOut) {
      throw new HandlerError(
        'BROWSER_TARGET_TIMEOUT',
        '云端浏览器任务超过执行时限',
        false,
      );
    }
    throw error;
  }
};
