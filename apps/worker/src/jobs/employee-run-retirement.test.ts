import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDefinitionSchema,
  EmployeePersonaPinSchema,
  renderEmployeePersonaDocument,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
  runtimePolicyDigest,
} from '@allrice/database';
import type * as Database from '@allrice/database';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import type * as PlatformRepair from './platform-repair.js';
import type * as SubscriptionPreflight from '../subscription-preflight.js';
import type * as HarnessRouter from '../harness/router.js';

const ports = vi.hoisted(() => ({
  resolve: vi.fn(),
  acquire: vi.fn(),
  review: vi.fn(),
  repair: vi.fn(),
  repositoryReview: vi.fn(),
  changeset: vi.fn(),
  documents: vi.fn(),
  experiences: vi.fn(),
  quality: vi.fn(),
  reverify: vi.fn(),
  modelAdmission: vi.fn(),
  preflight: vi.fn(),
  router: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveEmployeeExecution: ports.resolve,
  acquireConversationRuntime: ports.acquire,
  assertReviewRunCurrent: ports.review,
  getPlatformRepairExecution: ports.repair,
  getPlatformRepositoryReviewExecution: ports.repositoryReview,
  getChangesetRun: ports.changeset,
  prepareRunExperiences: ports.experiences,
  admitModelExecution: ports.modelAdmission,
}));
vi.mock('./employee-document-admission.js', () => ({
  admitEmployeeDocuments: ports.documents,
}));
vi.mock('./platform-quality.js', () => ({
  executePlatformQualityCheck: ports.quality,
}));
vi.mock('./platform-repair.js', async (original) => ({
  ...(await original<typeof PlatformRepair>()),
  executePlatformRepairReverification: ports.reverify,
}));
vi.mock('../subscription-preflight.js', async (original) => ({
  ...(await original<typeof SubscriptionPreflight>()),
  preflightSubscription: ports.preflight,
}));
vi.mock('../harness/router.js', async (original) => ({
  ...(await original<typeof HarnessRouter>()),
  getHarnessRouter: ports.router,
}));
import { executeEmployeeRun } from './employee-run.js';

const nextAdmission = Error('original downstream admission reached');
beforeEach(() => {
  vi.clearAllMocks();
  ports.review.mockResolvedValue(undefined);
  ports.repair.mockResolvedValue(null);
  ports.repositoryReview.mockResolvedValue(null);
  ports.changeset.mockResolvedValue(null);
  ports.documents.mockRejectedValue(nextAdmission);
  ports.experiences.mockRejectedValue(nextAdmission);
});
function invocation(extra: Record<string, unknown> = {}) {
  return {
    execution: {
      payload: {
        type: 'allrice.employee.run',
        input: {
          employeeAssignmentId: randomUUID(),
          employeeVersionId: randomUUID(),
          sessionId: randomUUID(),
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
          ...extra,
        },
      },
      context: {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        runId: randomUUID(),
      },
      job: { ownerId: randomUUID() },
    },
  } as unknown as ClaimedJobHandlerInput;
}
function expectNoModelEntry() {
  for (const port of [
    ports.acquire,
    ports.modelAdmission,
    ports.preflight,
    ports.router,
  ])
    expect(port).not.toHaveBeenCalled();
}

describe('retired queued employee Workflow invocation', () => {
  it('rejects before acquiring a native conversation, including an incomplete historical invocation', async () => {
    const snapshot = {
      schemaVersion: 2,
      workflowInvocation: { startId: randomUUID() },
    };
    ports.resolve.mockResolvedValue({ executionSnapshot: snapshot });
    await expect(executeEmployeeRun(invocation())).rejects.toMatchObject({
      code: 'LEGACY_WORKFLOW_RETIRED',
      retryable: false,
    });
    expectNoModelEntry();
    expect(snapshot.workflowInvocation).toHaveProperty('startId');
  });
});

describe('queued employee model execution requires frozen PERSONA', () => {
  it.each([undefined, { schemaVersion: 1 }, { schemaVersion: 2 }])(
    'keeps historical input %j unchanged and rejects before model/runtime admission',
    async (snapshot) => {
      const resolved = {
        executionSnapshot: snapshot,
        promptSnapshot: {
          systemPrompt: 'Original composite identity and policy',
          conversation: [{ role: 'user', content: 'Original history' }],
          memories: [],
          employeeDocuments: {
            user: 'Original USER',
            memory: 'Original MEMORY',
          },
        },
      };
      const original = structuredClone(resolved);
      ports.resolve.mockResolvedValue(resolved);
      await expect(executeEmployeeRun(invocation())).rejects.toMatchObject({
        code: 'EMPLOYEE_PERSONA_REQUIRED',
        retryable: false,
      });
      expect(resolved).toEqual(original);
      expect(ports.documents).not.toHaveBeenCalled();
      expect(ports.experiences).not.toHaveBeenCalled();
      expectNoModelEntry();
    },
  );

  it.each([
    'employee_persona_snapshot_invalid',
    'employee_persona_source_unavailable',
    'CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH',
  ])('preserves the original present-source failure %s', async (message) => {
    const failure = Error(message);
    ports.resolve.mockRejectedValue(failure);
    await expect(executeEmployeeRun(invocation())).rejects.toBe(failure);
    expect(ports.review).not.toHaveBeenCalled();
    expectNoModelEntry();
  });

  it('continues original admission for a verified null-package tenant pin from public factory material', async () => {
    const input = invocation();
    const values = input.execution.payload.input as Record<string, string>;
    const manifest = EmployeeDefinitionSchema.parse(
      employeeManifest({
        key: 'worker-tenant',
        name: 'Actual tenant identity',
        description: 'Worker source fixture',
      }),
    );
    const version = {
      kind: 'tenant_version' as const,
      employeeVersionId: values.employeeVersionId,
      configChecksum: employeeManifestChecksum(manifest),
      manifestDigest: runtimePolicyDigest(manifest),
    };
    const source = EmployeePersonaPinSchema.shape.source.parse({
      kind: 'employee_run',
      employeeId: randomUUID(),
      assignmentId: values.employeeAssignmentId,
      instanceId: randomUUID(),
      organizationId: input.execution.context.organizationId,
      workspaceId: input.execution.context.workspaceId,
      ownerId: input.execution.job.ownerId,
      profileRevision: 1,
      profileEligibility: 'expression_only',
      basis: version,
      engine: version,
    });
    const persona = renderEmployeePersonaDocument(
      manifest.personaSource!.foundation,
      source,
    );
    const pin = EmployeePersonaPinSchema.parse({
      schemaVersion: 1,
      source,
      personaDigest: runtimePolicyDigest(persona),
      systemDigest: runtimePolicyDigest(manifest.systemPrompt),
    });
    expect(manifest.runtimePackage).toBeNull();
    expect(pin.source.engine).toEqual(version);
    expect(persona).toContain(manifest.name);
    // This unit starts at the verified resolver boundary. The existing p25
    // integration suite covers the real null producer/freezer and Worker chain.
    ports.resolve.mockResolvedValue({
      executionSnapshot: { schemaVersion: 2, persona: pin },
      promptSnapshot: {
        systemPrompt: manifest.systemPrompt,
        employeeDocuments: { persona, user: '', memory: '' },
      },
    });
    await expect(executeEmployeeRun(input)).rejects.toBe(nextAdmission);
    expect(ports.documents).toHaveBeenCalledOnce();
    expectNoModelEntry();
  });

  it.each(['quality', 'repair_reuse', 'changeset'] as const)(
    'keeps the original %s non-model path outside the model gate',
    async (kind) => {
      ports.resolve.mockResolvedValue({
        executionSnapshot: { schemaVersion: 2 },
        promptSnapshot: { memories: [] },
      });
      if (kind === 'quality' || kind === 'repair_reuse') {
        const result = { modelInvoked: false };
        ports.quality.mockResolvedValue(result);
        ports.reverify.mockResolvedValue(result);
        ports.repair.mockResolvedValue({ frozen: { reuseSeed: true } });
        const input = invocation({
          [kind === 'quality' ? 'qualityRequestId' : 'repairRequestId']:
            randomUUID(),
        });
        await expect(executeEmployeeRun(input)).resolves.toBe(result);
        expect(
          kind === 'quality' ? ports.quality : ports.reverify,
        ).toHaveBeenCalledOnce();
      } else {
        ports.changeset.mockResolvedValue({ id: randomUUID() });
        await expect(executeEmployeeRun(invocation())).rejects.toBe(
          nextAdmission,
        );
        expect(ports.experiences).toHaveBeenCalledOnce();
      }
      expect(ports.documents).not.toHaveBeenCalled();
      expectNoModelEntry();
    },
  );
});
