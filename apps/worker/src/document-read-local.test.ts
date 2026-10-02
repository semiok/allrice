import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  WorkspaceDocumentReadArgsSchema,
  localPdfPreExecutionDenialCodes,
  makeObjectKey,
  pdfReadReleaseForPlatform,
  type RuntimeLocalPdfPayload,
  type RuntimeLocalPdfResult,
} from '@allrice/contracts';
import type * as Database from '@allrice/database';
import type { RiceToolExecutionInput } from './tool-broker/types.js';

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  create: vi.fn(),
  wait: vi.fn(),
  observer: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  selectLocalPdfExecution: ports.select,
  createLocalPdfReadOperation: ports.create,
  waitLocalPdfReadOperation: ports.wait,
  executionResourceObserver: ports.observer,
}));
import { runtimePolicyDigest } from '@allrice/database';
import { HandlerError, isConfirmedToolFailure } from './errors.js';
import { readPdfLocally } from './document-read-local.js';

const release = pdfReadReleaseForPlatform('macos-x64')!;
const bytes = readFileSync(
  new URL(
    '../../../tests/fixtures/pdf/01-chinese-multipage-digital.pdf',
    import.meta.url,
  ),
);
const sourceId = randomUUID();
const checksum =
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

function request(
  argumentsInput: Record<string, unknown> = {
    objectId: sourceId,
    pages: [2, 2],
    includeStructure: true,
  },
): RiceToolExecutionInput {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  return {
    context: ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: randomUUID(),
      jobId: randomUUID(),
      organizationId,
      workspaceId,
      worker: { type: 'worker', id: randomUUID() },
      delegatedBy: { type: 'user', id: ownerId },
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: randomUUID(),
        organizationId,
        subjectId: ownerId,
        version: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        memberships: [],
        grants: [
          {
            resourceType: 'storage_object',
            action: 'resource:read',
            workspaceId,
          },
        ],
      },
    }),
    capabilities: ['storage:read'],
    storageRoot: '/tmp/unused-local-pdf-adapter-test',
    call: {
      id: 'original-pdf-read',
      name: 'workspace.document.read',
      arguments: argumentsInput,
    },
    managedBrowserJobAttempt: 3,
    managedBrowserJobLeaseToken: randomUUID(),
  };
}

function file(
  input: RiceToolExecutionInput,
): Awaited<ReturnType<typeof Database.getToolBrokerFile>> {
  return {
    object: {
      id: sourceId,
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId!,
      ownerId: input.context.delegatedBy.id,
      key: makeObjectKey({
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId!,
        ownerId: input.context.delegatedBy.id,
        category: 'uploads',
        objectId: sourceId,
      }),
      checksum,
      mediaType: 'application/pdf',
      sizeBytes: bytes.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
    fileName: '中文数字来源.pdf',
    visibility: 'private',
    artifactVersionId: randomUUID(),
    artifactVersion: 3,
  };
}

function selection() {
  return {
    choice: { location: 'local', status: 'execute', reason: 'local_ready' },
    operationId: randomUUID(),
    profile: { pins: release.pins },
  };
}

function successful(payload: RuntimeLocalPdfPayload): RuntimeLocalPdfResult {
  const pages = payload.arguments.options.pages
    ? [...new Set(payload.arguments.options.pages)].sort((a, b) => a - b)
    : [1, 2];
  return {
    type: 'local_pdf_read_result_v1',
    origin: { ...payload.arguments.origin },
    source: { ...payload.arguments.source },
    profileVersion: 1,
    pins: { ...payload.arguments.pins },
    document: {
      kind: 'pdf',
      text: '第二页原始数字：00123 / -200.00',
      truncated: false,
      units: [
        {
          label: '第 2 页',
          text: '第二页原始数字：00123 / -200.00',
          pageNumber: 2,
        },
      ],
      warnings: [],
      totalPages: 2,
      requestedPages: pages,
      nextPages: [],
      quality: 'digital_text',
      warningCodes: [],
      parser: { name: 'pdf-parse', version: '2.4.5' },
      ...(payload.arguments.options.includeStructure
        ? {
            tables: [
              {
                pageNumber: 2,
                tableNumber: 1,
                rows: [{ rowNumber: 1, cells: ['00123', '-200.00'] }],
              },
            ],
          }
        : {}),
    },
    error: null,
    process: {
      stopped: true,
      exitCode: 0,
      reason: 'completed',
      memoryEnforcement: 'watchdog',
      observedPeakRssBytes: 128_000_000,
    },
  };
}

let lastPayload: RuntimeLocalPdfPayload;
function resetPorts() {
  vi.resetAllMocks();
  ports.select.mockResolvedValue(selection());
  ports.create.mockImplementation(
    async ({ payload }: { payload: RuntimeLocalPdfPayload }) => {
      lastPayload = payload;
      return { originalOperation: true };
    },
  );
  ports.wait.mockImplementation(async () => ({
    operationId: 'original-operation',
    status: 'succeeded',
    evidence: { output: successful(lastPayload) },
  }));
  ports.observer.mockReturnValue({ observe: ports.observe });
}
beforeEach(resetPorts);

function run(input: RiceToolExecutionInput, source = file(input)) {
  return readPdfLocally(
    input,
    source,
    WorkspaceDocumentReadArgsSchema.parse(input.call.arguments),
  );
}
async function failed(input: RiceToolExecutionInput) {
  let error: unknown;
  try {
    await run(input);
  } catch (caught) {
    error = caught;
  }
  // A null return would authorize the caller's cloud path. Unknown local work
  // must reject rather than return null or retry its original operation.
  expect(error).toBeInstanceOf(HandlerError);
  return error as HandlerError;
}
function identity(input: RiceToolExecutionInput) {
  return {
    runId: input.context.runId,
    callId: input.call.id,
    toolName: input.call.name,
  };
}

describe('fixed local PDF Worker adapter', () => {
  it('passes only the original read context, raw arguments and actual source/version/pins without adding defaults', async () => {
    const input = request(),
      source = file(input),
      raw = input.call.arguments;
    const before = JSON.stringify(raw);
    const response = await run(input, source);
    const selected = ports.select.mock.calls[0]![0];
    expect(input.capabilities).toEqual(['storage:read']);
    expect(selected.context).toBe(input.context);
    expect(selected.arguments).toBe(raw);
    expect(selected).toMatchObject({
      callId: input.call.id,
      toolName: input.call.name,
      location: 'auto',
      jobAttempt: 3,
      jobLeaseToken: input.managedBrowserJobLeaseToken,
    });
    expect(selected.source).toEqual({
      objectId: sourceId,
      checksum,
      sizeBytes: bytes.length,
      mediaType: 'application/pdf',
      artifactVersionId: source.artifactVersionId,
      artifactVersion: 3,
    });
    expect(ports.create.mock.calls[0]![0].arguments).toBe(raw);
    expect(lastPayload.arguments).toMatchObject({
      source: selected.source,
      fileName: source.fileName,
      pins: release.pins,
      origin: {
        toolName: input.call.name,
        callId: input.call.id,
        argumentsDigest: runtimePolicyDigest(raw),
      },
    });
    expect(lastPayload.arguments.options).toEqual({
      pages: [2, 2],
      includeStructure: true,
    });
    expect(lastPayload.arguments.options).not.toHaveProperty('maxCharacters');
    expect(lastPayload.arguments).not.toHaveProperty('script');
    expect(lastPayload.arguments).not.toHaveProperty('outputs');
    expect(JSON.stringify(raw)).toBe(before);
    expect(response).toMatchObject({
      document: { requestedPages: [2] },
      execution: { location: 'local', operationId: 'original-operation' },
    });
    expect(ports.observe).not.toHaveBeenCalled();
    expect(ports.select).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.wait).toHaveBeenCalledTimes(1);
  });

  it('classifies physically stopped cancel and timeout failures with null exit codes as confirmed failures', async () => {
    for (const reason of ['canceled', 'timeout'] as const) {
      resetPorts();
      const input = request(),
        code = reason === 'canceled' ? 'PDF_CANCELED' : 'PDF_TIMEOUT';
      ports.wait.mockImplementation(async () => {
        const output = successful(lastPayload);
        return {
          status: reason === 'canceled' ? 'canceled' : 'failed',
          evidence: {
            output: {
              ...output,
              document: null,
              error: { code, message: 'Fixed parser physically stopped' },
              process: {
                ...output.process,
                stopped: true,
                exitCode: null,
                reason,
              },
            },
          },
        };
      });
      const error = await failed(input);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(false);
      expect(isConfirmedToolFailure(error, identity(input))).toBe(true);
      expect(
        isConfirmedToolFailure(error, {
          ...identity(input),
          callId: 'another-call',
        }),
      ).toBe(false);
      expect(ports.select).toHaveBeenCalledTimes(1);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.wait).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps unconfirmed process stop and substituted source/pins unknown without returning a cloud fallback', async () => {
    for (const kind of [
      'process_unknown',
      'stop_false',
      'source',
      'pins',
    ] as const) {
      resetPorts();
      const input = request();
      ports.wait.mockImplementation(async () => {
        const output = successful(lastPayload);
        if (kind === 'source') output.source.artifactVersion = 4;
        else if (kind === 'pins')
          output.pins.policyChecksum = `sha256:${'f'.repeat(64)}`;
        else {
          output.document = null;
          output.error = {
            code: 'PDF_STOP_UNCONFIRMED',
            message: 'No trusted final stop',
          };
          output.process = {
            ...output.process,
            stopped: kind !== 'stop_false',
            exitCode: null,
            reason: kind === 'process_unknown' ? 'process_unknown' : 'timeout',
          };
        }
        return {
          status: kind === 'source' || kind === 'pins' ? 'succeeded' : 'failed',
          evidence: { output },
        };
      });
      const error = await failed(input);
      expect(error.code).toBe('PDF_LOCAL_RESULT_UNKNOWN');
      expect(isConfirmedToolFailure(error, identity(input))).toBe(false);
      expect(ports.select).toHaveBeenCalledTimes(1);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.wait).toHaveBeenCalledTimes(1);
    }
  });

  it('recognizes all seven fixed pre-execution denials from a failed ledger without inventing a process result', async () => {
    expect(localPdfPreExecutionDenialCodes).toHaveLength(7);
    for (const errorCode of localPdfPreExecutionDenialCodes) {
      resetPorts();
      const input = request();
      ports.wait.mockResolvedValue({
        status: 'failed',
        evidence: { output: { errorCode } },
      });
      const error = await failed(input);
      expect(error.code).toBe(errorCode);
      expect(error.message).toContain('启动前');
      expect(isConfirmedToolFailure(error, identity(input))).toBe(true);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.wait).toHaveBeenCalledTimes(1);
    }
  });

  it('does not promote an existing attempt, unclassified failure or unsettled safe code to a known failure', async () => {
    for (const [status, errorCode] of [
      ['failed', 'PDF_ATTEMPT_EXISTS'],
      ['failed', 'UNCLASSIFIED_PROCESS_FAILURE'],
      ['unknown', 'PDF_EXECUTION_REVOKED'],
    ] as const) {
      resetPorts();
      const input = request();
      ports.wait.mockResolvedValue({
        status,
        evidence: { output: { errorCode } },
      });
      const error = await failed(input);
      expect(error.code).toBe('PDF_LOCAL_RESULT_UNKNOWN');
      expect(isConfirmedToolFailure(error, identity(input))).toBe(false);
      expect(ports.create).toHaveBeenCalledTimes(1);
    }
  });

  it('allows the original cloud path without a lease for auto/cloud but rejects explicit local before any admission', async () => {
    for (const missing of [
      'managedBrowserJobAttempt',
      'managedBrowserJobLeaseToken',
    ] as const) {
      for (const location of [undefined, 'auto', 'cloud', 'local'] as const) {
        resetPorts();
        const input = request({
          objectId: sourceId,
          ...(location ? { location } : {}),
        });
        delete input[missing];
        if (location === 'local')
          expect((await failed(input)).code).toBe('PDF_LOCAL_UNAVAILABLE');
        else expect(await run(input)).toBeNull();
        expect(ports.select).not.toHaveBeenCalled();
        expect(ports.create).not.toHaveBeenCalled();
        expect(ports.wait).not.toHaveBeenCalled();
        expect(ports.observer).not.toHaveBeenCalled();
      }
    }
  });

  it('returns null only for an admitted cloud choice and never executes unavailable or reconcile choices', async () => {
    ports.select.mockResolvedValueOnce({
      choice: {
        location: 'cloud',
        status: 'execute',
        reason: 'explicit_cloud',
      },
    });
    expect(
      await run(request({ objectId: sourceId, location: 'cloud' })),
    ).toBeNull();
    expect(ports.create).not.toHaveBeenCalled();
    for (const status of ['unavailable', 'reconcile'] as const) {
      resetPorts();
      ports.select.mockResolvedValueOnce({
        choice: { location: 'local', status, reason: 'local_unknown' },
      });
      const error = await failed(request());
      expect(error.code).toBe(
        status === 'reconcile'
          ? 'PDF_LOCAL_RESULT_UNKNOWN'
          : 'PDF_LOCAL_UNAVAILABLE',
      );
      expect(ports.select).toHaveBeenCalledTimes(1);
      expect(ports.create).not.toHaveBeenCalled();
      expect(ports.wait).not.toHaveBeenCalled();
    }
  });
});
