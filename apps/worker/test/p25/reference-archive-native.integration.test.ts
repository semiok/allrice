import { zipSync } from 'fflate';
import { parseReferenceArchiveText } from '../../src/reference-archive.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HarnessEventSchema, ReferenceReadsSchema } from '@allrice/contracts';
import { appendJobEvent, listRunEvents } from '@allrice/database';
import {
  referenceReadFailure,
  sourceMetadata,
} from '../../src/harness/dsh/event-projector.js';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.js';
import * as database from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { referenceToolFixture } from '../../../../packages/database/src/reference-tool.fixture.ts';
import {
  publishReference,
  listReferencePublications,
  changeReferencePublication,
} from '../../../../packages/database/src/reference-library.ts';
import { referenceReadPin } from '../../../../packages/database/src/reference-search.ts';
import {
  executeEmployeeReferenceTool,
  assertEmployeeContentContext,
  loadEmployeeRuntimeReferences,
} from '../../../../packages/database/src/employees/employee-runtime-content.ts';
import { executeRiceTool, riceToolDefinitions } from '../../src/tool-broker.js';
import { dshInboundToolHandler } from '../../src/harness/dsh/tool-bridge.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { p24Fixture } from '../p24/fixture.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
const imagePath =
  'a'.repeat(100) +
  '/' +
  'b'.repeat(100) +
  '/' +
  'c'.repeat(100) +
  '/diagram.png';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('R4b real native directory/text/image results and cold history', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let x: Awaited<ReturnType<typeof referenceToolFixture>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
    x = await referenceToolFixture(f);
    const controls = { version: 1, enabled: true, mode: 'execute', rules: [] };
    await f.db`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
      values(${x.context.organizationId},${x.context.workspaceId},1,${f.db.json(controls)})
      on conflict(organization_id,workspace_id) do update set version=excluded.version,controls=excluded.controls`;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  }, 30000);
  it('returns a durable image block, sends image input to the model, and preserves it after revoke plus process restart', async () => {
    const saved = await publishReference(
      x.publisher,
      {
        origin: 'upload',
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        fileName: 'bundle.zip',
        mediaType: 'application/zip',
        contentBase64: Buffer.from(
          zipSync(
            {
              [imagePath]: Buffer.from(png, 'base64'),
              'note.txt': Buffer.from('archive member text evidence'),
            },
            { level: 0 },
          ),
        ).toString('base64'),
        audience: { scope: 'company', departmentIds: [] },
      },
      runtimeFixtureStorage(f.db),
    );
    await f.db`update allrice_knowledge_processing set state='unsupported' where revision_id=${saved.revisionId}`;
    const [reference] = await listReferencePublications(
      x.context,
      x.context.workspaceId!,
      saved.sourceId,
    );
    const pin = referenceReadPin(reference!);
    const run = await x.run(undefined, [saved.revisionId]);
    expect(
      await loadEmployeeRuntimeReferences(
        run.scope,
        run.runtime.generationId,
        run.worker,
      ),
    ).toEqual([]);
    let directory: { entries: { entryId: string; path: string }[] };
    const model = await p24Fixture(async (request, index) => {
      if (index === 6)
        return {
          nativeTool: {
            name: 'workspace_reference_archive_read',
            arguments: {
              ...pin,
              entryId: directory.entries[0]!.entryId,
              as: 'text',
            },
          },
        };
      if (index === 7)
        expect(JSON.stringify(request.messages)).toContain(
          'REFERENCE_UNAVAILABLE',
        );
      if (index === 1) {
        expect(JSON.stringify(request.messages)).not.toContain('image_url');
        return {
          nativeTool: {
            name: 'workspace_reference_archive_list',
            arguments: pin,
          },
        };
      }
      if (index === 2 || index === 3) {
        expect(JSON.stringify(request.messages)).not.toContain('image_url');
        const path = index === 2 ? 'note.txt' : imagePath;
        return {
          nativeTool: {
            name: 'workspace_reference_archive_read',
            arguments: {
              ...pin,
              entryId: directory.entries.find((entry) => entry.path === path)!
                .entryId,
              as: index === 2 ? 'text' : 'image',
            },
          },
        };
      }
      expect(JSON.stringify(request.messages)).toContain(
        'archive member text evidence',
      );
      expect(JSON.stringify(request.messages)).toContain('image_url');
      expect(JSON.stringify(request.messages)).toContain('data:image/');
      expect(JSON.stringify(request.messages)).toContain('diagram.png');
      return { text: 'Image content received with source R1.' };
    });
    const clients: DshProtocolClient[] = [];
    const notices: DshNotification[] = [];
    const calls: string[] = [];
    const sessionId = 'r4b-' + randomUUID();
    const profile = join(model.root, 'reference-image.cordis.yml');
    async function launch() {
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: profile,
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_OPENAI_COMPATIBLE_MODEL: 'r4b-synthetic',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      clients.push(client);
      client.subscribe((value) => notices.push(value));
      const broker = dshInboundToolHandler({
        tools: riceToolDefinitions.filter(
          (tool) =>
            tool.name === 'workspace.reference.archive_list' ||
            tool.name === 'workspace.reference.archive_read',
        ),
        referenceImage: (call) => client.referenceImagePort(call),
        onToolCall: async (call, options) => {
          calls.push(call.id);
          const result = await executeRiceTool({
            context: run.execution.context,
            capabilities: run.resolved.grantedCapabilities,
            storageRoot: '.unused-reference-image-test',
            sessionId: run.scope.sessionId,
            call,
            executeReferenceTool: (name, args, signal) =>
              executeEmployeeReferenceTool(
                run.scope,
                run.runtime.generationId,
                run.worker,
                name,
                args,
                signal,
                {
                  storage: runtimeFixtureStorage(f.db),
                  native: options!.referenceImage!,
                  parseText: parseReferenceArchiveText,
                  call: {
                    id: call.id,
                    name: name as
                      | 'workspace.reference.archive_list'
                      | 'workspace.reference.archive_read',
                    nativeSessionId: call.nativeSessionId!,
                  },
                },
              ),
          });
          if (call.name === 'workspace.reference.archive_list')
            directory = JSON.parse(result.modelContent);
          return result;
        },
      });
      client.setRequestHandler(async (method, params) => {
        if (method === 'allrice/run-authorize') {
          expect(params.runId).toBe(run.scope.runId);
          expect(params.nativeSessionId).toBe(sessionId);
          await assertEmployeeContentContext(
            run.scope,
            run.runtime.generationId,
            run.worker,
          );
          return { authorized: true };
        }
        return broker(method, params, new AbortController().signal);
      });
      await client.initialize({
        cwd: model.root,
        provider: 'openai-compatible',
        model: 'r4b-synthetic',
        nativeTools: [
          'workspace.reference.archive_list',
          'workspace.reference.archive_read',
        ],
        requireRunAdmission: true,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      return client;
    }
    try {
      await symlink(
        resolve(import.meta.dirname, '../../node_modules'),
        join(model.root, 'node_modules'),
        'dir',
      );
      // Synthetic route only. Production acceptance separately uses its unchanged default route.
      const config = await readFile(
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
        'utf8',
      );
      await writeFile(
        profile,
        config.replace(
          '        api: openai-completions\n',
          '        api: openai-completions\n        defaultInput: [text, image]\n',
        ),
      );
      const client = await launch();
      await client.beginRun(sessionId, run.scope.runId);
      await client.prompt(sessionId, 'Read the selected diagram.');
      await client.wait(sessionId);
      expect(model.requests).toHaveLength(4);
      expect(calls).toHaveLength(3);
      const [row] =
        await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
      const reads = ReferenceReadsSchema.parse(row!.reference_reads);
      expect(
        reads.map((read) => ('readKind' in read ? read.readKind : 'legacy')),
      ).toEqual(['archive_directory', 'archive_member_text', 'image']);
      expect(reads.slice(2)).toMatchObject([
        {
          readKind: 'image',
          call: { id: calls[2], nativeSessionId: sessionId },
          citation: {
            referenceLabel: 'R3',
            reference: expect.objectContaining(pin),
          },
        },
      ]);
      const imageReceipt = reads[2]!;
      if (
        imageReceipt.citation.type !== 'reference' ||
        imageReceipt.citation.locator.kind !== 'image'
      )
        throw Error('image receipt required');
      expect(imageReceipt.citation.locator.member?.path).toBe(imagePath);
      const attachment = imageReceipt.citation.locator.image;
      expect(attachment.name).toBe('diagram.png');
      const results = notices
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event as { type: string; data: unknown })
        .filter((e) => e.type === 'tool/result');
      expect(JSON.stringify(results)).toContain(
        JSON.stringify({ type: 'image', attachment }),
      );
      const audits =
        await f.db`select metadata from allrice_audit_events where metadata->>'runId'=${run.scope.runId} and action='tool.execute' and decision='allowed'`;
      expect(
        audits.some(
          (a) =>
            a.metadata.nativeCallId === calls[2] &&
            a.metadata.referenceReceiptId === imageReceipt.receiptId,
        ),
      ).toBe(true);
      expect(
        audits.filter(
          (a) =>
            calls.includes(a.metadata.nativeCallId) &&
            reads.some(
              (read) => read.receiptId === a.metadata.referenceReceiptId,
            ),
        ),
      ).toHaveLength(3);
      await client.endRun(sessionId);
      await client.close();
      await changeReferencePublication(x.publisher, saved.sourceId, {
        workspaceId: x.publisher.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'delete',
      });
      const restored = await launch();
      await restored.recover(sessionId);
      await restored.beginRun(sessionId, run.scope.runId);
      await restored.prompt(
        sessionId,
        'Discuss the image already read; do not read new content.',
      );
      await restored.wait(sessionId);
      expect(model.requests).toHaveLength(5);
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(model.requests[4]!.messages)).toContain(
        attachment.name,
      );
      await restored.prompt(sessionId, '重新读取刚才的资料。');
      await restored.wait(sessionId);
      expect(model.requests).toHaveLength(7);
      expect(calls).toHaveLength(4);
      const denied = notices
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event as Record<string, unknown>)
        .findLast((event) => event.type === 'tool/result')!;
      const failure = referenceReadFailure(
        'workspace.reference.archive_read',
        denied.data as Record<string, unknown>,
      );
      expect(failure).toEqual({
        code: 'REFERENCE_UNAVAILABLE',
        retryable: false,
        message: '所选资料尚未就绪、已撤回或访问权限已变化，请重新选择资料。',
      });
      const event = HarnessEventSchema.parse({
        type: 'tool.failed',
        schemaVersion: 1,
        harness: 'dsh',
        generation: 0,
        attempt: 1,
        order: 1,
        threadId: sessionId,
        turnId: null,
        sessionId: run.scope.sessionId,
        messageId: null,
        toolCallId: calls[3],
        name: 'workspace.reference.archive_read',
        label: 'workspace.reference.archive_read',
        source: 'harness',
        summary: failure!.message,
        ...sourceMetadata(denied),
        sourcePayload: { status: 'failed', referenceReadError: failure },
      });
      await appendJobEvent({
        ...run.worker,
        ...normalizeHarnessRunEvent(event),
      });
      const storedEvents = await listRunEvents(
        x.context,
        x.context.workspaceId!,
        run.scope.runId,
      );
      expect(
        storedEvents.findLast((event) => event.type === 'tool.failed')?.payload,
      ).toMatchObject({
        toolCallId: calls[3],
        nativePayload: { referenceReadError: failure },
      });
      expect(JSON.stringify(failure)).not.toContain(saved.sourceId);
      expect(JSON.stringify(failure)).not.toContain(imagePath);
      await restored.endRun(sessionId);
      const [after] =
        await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
      expect(ReferenceReadsSchema.parse(after!.reference_reads)).toEqual(reads);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await model.close();
    }
  }, 60000);
});
