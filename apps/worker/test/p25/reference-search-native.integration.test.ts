import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { referenceToolNames, ReferenceReadsSchema } from '@allrice/contracts';
import * as database from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { referenceToolFixture } from '../../../../packages/database/src/reference-tool.fixture.ts';
import { changeReferencePublication } from '../../../../packages/database/src/reference-library.ts';
import {
  executeEmployeeReferenceTool,
  assertEmployeeContentContext,
} from '../../../../packages/database/src/employees/employee-runtime-content.ts';
import { executeRiceTool, riceToolDefinitions } from '../../src/tool-broker.js';
import { dshInboundToolHandler } from '../../src/harness/dsh/tool-bridge.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { p24Fixture } from '../p24/fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'R3 admitted conversation → native Host → Worker Broker → PostgreSQL',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let x: Awaited<ReturnType<typeof referenceToolFixture>>;
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
      x = await referenceToolFixture(f);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      await f?.close();
    }, 30000);

    it('native search/read exposes actual retained excerpts and stable citations to the model without XML or file exports', async () => {
      const text = '完整企业政策背景。'.repeat(800) + '差旅上限为九百元。';
      const saved = await x.publish(text);
      const hidden = await x.publish('私人财务秘密', {
        audience: { scope: 'personal', departmentIds: [] },
        fileName: '不要泄漏的标题.txt',
      });
      const run = await x.run();
      expect(
        run.resolved.executionSnapshot!.capabilitySnapshot.bindings.toolNames,
      ).toEqual(expect.arrayContaining([...referenceToolNames]));
      let discovered: Record<string, unknown> | undefined;
      const pages: Record<string, unknown>[] = [];
      const receiptCounts: number[] = [];
      const denials: unknown[] = [];
      const model = await p24Fixture(async (request, index) => {
        if (index === 1)
          return {
            nativeTool: {
              name: 'workspace_reference_search',
              arguments: { query: '差旅上限' },
            },
          };
        if (index === 2) {
          expect(discovered).toBeDefined();
          expect(JSON.stringify(request.messages)).toContain('九百元');
          expect(JSON.stringify(request.messages)).toContain('R1');
          const { sourceId, revisionId, digest, checksum } = discovered!;
          return {
            nativeTool: {
              name: 'workspace_reference_read',
              arguments: {
                sourceId,
                revisionId,
                digest,
                checksum,
                offset: text.indexOf('差旅上限'),
              },
            },
          };
        }
        if (index >= 3 && index <= 5) {
          if (index === 3) {
            expect(pages[0]).toMatchObject({
              content: '差旅上限为九百元。',
              citation: { referenceLabel: 'R1' },
            });
            expect(receiptCounts).toEqual([1]);
          }
          if (index === 4)
            expect(pages[1]).toMatchObject({
              content: '。',
              nextOffset: null,
              citation: { referenceLabel: 'R2' },
            });
          if (index === 5) {
            expect(pages[2]).toMatchObject({
              content: '',
              start: text.length,
              end: text.length,
              nextOffset: null,
            });
            expect(pages[2]).not.toHaveProperty('citation');
            expect(receiptCounts).toEqual([1, 2, 2]);
          }
          return {
            nativeTool: {
              name: 'workspace_reference_read',
              arguments: { ...saved.pin, offset: text.length + index - 4 },
            },
          };
        }
        if (index === 6) {
          expect(denials).toHaveLength(1);
          expect(denials[0]).toMatchObject({
            code: 'TOOL_INPUT_INVALID',
            retryable: false,
          });
          expect(JSON.stringify(request.messages)).toContain(
            '读取起点超出资料正文长度',
          );
          expect(JSON.stringify(request.messages)).not.toContain(
            'AllRice Tool Broker request failed',
          );
          await changeReferencePublication(x.publisher, saved.sourceId, {
            workspaceId: x.publisher.workspaceId,
            requestId: randomUUID(),
            expectedRevision: 1,
            action: 'delete',
          });
          return {
            nativeTool: {
              name: 'workspace_reference_read',
              arguments: saved.pin,
            },
          };
        }
        expect(index).toBe(7);
        expect(denials).toHaveLength(2);
        expect(denials[1]).toMatchObject({
          code: 'REFERENCE_UNAVAILABLE',
          retryable: false,
        });
        expect(JSON.stringify(request.messages)).toContain('访问权限已变化');
        await assertEmployeeContentContext(
          run.scope,
          run.runtime.generationId,
          run.worker,
        );
        return { text: '差旅上限为九百元，出处 R1。' };
      });
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: resolve(
            import.meta.dirname,
            '../../dsh/allrice-restricted.cordis.yml',
          ),
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_OPENAI_COMPATIBLE_MODEL: 'r3-synthetic',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      const notices: DshNotification[] = [],
        calls: string[] = [],
        failures: unknown[] = [];
      client.subscribe((notice) => notices.push(notice));
      const tools = riceToolDefinitions.filter((tool) =>
        referenceToolNames.some((name) => name === tool.name),
      );
      client.setRequestHandler(
        dshInboundToolHandler({
          tools,
          onToolCall: async (call) => {
            calls.push(call.name);
            const result = await executeRiceTool({
              context: run.execution.context,
              capabilities: run.resolved.grantedCapabilities,
              storageRoot: '.unused-r3-native-test',
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
                ),
            }).catch((error: unknown) => {
              denials.push(error);
              throw error;
            });
            if (call.name === 'workspace.reference.search')
              discovered = JSON.parse(result.modelContent).results[0];
            else {
              pages.push(JSON.parse(result.modelContent));
              const [stored] =
                await f.db`select jsonb_array_length(reference_reads)::int n from allrice_employee_runs where run_id=${run.scope.runId}`;
              receiptCounts.push(stored!.n);
              if (pages.length === 3) expect(result.itemCount).toBe(0);
            }
            return result;
          },
        }),
      );
      try {
        await client.initialize({
          cwd: model.root,
          provider: 'openai-compatible',
          model: 'r3-synthetic',
          nativeTools: [...referenceToolNames],
          expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        });
        await client.prompt(
          'r3-' + randomUUID(),
          '查企业资料里的差旅上限并列出出处。',
        );
        await expect
          .poll(
            () =>
              notices.some(
                (notice) =>
                  notice.method === 'session.event' &&
                  (notice.params.event as { type: string }).type === 'turn/end',
              ),
            { timeout: 15000 },
          )
          .toBe(true);
        expect(calls).toEqual([
          referenceToolNames[0],
          ...Array<string>(5).fill(referenceToolNames[1]),
        ]);
        expect(model.requests).toHaveLength(7);
        expect(
          model.requests[0]!.tools!.map((tool) => tool.function.name),
        ).toEqual(
          expect.arrayContaining([
            'workspace_reference_search',
            'workspace_reference_read',
          ]),
        );
        expect(JSON.stringify(model.requests)).not.toContain(hidden.sourceId);
        expect(JSON.stringify(model.requests)).not.toContain('不要泄漏的标题');
        expect(JSON.stringify(model.requests)).not.toContain(
          '<allrice_tool_call>',
        );
        const [stored] =
          await f.db`select reference_reads from allrice_employee_runs where run_id=${run.scope.runId}`;
        const reads = ReferenceReadsSchema.parse(stored!.reference_reads);
        expect(reads).toHaveLength(2);
        expect(reads[0]).toMatchObject({
          origin: { kind: 'tool', toolName: 'workspace.reference.search' },
          citation: { reference: saved.pin, referenceLabel: 'R1' },
        });
        expect(reads[1]).toMatchObject({
          origin: { kind: 'tool', toolName: 'workspace.reference.read' },
          citation: {
            reference: saved.pin,
            referenceLabel: 'R2',
            locator: { start: text.length - 1, end: text.length },
          },
        });
        const audits =
          await f.db`select action,decision,metadata from allrice_audit_events where metadata->>'runId'=${run.scope.runId} and action='tool.execute'`;
        expect(JSON.stringify(audits)).toContain('workspace.reference.search');
        expect(JSON.stringify(audits)).toContain('workspace.reference.read');
        expect(audits.filter((row) => row.decision === 'allowed')).toHaveLength(
          4,
        );
        expect(audits.filter((row) => row.decision === 'denied')).toMatchObject(
          expect.arrayContaining([
            { metadata: { errorCode: 'TOOL_INPUT_INVALID', retryable: false } },
            {
              metadata: {
                errorCode: 'REFERENCE_UNAVAILABLE',
                retryable: false,
              },
            },
          ]),
        );
        const [exports] =
          await f.db`select count(*)::int n from allrice_storage_objects where organization_id=${run.scope.organizationId} and category='exports'`;
        expect(exports!.n).toBe(0);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await client.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await model.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'R3 native fixture (original failure first)',
        );
    }, 120000);
  },
);
