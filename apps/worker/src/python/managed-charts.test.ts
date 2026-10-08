import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PythonExecuteArgsSchema,
  RuntimeLocalPythonProfileSchema,
  managedPythonPayloadForPlatform,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import type * as Database from '@allrice/database';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  create: vi.fn(),
  wait: vi.fn(),
  publish: vi.fn(),
  file: vi.fn(),
  cloud: vi.fn(),
  legacyCloud: vi.fn(),
  runCloud: vi.fn(),
  observe: vi.fn(),
  frozen: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  selectManagedPythonExecution: ports.select,
  createLocalPythonOperation: ports.create,
  waitLocalPythonOperation: ports.wait,
  publishLocalPythonArtifacts: ports.publish,
  getToolBrokerFile: ports.file,
  createCloudPythonOperation: ports.cloud,
  createCloudCommandOperation: ports.legacyCloud,
  executionResourceObserver: () => ({ observe: ports.observe }),
}));
vi.mock('../cloud-runner/executor.js', () => ({
  runCloudCommandOperation: ports.runCloud,
}));
vi.mock('../tool-broker/handlers/cloud-frozen-script.js', () => ({
  resolveCloudToolArguments: ports.frozen,
}));
import { cloudStableId, runtimePolicyDigest } from '@allrice/database';
import { isConfirmedToolFailure } from '../errors.js';
import { executeManagedOffice } from '../office/managed-python.js';
import { NativeOfficeExportSchema } from '@allrice/contracts';
import {
  executePythonCommand,
  executeCloudCommand,
} from '../tool-broker/handlers/cloud.js';

const release = managedPythonPayloadForPlatform('macos-x64')!;
const hash = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const objectId = randomUUID(),
  source = Buffer.from('编号,分类,金额\n001,较长中文分类,-25\n002,办公,10\n');
const input = (args: Record<string, unknown>): RiceToolExecutionInput =>
  ({
    context: {
      runId: randomUUID(),
      jobId: randomUUID(),
      workspaceId: randomUUID(),
      organizationId: randomUUID(),
      policySnapshot: { subjectId: randomUUID() },
    },
    call: {
      id: 'original-python-call',
      name: 'python.execute',
      arguments: args,
    },
    storageRoot: '/tmp/unused-synthetic-python',
    managedBrowserJobAttempt: 1,
    managedBrowserJobLeaseToken: randomUUID(),
  }) as RiceToolExecutionInput;
function argumentsForPng(): Record<string, unknown> {
  return {
    script: "print('中文金额: -15'); create_chart()",
    inputs: [{ path: '费用.csv', objectId, checksum: hash(source) }],
    outputs: [{ path: '中文图.png', fileName: '中文图.png', format: 'png' }],
  };
}
function selection() {
  return {
    choice: { location: 'local', status: 'execute', reason: 'local_ready' },
    selectionReason: 'local_ready',
    operationId: randomUUID(),
    localOnly: false,
    profile: RuntimeLocalPythonProfileSchema.parse({
      contractVersion: 1,
      profileVersion: 1,
      backend: 'local-vm-container-v1',
      imageId: release.imageId,
      architecture: release.architecture,
      pythonVersion: release.pythonVersion,
      packagesChecksum: release.packagesChecksum,
      officeCheckerChecksum: release.officeChecker.sha256,
      pngCheckerChecksum: release.pngChecker.sha256,
      fontChecksum: release.font.sha256,
      available: true,
      purposes: ['office', 'python_charts'],
      officeGeneration: true,
      officeFormulaCalculation: false,
      officePreview: false,
      stopConfirmed: true,
      pythonChartsContractVersion: 1,
    }),
  };
}
function result(payload: RuntimeLocalPythonPayload) {
  const checksum = hash(Buffer.from('synthetic original PNG-byte proof'));
  return {
    backend: 'local-vm-container-v1',
    profileVersion: 1,
    purpose: 'python_charts',
    containerId: '1'.repeat(64),
    imageId: release.imageId,
    architecture: release.architecture,
    stopped: true,
    exitCode: 0,
    reason: 'exited',
    stdout: '中文金额: -15',
    stderr: '',
    truncated: false,
    artifacts: payload.arguments.outputs.map((output) => ({
      ...output,
      sizeBytes: 256,
      checksum,
      validation: output.format === 'png' ? 'trusted_png' : 'utf8',
      ...(output.format === 'png'
        ? {
            png: {
              checker: 'pillow-11.3.0',
              checksum,
              width: 800,
              height: 400,
            },
          }
        : {}),
      collected: true,
    })),
    workCopy: 'local_isolated_copy',
    sourceDirectoryModified: false,
  };
}
let lastPayload: RuntimeLocalPythonPayload;
beforeEach(() => {
  vi.resetAllMocks();
  ports.select.mockResolvedValue(selection());
  ports.file.mockResolvedValue({
    object: {
      id: objectId,
      checksum: hash(source),
      sizeBytes: source.length,
      mediaType: 'text/csv',
    },
  });
  ports.create.mockImplementation(async ({ payload }) => {
    lastPayload = payload as RuntimeLocalPythonPayload;
    return { originalOperation: true };
  });
  ports.wait.mockImplementation(async () => ({
    operationId: 'original-operation',
    status: 'succeeded',
    evidence: { output: result(lastPayload) },
  }));
  ports.publish.mockImplementation(async () =>
    result(lastPayload).artifacts.map((artifact) => ({
      object: {
        id: artifact.objectId,
        checksum: artifact.checksum,
        sizeBytes: artifact.sizeBytes,
        mediaType: artifact.mediaType,
      },
      fileName: artifact.fileName,
      versionId: randomUUID(),
    })),
  );
  ports.cloud.mockResolvedValue({ originalCloudOperation: true });
  ports.runCloud.mockResolvedValue({
    operationId: 'cloud-operation',
    status: 'succeeded',
    artifacts: [],
    output: 'cloud Python output',
  });
});
const run = (request: RiceToolExecutionInput) =>
  executePythonCommand({ input: request, arguments: request.call.arguments });

describe('canonical Python original-call execution adapter', () => {
  it('keeps omitted language/location/raw bytes and publishes the original ready object instead of a version ID', async () => {
    const args = argumentsForPng(),
      request = input(args),
      before = JSON.stringify(args),
      response = await run(request),
      model = JSON.parse(response.modelContent);
    expect(ports.select).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'python.execute',
        purpose: 'python_charts',
        arguments: args,
        location: 'auto',
        callId: request.call.id,
        jobLeaseToken: request.managedBrowserJobLeaseToken,
        inputs: [
          {
            ...PythonExecuteArgsSchema.parse(args).inputs[0],
            sizeBytes: source.length,
            mediaType: 'text/csv',
          },
        ],
      }),
    );
    expect(ports.create.mock.calls[0]![0].arguments).toBe(args);
    expect(lastPayload.arguments.origin.argumentsDigest).toBe(
      runtimePolicyDigest(args),
    );
    expect(lastPayload.arguments.outputs[0]!.objectId).toBe(
      cloudStableId(
        `managed-python-output:${request.context.runId}:${request.call.id}:0`,
      ),
    );
    expect(lastPayload.arguments.limits).toMatchObject({
      inputBytes: 2_000_000,
      artifactBytes: 1_000_000,
      timeoutMs: 30_000,
    });
    expect(model).toMatchObject({
      status: 'succeeded',
      location: 'local',
      language: 'python',
      source: 'local-vm-container-v1',
      output: '中文金额: -15',
      artifacts: [
        {
          objectId: lastPayload.arguments.outputs[0]!.objectId,
          png: { checker: 'pillow-11.3.0', width: 800, height: 400 },
        },
      ],
    });
    expect(model.artifacts[0].objectId).not.toBe(model.artifacts[0].versionId);
    expect(ports.publish).toHaveBeenCalledTimes(1);
    expect(ports.cloud).not.toHaveBeenCalled();
    expect(ports.frozen).not.toHaveBeenCalled();
    expect(JSON.stringify(args)).toBe(before);
  });
  it.each(['local_busy', 'local_preparing'])(
    'durably waits for %s using the same call without creating any cloud slot',
    async (reason) => {
      const request = input(argumentsForPng());
      ports.select.mockResolvedValueOnce({
        ...selection(),
        choice: { location: 'local', status: 'wait', reason },
      });
      const promise = run(request);
      await vi.waitFor(() => expect(ports.observe).toHaveBeenCalled(), {
        timeout: 200,
      });
      expect(ports.cloud).not.toHaveBeenCalled();
      expect(ports.create).not.toHaveBeenCalled();
      await promise;
      expect(ports.select).toHaveBeenCalledTimes(2);
      expect(
        ports.select.mock.calls.every(
          ([call]) => call.arguments === request.call.arguments,
        ),
      ).toBe(true);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.observe.mock.calls).toEqual([
        [{ stage: 'queued', reason }],
        [{ stage: 'completed' }],
      ]);
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('cancellation during local preparation never creates an operation or falls back', async () => {
    const cancel = new AbortController(),
      request = { ...input(argumentsForPng()), signal: cancel.signal };
    ports.select.mockResolvedValue({
      ...selection(),
      choice: { location: 'local', status: 'wait', reason: 'local_preparing' },
    });
    ports.observe.mockImplementation(async ({ stage }) => {
      if (stage === 'queued') cancel.abort();
    });
    await expect(run(request)).rejects.toThrow();
    expect(ports.observe).toHaveBeenLastCalledWith({ stage: 'canceled' });
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.cloud).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'reconcile'])(
    'does not execute or migrate a %s choice',
    async (status) => {
      ports.select.mockResolvedValue({
        ...selection(),
        choice: { location: 'local', status, reason: 'local_inputs_required' },
      });
      await expect(run(input(argumentsForPng()))).rejects.toMatchObject({
        retryable: false,
      });
      expect(ports.create).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('rejects an old .15 profile and never infers the new protocol from its purposes', async () => {
    const legacy = selection();
    delete legacy.profile.pythonChartsContractVersion;
    ports.select.mockResolvedValue(legacy);
    await expect(run(input(argumentsForPng()))).rejects.toMatchObject({
      code: 'PYTHON_LOCAL_UNAVAILABLE',
    });
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.cloud).not.toHaveBeenCalled();
  });
  it.each([{ location: 'local' }, { localOnly: true }])(
    'enforces local-only intent even if an inconsistent selector returns cloud (%j)',
    async (constraint) => {
      ports.select.mockResolvedValue({
        ...selection(),
        ...('localOnly' in constraint ? constraint : {}),
        choice: {
          location: 'cloud',
          status: 'execute',
          reason: 'cloud_requested',
        },
      });
      await expect(
        run(
          input({
            ...argumentsForPng(),
            ...('location' in constraint ? constraint : {}),
          }),
        ),
      ).rejects.toMatchObject({ code: 'PYTHON_LOCAL_UNAVAILABLE' });
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('uses authorized cloud substitution via the original executor without Node frozen-script resolution', async () => {
    const args = { script: "print('Python')", location: 'cloud' },
      request = input(args),
      before = JSON.stringify(args);
    ports.select.mockResolvedValue({
      ...selection(),
      choice: {
        location: 'cloud',
        status: 'execute',
        reason: 'cloud_requested',
      },
      selectionReason: 'cloud_requested',
    });
    const response = await run(request);
    expect(ports.cloud).toHaveBeenCalledWith({
      context: request.context,
      callId: request.call.id,
      arguments: args,
    });
    expect(ports.cloud.mock.calls[0]![0].arguments).toBe(args);
    expect(ports.runCloud).toHaveBeenCalledWith(
      { originalCloudOperation: true },
      { storage: expect.any(Object) },
    );
    expect(JSON.parse(response.modelContent)).toMatchObject({
      location: 'cloud',
      language: 'python',
      selectionReason: 'cloud_requested',
    });
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.frozen).not.toHaveBeenCalled();
    expect(JSON.stringify(args)).toBe(before);
  });
  it.each(['jobAttempt', 'leaseToken'])(
    'rejects missing %s before either admission or cloud execution',
    async (missing) => {
      const request = input({ script: "print('ok')", location: 'cloud' });
      if (missing === 'jobAttempt') delete request.managedBrowserJobAttempt;
      else delete request.managedBrowserJobLeaseToken;
      await expect(run(request)).rejects.toMatchObject({
        code: 'PYTHON_EXECUTION_UNAVAILABLE',
      });
      expect(ports.select).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it.each(['changed', 'oversize', 'aggregate'])(
    'authorizes exact actual input metadata and rejects %s inputs before selecting any backend',
    async (problem) => {
      const args = argumentsForPng();
      if (problem === 'aggregate')
        args.inputs = [
          { path: 'a.csv', objectId, checksum: hash(source) },
          { path: 'b.csv', objectId: randomUUID(), checksum: hash(source) },
        ];
      ports.file.mockResolvedValue({
        object: {
          id: objectId,
          checksum:
            problem === 'changed' ? hash(Buffer.from('changed')) : hash(source),
          sizeBytes: problem === 'oversize' ? 2_000_001 : 1_000_001,
          mediaType: 'text/csv',
        },
      });
      await expect(run(input(args))).rejects.toMatchObject({
        retryable: false,
      });
      expect(ports.select).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('supports stdout-only Python with no output objects or Office validator', async () => {
    const response = await run(input({ script: "print('合计1400.5')" }));
    expect(lastPayload.arguments.outputs).toEqual([]);
    expect(JSON.parse(response.modelContent)).toMatchObject({
      location: 'local',
      status: 'succeeded',
      artifacts: [],
      output: '中文金额: -15',
    });
    expect(response.itemCount).toBe(0);
  });
  it.each([
    'missing_png',
    'changed_png',
    'wrong_pin',
    'wrong_object',
    'duplicates',
    'unstopped',
  ])(
    'does not publish or retry an inconsistent local result (%s)',
    async (problem) => {
      ports.wait.mockImplementation(async () => {
        const output = result(lastPayload);
        if (problem === 'missing_png') delete output.artifacts[0]!.png;
        if (problem === 'changed_png')
          output.artifacts[0]!.png!.checksum = hash(Buffer.from('wrong'));
        if (problem === 'wrong_pin')
          output.imageId = hash(Buffer.from('wrong image'));
        if (problem === 'wrong_object')
          output.artifacts[0]!.objectId = randomUUID();
        if (problem === 'duplicates')
          output.artifacts.push({ ...output.artifacts[0]! });
        if (problem === 'unstopped') output.stopped = false;
        return {
          operationId: 'original-operation',
          status: 'succeeded',
          evidence: { output },
        };
      });
      await expect(run(input(argumentsForPng()))).rejects.toMatchObject({
        code: 'PYTHON_LOCAL_RESULT_UNKNOWN',
        retryable: false,
      });
      expect(ports.publish).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
      expect(ports.create).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['canceled', 'timeout', 'memory_limit'])(
    'confirms only a physically stopped %s failure for the exact original call, without publication or replay',
    async (reason) => {
      const request = input(argumentsForPng());
      ports.wait.mockImplementation(async () => ({
        operationId: 'original-operation',
        status: reason === 'canceled' ? 'canceled' : 'failed',
        evidence: {
          output: {
            ...result(lastPayload),
            exitCode: 137,
            reason,
            artifacts: [],
          },
        },
      }));
      const error = await run(request).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: 'PYTHON_RUNTIME_FAILED',
        retryable: false,
      });
      expect(
        isConfirmedToolFailure(error, {
          runId: request.context.runId,
          callId: request.call.id,
          toolName: request.call.name,
        }),
      ).toBe(true);
      expect(ports.publish).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('retains an unknown receipt with no cross-end replay or claimed success', async () => {
    ports.wait.mockResolvedValue({
      operationId: 'original-operation',
      status: 'unknown',
      evidence: null,
    });
    await expect(run(input(argumentsForPng()))).rejects.toMatchObject({
      code: 'PYTHON_LOCAL_RESULT_UNKNOWN',
      retryable: false,
    });
    expect(ports.publish).not.toHaveBeenCalled();
    expect(ports.cloud).not.toHaveBeenCalled();
  });
  it.each(['python', 'office'])(
    'reports a committed input download failure as not executed for %s, without replay or publication',
    async (purpose) => {
      const request = input(argumentsForPng());
      if (purpose === 'office') request.call.name = 'workspace.export.create';
      ports.wait.mockResolvedValue({
        operationId: 'original-operation',
        status: 'failed',
        effects: 'none',
        evidence: { errorCode: 'INPUT_DOWNLOAD_UNAVAILABLE' },
      });
      const failure = await (
        purpose === 'python'
          ? run(request)
          : executeManagedOffice(
              request,
              'xlsx',
              NativeOfficeExportSchema.parse({
                script: "print('original Office script')",
                inputs: [],
              }),
            )
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: `${purpose.toUpperCase()}_PREFLIGHT_FAILED`,
        retryable: false,
      });
      expect((failure as Error).message).toContain('已确认未执行');
      expect(
        isConfirmedToolFailure(failure, {
          runId: request.context.runId,
          callId: request.call.id,
          toolName: request.call.name,
        }),
      ).toBe(true);
      expect(
        isConfirmedToolFailure(failure, {
          runId: request.context.runId,
          callId: 'another-call',
          toolName: request.call.name,
        }),
      ).toBe(false);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.publish).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 'unknown', effects: 'none' },
    { status: 'failed', effects: undefined },
    { status: 'failed', effects: 'partial' },
    { status: 'failed', effects: 'applied' },
    { status: 'succeeded', effects: 'none' },
    { status: 'failed', effects: 'none', errorCode: 'UNRECOGNIZED_FAILURE' },
    { status: 'failed', effects: 'none', output: {} },
  ])(
    'does not settle an unproven or contradictory preflight failure (%j)',
    async ({ status, effects, errorCode, output }) => {
      const request = input(argumentsForPng());
      ports.wait.mockResolvedValue({
        operationId: 'original-operation',
        status,
        effects,
        evidence: {
          errorCode: errorCode ?? 'INPUT_DOWNLOAD_UNAVAILABLE',
          ...(output === undefined ? {} : { output }),
        },
      });
      const failure = await run(request).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PYTHON_LOCAL_RESULT_UNKNOWN' });
      expect(
        isConfirmedToolFailure(failure, {
          runId: request.context.runId,
          callId: request.call.id,
          toolName: request.call.name,
        }),
      ).toBe(false);
      expect(ports.create).toHaveBeenCalledTimes(1);
      expect(ports.publish).not.toHaveBeenCalled();
      expect(ports.cloud).not.toHaveBeenCalled();
    },
  );
  it('rejects mismatched metadata from the publisher instead of replacing objectId with a version', async () => {
    ports.publish.mockResolvedValue([
      {
        object: { id: randomUUID() },
        fileName: '中文图.png',
        versionId: randomUUID(),
      },
    ]);
    await expect(run(input(argumentsForPng()))).rejects.toMatchObject({
      code: 'PYTHON_LOCAL_RESULT_UNKNOWN',
    });
    expect(ports.cloud).not.toHaveBeenCalled();
  });
  it('preserves legacy cloud Node dispatch and frozen resolver without injecting language or location', async () => {
    const raw = { script: "console.log('legacy')" },
      request = input(raw);
    request.call.name = 'cloud.process.execute';
    ports.frozen.mockResolvedValue(raw);
    ports.legacyCloud.mockResolvedValue({ legacyNodeOperation: true });
    const response = await executeCloudCommand({
      input: request,
      arguments: raw,
    });
    expect(ports.frozen).toHaveBeenCalledWith({
      context: request.context,
      arguments: raw,
    });
    expect(ports.legacyCloud).toHaveBeenCalledWith({
      context: request.context,
      callId: request.call.id,
      arguments: raw,
    });
    expect(ports.runCloud).toHaveBeenCalledWith(
      { legacyNodeOperation: true },
      { storage: expect.any(Object) },
    );
    expect(ports.select).not.toHaveBeenCalled();
    expect(ports.cloud).not.toHaveBeenCalled();
    expect(JSON.parse(response.modelContent).source).toBe('cloud-gvisor-v1');
    expect(raw).not.toHaveProperty('language');
    expect(raw).not.toHaveProperty('location');
  });
});
