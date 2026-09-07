import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { SessionModelSnapshotSchema } from '@allrice/contracts';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import { executeEmployeeRun } from './employee-run.js';
const resolved = vi.hoisted(() => vi.fn());
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveEmployeeExecution: resolved,
  getLatestContextCheckpoint: checkpoint,
}));

type FrozenExecution = Extract<
  NonNullable<
    Awaited<
      ReturnType<typeof Database.resolveEmployeeExecution>
    >['executionSnapshot']
  >,
  { schemaVersion: 2 }
>;

describe('historical primary-model admission, not just fallback helpers', () => {
  it.each(['gemini', 'zhipu'])(
    'refuses an old %s OAuth primary before context or model execution',
    async (provider) => {
      resolved.mockResolvedValueOnce({
        executionSnapshot: {
          schemaVersion: 2,
          modelSnapshot: SessionModelSnapshotSchema.parse({
            schemaVersion: 1,
            sessionId: randomUUID(),
            employeeId: randomUUID(),
            policyRevision: 1,
            connectionId: randomUUID(),
            modelCatalogEntryId: randomUUID(),
            harness: 'dsh',
            provider,
            authMode: 'gemini_oauth',
            model: '3.8flash',
            reasoningEffort: 'medium',
            credentialReference: 'deployment:gemini-default',
            baseUrl: null,
            fallbackPolicy: 'disabled',
            fallbackTargets: [],
            frozenAt: new Date().toISOString(),
          }),
        } satisfies Pick<FrozenExecution, 'schemaVersion' | 'modelSnapshot'>,
      });
      const input = {
        execution: {
          payload: {
            type: 'allrice.employee.run',
            input: {
              employeeAssignmentId: randomUUID(),
              employeeVersionId: randomUUID(),
              sessionId: randomUUID(),
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
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
      await expect(executeEmployeeRun(input)).rejects.toMatchObject({
        code: 'PROVIDER_AUTH_UNSUPPORTED',
      });
      expect(checkpoint).not.toHaveBeenCalled();
    },
  );
});
