import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { executeRiceTool } from '../../src/tool-broker.js';
import { HandlerError } from '../../src/errors.js';
import { requestCodexImage } from '../../src/codex-image-broker.js';
import {
  listToolBrokerFiles,
  listImageOperations,
  claimImageOperation,
  admitModelExecution,
} from '@allrice/database';
import { withFixturePlatformAdministrator } from '../../../../scripts/acceptance/runtime/fixture-platform-authority.ts';
vi.mock('../../src/codex-image-broker.js', () => ({
  requestCodexImage: vi.fn(),
}));
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('image execution — isolated PostgreSQL and real file storage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });
  it('publishes immutable generated/edited images, rejects foreign sources, and never replays unknown or stale work', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    const f = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      imageGeneration: true,
    });
    const storageRoot = await mkdtemp(join(tmpdir(), 'met163-images-'));
    try {
      // A valid connection is usable in production without a second approval.
      vi.stubEnv('ALLRICE_ENV', 'production');
      await f.db`update allrice_provider_release_controls set release_stage='experimental',production_approved=false,allowlisted_organization_ids='{}'`;
      await f.db`update allrice_platform_model_settings set configuration=jsonb_set(configuration,'{imageModel}','"auto"'::jsonb)`;
      const admission = {
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        userId: f.ownerId,
        employeeId: f.employeeId,
        connectionId: f.connectionId,
        requestedTokens: 1,
        requestedRuntimeMs: 1000,
      };
      await expect(admitModelExecution(admission)).resolves.toBeDefined();
      await f.db`update allrice_provider_release_controls set release_stage='disabled' where connection_id=${f.connectionId}`;
      await expect(admitModelExecution(admission)).rejects.toMatchObject({
        code: 'PROVIDER_NOT_RELEASED',
      });
      await f.db`update allrice_provider_release_controls set release_stage='experimental' where connection_id=${f.connectionId}`;
      const task = await f.prepareOrdinaryTask(
        'Generate an image, then edit its color (synthetic provider).',
      );
      await f.db`update allrice_jobs set lease_expires_at=now()+interval '5 minutes' where id=${task.execution.context.jobId}`;
      const common = {
        context: task.execution.context,
        sessionId: task.sessionId,
        capabilities:
          task.binding.executionSnapshot.capabilitySnapshot.grantedCapabilities,
        storageRoot,
        managedBrowserJobLeaseToken: task.workflowLease.leaseToken,
      };
      const generate = {
        id: 'generate-1',
        name: 'image.generate',
        arguments: { prompt: 'a blue circle', fileName: 'circle.png' },
      };
      vi.mocked(requestCodexImage).mockImplementation(
        async ({ configuration }) => ({
          imageBase64: png,
          requestId: 'synthetic',
          workModel: 'gpt-5.6-luna',
          imageModel: configuration.imageModel as
            'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst',
          usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null },
        }),
      );
      // A later settings change must not rewrite the active run's auto policy.
      await f.db`update allrice_platform_model_settings set configuration=jsonb_set(configuration,'{imageModel}','"gpt-image-2.5-flare"'::jsonb)`;
      const result = await executeRiceTool({ ...common, call: generate });
      const generated = JSON.parse(result.modelContent);
      expect(generated).toMatchObject({
        mediaType: 'image/png',
        version: 1,
        width: 1,
        height: 1,
      });
      expect(result.modelContent).not.toContain(png);
      const repeated = await executeRiceTool({
        ...common,
        call: {
          ...generate,
          id: 'generate-repeated',
          arguments: { ...generate.arguments, fileName: 'different-name.png' },
        },
      });
      expect(repeated).toEqual(result);
      expect(requestCodexImage).toHaveBeenCalledTimes(1);
      const files = await listToolBrokerFiles(common.context, 50);
      expect(files.find((f) => f.id === generated.objectId)?.checksum).toBe(
        generated.checksum,
      );
      const source = {
        objectId: generated.objectId,
        checksum: generated.checksum,
      };
      const edit = {
        id: 'edit-1',
        name: 'image.edit',
        arguments: {
          prompt: 'change to orange',
          fileName: 'orange.png',
          source,
        },
      };
      await expect(
        executeRiceTool({
          ...common,
          context: { ...common.context, organizationId: randomUUID() },
          call: edit,
        }),
      ).rejects.toThrow();
      expect(requestCodexImage).toHaveBeenCalledTimes(1);
      const edited = JSON.parse(
        (await executeRiceTool({ ...common, call: edit })).modelContent,
      );
      expect(edited).toMatchObject({ version: 2, source });
      expect(requestCodexImage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            data: png,
            mediaType: 'image/png',
          }),
        }),
      );
      const [original] =
        await f.db`select state from allrice_storage_objects where id=${generated.objectId}`;
      expect(original?.state).toBe('ready');
      vi.mocked(requestCodexImage).mockRejectedValueOnce(
        new HandlerError('IMAGE_RESULT_UNKNOWN', 'No complete receipt', false),
      );
      const lost = {
        id: 'lost-1',
        name: 'image.generate',
        arguments: { prompt: 'different image', fileName: 'lost.png' },
      };
      await expect(
        executeRiceTool({ ...common, call: lost }),
      ).rejects.toMatchObject({ code: 'IMAGE_RESULT_UNKNOWN' });
      await expect(
        executeRiceTool({ ...common, call: { ...lost, id: 'lost-again' } }),
      ).rejects.toMatchObject({ code: 'IMAGE_RESULT_UNKNOWN' });
      expect(requestCodexImage).toHaveBeenCalledTimes(3);
      await expect(
        executeRiceTool({
          ...common,
          managedBrowserJobLeaseToken: randomUUID(),
          call: {
            ...generate,
            id: 'stale',
            arguments: { ...generate.arguments, prompt: 'new request' },
          },
        }),
      ).rejects.toThrow();
      expect(requestCodexImage).toHaveBeenCalledTimes(3);
      const receipts =
        await f.db`select status,usage,image_model from allrice_image_operations order by created_at`;
      expect(receipts.map((r) => r.status)).toEqual([
        'succeeded',
        'succeeded',
        'unknown',
      ]);
      expect(receipts.slice(0, 2).map((r) => r.image_model)).toEqual([
        'gpt-image-2.5-flare',
        'gpt-image-2.5-sunburst',
      ]);
      expect(receipts[0]?.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
      });
      await expect(listImageOperations(f.context)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await claimImageOperation({
        context: common.context,
        sessionId: task.sessionId,
        callId: 'orphan',
        arguments: { prompt: 'interrupted image', fileName: 'orphan.png' },
        leaseToken: task.workflowLease.leaseToken,
      });
      await f.db`update allrice_jobs set cancel_requested_at=now() where id=${common.context.jobId}`;
      await withFixturePlatformAdministrator(f.ownerId, async () => {
        const rows = await listImageOperations(f.context);
        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ status: 'unknown', usage: null });
        expect(rows[0]).not.toHaveProperty('prompt');
      });
    } finally {
      await f.close();
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
