/** Isolated R3 source, admission and lease fixture; no model or shared Dev. */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { ReferenceAudience, RequestContext } from '@allrice/contracts';
import {
  type createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { savePlatformEmployeeDraft } from './employees/platform-employees.ts';
import { createSession, authenticateSession } from './identity.ts';
import {
  createChatSession,
  sendChatMessage,
  getEmployeeWorkspace,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { prepareEmployeeContentContext } from './employees/employee-runtime-content.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';
import { claimNextJob, startClaimedJob } from './execution/queue.ts';
import {
  publishReference,
  listReferencePublications,
} from './reference-library.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from './reference-processing.ts';
import { referenceReadPin } from './reference-search.ts';

export async function referenceToolFixture(
  f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
) {
  const source = await createEmployeeAdministrationFixture(f.db);
  await savePlatformEmployeeDraft(source.employeeId, {
    definition: {
      ...source.definition,
      capabilities: {
        ...source.definition.capabilities,
        toolNames: ['workspace.skill.read', 'workspace.file.read'],
      },
    },
  });
  await source.preview();
  expect((await source.publish()).valid).toBe(true);
  async function login(userId: string) {
    return (await authenticateSession((await createSession(userId)).token, {
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
    }))!;
  }
  const context = await login(source.ownerId);
  const publisherId = randomUUID();
  await f.db`insert into allrice_users(id,email,display_name,password_hash) values(${publisherId},${publisherId + '@example.test'},'Publisher','not-login')`;
  await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${source.organizationId},${source.workspaceId},${publisherId},'member')`;
  const publisher = await login(publisherId);
  const assigned = (
    await getEmployeeWorkspace(context, source.workspaceId)
  ).employees.find((e) => e.employeeKey === source.definition.key)!;
  async function run(sessionId?: string, referenceRevisionIds: string[] = []) {
    const session = sessionId
      ? { id: sessionId }
      : await createChatSession(context, {
          workspaceId: source.workspaceId,
          employeeAssignmentId: assigned.id,
          title: '查企业资料并列出处',
        });
    const sent = await sendChatMessage(
      context,
      source.workspaceId,
      session.id,
      {
        text: '查企业资料里的差旅上限并列出出处。',
        clientMessageId: randomUUID(),
        ...(referenceRevisionIds.length
          ? { referenceRevisionIds, deliveryMode: 'follow_up' as const }
          : {}),
      },
    );
    const scope = {
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      ownerId: source.ownerId,
      sessionId: session.id,
      runId: sent.run.id,
    };
    const resolved = await resolveEmployeeExecution(scope);
    const runtime = await prepareEmployeeContentContext(scope);
    expect(runtime).not.toBeNull();
    const workerId = randomUUID();
    const job = await claimNextJob(workerId, 600000);
    expect(job?.id).toBe(sent.run.job.id);
    const worker = { workerId, jobId: job!.id, leaseToken: job!.lease!.token };
    const execution = await startClaimedJob(
      workerId,
      worker.jobId,
      worker.leaseToken,
    );
    expect(execution).not.toBeNull();
    await acquireConversationRuntime({
      ...scope,
      workerId,
      configChecksum: assigned.currentVersion.configChecksum,
      compactThresholdTokens: 40000,
    });
    return {
      scope,
      worker,
      runtime: runtime!,
      execution: execution!,
      resolved,
      sent,
    };
  }
  async function publish(
    text: string,
    options: {
      audience?: ReferenceAudience;
      ready?: boolean;
      context?: RequestContext;
      fileName?: string;
      units?: { label: string; start: number; end: number }[];
    } = {},
  ) {
    const actor = options.context ?? publisher;
    const saved = await publishReference(
      actor,
      {
        workspaceId: source.workspaceId,
        requestId: randomUUID(),
        origin: 'upload',
        fileName: options.fileName ?? '差旅规定.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(text).toString('base64'),
        audience: options.audience ?? { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(f.db),
    );
    if (options.ready !== false) {
      await f.db`update allrice_knowledge_processing set updated_at='1999-01-01' where revision_id=${saved.revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(saved.revisionId);
      await finishReferenceProcessing(
        claim!,
        [
          {
            content: text.slice(0, 1000),
            start: 0,
            end: Math.min(1000, text.length),
          },
        ],
        {
          text,
          kind: 'text',
          warnings: [],
          units: options.units ?? [
            { label: '正文', start: 0, end: text.length },
          ],
        },
      );
    }
    const [reference] = await listReferencePublications(
      actor,
      source.workspaceId,
      saved.sourceId,
    );
    return { ...saved, pin: referenceReadPin(reference!) };
  }
  return { source, context, publisher, run, publish };
}
