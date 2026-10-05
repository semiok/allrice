import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStorageAdapter } from '@allrice/storage';
import { ProjectSnapshotSchema, projectPreviewHost } from '@allrice/contracts';
import {
  getDatabase,
  getPlatformQualityExecution,
  assertPlatformQualityLease,
  readProjectService,
  projectServicePreviewTarget,
  createProjectPreviewAccess,
  getToolBrokerFile,
  readArtifactBytes,
  publishWorkbenchArtifact,
  appendJobEvent,
  getWorkbenchArtifact,
  qualityCaseSpec,
  qualityDigest,
} from '@allrice/database';
import { QualityLiveEvidenceSchema } from '@allrice/database/technical-contracts';
import { PrivateQualityLiveInputSchema } from './tool-input.js';
import { runManagedBrowserLiveProbe } from '../managed-browser.js';
import { runManagedBrowser } from '../tool-broker/handlers/browser.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

/** This hook is only created by the deterministic private case driver. An
 * ordinary DSH call cannot supply it or choose a preview URL/source mutation. */
export async function runQualityLiveVerification(
  input: RiceToolExecutionInput,
  raw: unknown,
) {
  const args = PrivateQualityLiveInputSchema.parse(raw),
    hook = input.qualityLiveProbe;
  if (!hook || !input.sessionId) throw Error('QUALITY_PRIVATE_PROBE_REQUIRED');
  const check = await getPlatformQualityExecution(hook.lease);
  if (
    check.id !== hook.checkId ||
    check.runId !== input.context.runId ||
    check.sessionId !== input.sessionId ||
    check.frozen.caseId !== 'project.live.v1' ||
    hook.lease.jobId !== input.context.jobId ||
    hook.lease.workerId !== input.context.worker.id ||
    hook.lease.attempt !== input.managedBrowserJobAttempt ||
    hook.lease.leaseToken !== input.managedBrowserJobLeaseToken ||
    !check.frozen.loginSessionId
  )
    throw Error('QUALITY_PRIVATE_PROBE_BINDING');
  const principal = {
    requestId: check.id,
    memberships: [],
    authenticatedAt: check.frozen.loginAuthenticatedAt!,
    organizationId: check.organizationId,
    workspaceId: check.workspaceId,
    actor: { type: 'user' as const, id: check.ownerId },
    sessionId: check.frozen.loginSessionId,
  };
  const original = await readProjectService(principal, args.serviceId);
  if (
    original.runId !== check.runId ||
    original.sessionId !== check.sessionId ||
    original.backend !== 'cloud' ||
    original.state !== 'ready'
  )
    throw Error('QUALITY_PRIVATE_SERVICE_BINDING');
  const storage = new LocalStorageAdapter(input.storageRoot);
  const source = await getWorkbenchArtifact(
    principal,
    check.sessionId,
    original.project.snapshot.id,
  );
  const document = ProjectSnapshotSchema.parse(
    JSON.parse(
      (await readArtifactBytes(storage, source.object, 2_000_000)).toString(),
    ),
  );
  if (
    qualityDigest(
      document.files.map((f) => ({
        path: f.path,
        text: Buffer.from(f.contentBase64, 'base64').toString(),
      })),
    ) !==
    qualityDigest(
      qualityCaseSpec(check.frozen.caseId, check.frozen.variant).files,
    )
  )
    throw Error('QUALITY_PRIVATE_SOURCE_CHANGED');
  const suffix = process.env.ALLRICE_PROJECT_PREVIEW_SUFFIX;
  if (!suffix) throw Error('QUALITY_PREVIEW_GATEWAY_UNAVAILABLE');
  const origin = `https://${projectPreviewHost(args.serviceId, suffix)}`;
  const token = await createProjectPreviewAccess(principal, args.serviceId);
  let observation:
    | Awaited<ReturnType<typeof runManagedBrowserLiveProbe>>['observations']
    | undefined;
  let sync: { updateId: string } | undefined;
  const captured = await runManagedBrowser({
    input: {
      ...input,
      managedBrowserRun: async (browserInput) => {
        const result = await runManagedBrowserLiveProbe({
          ...browserInput,
          origin,
          bootstrapUrl: `${origin}/?_allrice_preview_ticket=${token}`,
          assertCurrent: async () => {
            await getPlatformQualityExecution(hook.lease);
            await projectServicePreviewTarget(principal, args.serviceId);
          },
          syncOnce: async (probeSignal) => {
            if (sync) throw Error('QUALITY_SYNC_REPLAY');
            probeSignal.throwIfAborted();
            sync = await hook.syncOnce(probeSignal);
            const end = Date.now() + 15_000;
            for (;;) {
              probeSignal.throwIfAborted();
              await getPlatformQualityExecution(hook.lease);
              const applied = await readProjectService(
                principal,
                args.serviceId,
              );
              if (
                !applied.updatePending &&
                applied.project.snapshot.id !== original.project.snapshot.id
              )
                break;
              if (Date.now() > end) throw Error('QUALITY_SYNC_RECEIPT_TIMEOUT');
              await delay(100, undefined, { signal: probeSignal });
            }
          },
        });
        observation = result.observations;
        return result.result;
      },
    },
    arguments: {
      url: origin + '/',
      captureScreenshot: true,
      maxCharacters: 30_000,
    },
  });
  const result = z
    .object({
      taskId: z.string().uuid(),
      evidence: z.object({
        contentObjectId: z.string().uuid(),
        screenshotObjectId: z.string().uuid(),
      }),
    })
    .parse(JSON.parse(captured.modelContent));
  if (!observation || !sync) throw Error('QUALITY_LIVE_OBSERVATIONS_MISSING');
  const current = await readProjectService(principal, args.serviceId),
    target = await projectServicePreviewTarget(principal, args.serviceId);
  if (
    current.updatePending ||
    current.project.snapshot.id === original.project.snapshot.id
  )
    throw Error('QUALITY_SYNC_NOT_APPLIED');
  const content = await getToolBrokerFile(
    input.context,
    result.evidence.contentObjectId,
  );
  const screenshot = await getToolBrokerFile(
    input.context,
    result.evidence.screenshotObjectId,
  );
  const artifacts = [];
  for (const [capture, fileName, format, mediaType] of [
    [content, 'live-preview.json', 'json', 'application/json'],
    [screenshot, 'live-preview.png', 'png', 'image/png'],
  ] as const) {
    const bytes = await readArtifactBytes(storage, capture.object, 2_000_000);
    artifacts.push(
      await publishWorkbenchArtifact(
        {
          context: input.context,
          sessionId: check.sessionId,
          callId: `${input.call.id}:${format}`,
          kind: 'document',
          fileName,
          format,
          bytes,
          mediaType,
        },
        storage,
        getDatabase(),
        {
          runId: check.runId,
          requiredTool: 'browser.workspace',
          qualityLiveCapture: { browserTaskId: result.taskId },
          admit: (tx) => assertPlatformQualityLease(tx, hook.lease),
        },
      ),
    );
  }
  const evidence = QualityLiveEvidenceSchema.parse({
    version: 1,
    checkId: check.id,
    runId: check.runId,
    jobId: hook.lease.jobId,
    jobAttempt: hook.lease.attempt,
    toolCallId: input.call.id,
    browserTaskId: result.taskId,
    service: target,
    originalProject: original.project,
    updatedProject: current.project,
    updateId: sync.updateId,
    sourceDigest: current.sourceDigest,
    ...observation,
    snapshotChecksum: content.object.checksum,
    screenshotChecksum: screenshot.object.checksum,
  });
  await getPlatformQualityExecution(hook.lease);
  await appendJobEvent({
    ...hook.lease,
    type: 'tool.completed',
    payload: {
      source: 'platform_quality_live',
      toolCallId: input.call.id,
      jobAttempt: hook.lease.attempt,
      evidence,
    },
  });
  return {
    summary: '正式预览 HTTP、WebSocket 与无导航热更新已核对',
    modelContent: JSON.stringify({ evidence, artifacts }),
  };
}
