import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createStorageMetadata, markStorageReady } from '../data.ts';
import { resolveEmployeeExecution } from '../employees/employeehub.ts';
import {
  createAssignedChatSession,
  linkFileToSession,
  sendChatMessage,
} from './service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('message-scoped attachment delivery', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('freezes corrected same-name input references through queued messages and retry without weakening file access', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    // Synthetic SQL approval only; this suite never starts a native process.
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
    const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
    try {
      const session = await createAssignedChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
      });
      // Synthetic metadata only: this test queues jobs but never invokes a model
      // or claims to read file bytes. Ordinary sendChatMessage applies the real
      // authorization and freezes the real execution prompt.
      const add = async (
        fileName: string,
        text: string,
        linked = true,
        mediaType = 'application/zip',
      ) => {
        const id = randomUUID();
        const file = await createStorageMetadata(f.context, {
          id,
          workspaceId: f.workspaceId,
          category: 'uploads',
          mediaType,
          sizeBytes: Buffer.byteLength(text),
          checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
          visibility: 'private',
          retentionUntil: null,
          immutable: false,
        });
        await markStorageReady(f.context, id);
        if (linked)
          await linkFileToSession({
            context: f.context,
            workspaceId: f.workspaceId,
            sessionId: session.id,
            objectId: id,
            fileName,
          });
        return file.object;
      };
      const old = await add('source-inputs.zip', '71 rows, old input');
      const corrected = await add(
        'source-inputs.zip',
        '72 rows, corrected input',
      );
      const brief = await add(
        'brief.txt',
        'Use corrected data; retain old version',
      );
      const imageA = await add(
        'chart.png',
        'first image metadata',
        true,
        'image/png',
      );
      const imageB = await add(
        'chart.png',
        'second image metadata',
        true,
        'image/png',
      );
      const send = (input: unknown) =>
        sendChatMessage(f.context, f.workspaceId, session.id, input);
      const first = await send({
        clientMessageId: randomUUID(),
        text: '按原文件完成项目。',
        attachmentIds: [old.id],
        deliveryMode: 'follow_up',
      });
      const nextInput = {
        clientMessageId: randomUUID(),
        text: '请按“本次附件”继续修改。使用新版输入，并保留旧版成果。',
        attachmentIds: [brief.id, corrected.id, imageB.id, imageA.id],
        deliveryMode: 'follow_up',
      };
      const next = await send(nextInput);
      const repeated = await send(nextInput);
      expect(repeated.run.id).toBe(next.run.id);
      const snapshot = async (runId: string) => {
        const [row] = await f.db`
          select prompt_snapshot from allrice_employee_runs where run_id=${runId}`;
        return row!.prompt_snapshot.userRequest as string;
      };
      const firstPrompt = await snapshot(first.run.id);
      const nextPrompt = await snapshot(next.run.id);
      expect(firstPrompt).toContain(old.id);
      expect(firstPrompt).not.toContain(corrected.id);
      expect(nextPrompt).toContain(next.userMessage.id);
      expect(nextPrompt).toContain(corrected.id);
      expect(nextPrompt).toContain(corrected.checksum);
      expect(nextPrompt).toContain(brief.id);
      expect(nextPrompt).not.toContain(old.id);
      expect(nextPrompt).not.toContain(corrected.key);
      expect(nextPrompt.startsWith(nextInput.text)).toBe(true);
      const resolved = await resolveEmployeeExecution({
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        runId: next.run.id,
      });
      expect(resolved.currentUserRequest).toBe(nextInput.text);
      expect(resolved.promptSnapshot.userRequest).toBe(nextPrompt);
      await expect(
        resolveEmployeeExecution({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: randomUUID(),
          runId: next.run.id,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await snapshot(first.run.id)).toBe(firstPrompt);
      const [images] = await f.db`
        select prompt_snapshot from allrice_employee_runs where run_id=${next.run.id}`;
      expect(
        images!.prompt_snapshot.imageAttachments.map(
          (item: { object: { id: string } }) => item.object.id,
        ),
      ).toEqual([imageB.id, imageA.id]);
      expect(nextPrompt.indexOf(imageB.id)).toBeLessThan(
        nextPrompt.indexOf(imageA.id),
      );
      await expect(
        send({ ...nextInput, attachmentIds: [old.id] }),
      ).rejects.toThrow();

      const unlinked = await add(
        'source-inputs.zip',
        'not attached to this Session',
        false,
      );
      await expect(
        send({
          ...nextInput,
          clientMessageId: randomUUID(),
          attachmentIds: [unlinked.id],
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await f.db`update allrice_storage_objects set state='deleted',deleted_at=now() where id=${corrected.id}`;
      await expect(
        send({ ...nextInput, clientMessageId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      // A revoked current object does not fall back to the readable old object.
      const [count] =
        await f.db`select count(*)::int n from allrice_employee_runs where session_id=${session.id}`;
      expect(count!.n).toBe(2);
      expect(await snapshot(next.run.id)).toBe(nextPrompt);
    } finally {
      await f.close();
    }
  }, 60_000);
});
