/** Real native DSH Host, durable session files and a synthetic HTTP model:
 * an idle-closed conversation resumes its own history on a fresh Host. */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import type { DshNotification } from '../../src/harness/dsh-protocol-client.js';
import {
  DshRuntimePool,
  type DshRuntime,
} from '../../src/harness/dsh/runtime-pool.js';
import { p24Fixture } from '../p24/fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function turn(runtime: DshRuntime, threadId: string, text: string) {
  const notices: DshNotification[] = [];
  const unsubscribe = runtime.client.subscribe((notice) => {
    notices.push(notice);
  });
  try {
    await runtime.client.prompt(threadId, text);
    await expect
      .poll(
        () =>
          notices.some(
            (notice) =>
              notice.method === 'session.event' &&
              (notice.params.event as { type?: string } | undefined)?.type ===
                'turn/end',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  } finally {
    unsubscribe();
  }
}

it('an idle-closed conversation resumes its own native history on a fresh Host', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const model = await p24Fixture(async (_request, index) => ({
    text: index === 1 ? 'Noted: BLUE-WHALE.' : 'The codename is BLUE-WHALE.',
  }));
  cleanups.push(() => model.close());
  vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
  const runtimes = new DshRuntimePool({
    runtimeRoot: join(model.root, 'runtime'),
    runtimeCommand: process.execPath,
    runtimeArgs: [
      resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
    ],
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
    requestTimeoutMs: 15_000,
    idleCloseMs: 200,
  });
  cleanups.push(() => runtimes.close());
  const sessionId = randomUUID();
  const input: HarnessExecutionInput = {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Synthetic idle-close resume; synthetic model only.',
      userRequest: 'Synthetic',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke'],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      route: 'openai-compatible',
      authMode: 'allrice_credential',
      model: 'idle-close',
      credentialReference: 'test:synthetic',
      baseUrl: model.baseUrl,
      reasoningEffort: 'low',
    },
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: randomUUID(),
      ALLRICE_WORKSPACE_ID: randomUUID(),
      ALLRICE_OWNER_ID: randomUUID(),
    },
    tools: [],
    storageObjects: [],
    workDirectory: model.root,
    signal: new AbortController().signal,
    attempt: 1,
    generation: 0,
    onEvent: async () => {},
  };
  const threadId = `dsh-${sessionId}`;
  const request = {
    input,
    snapshot: input.providerSnapshot as Parameters<
      DshRuntimePool['acquire']
    >[0]['snapshot'],
    threadId,
    systemInstructions: input.kernel.systemInstructions,
    nativeSkills: [],
  };

  const first = await runtimes.acquire(request);
  const release = runtimes.lease(threadId);
  await turn(
    first.runtime,
    threadId,
    'Remember the project codename BLUE-WHALE.',
  );
  release();
  expect(runtimes.inventory()).toHaveLength(1);
  // The sweep timer, not a direct call, closes the idle Host process.
  await expect
    .poll(() => runtimes.inventory().length, { timeout: 10_000 })
    .toBe(0);
  expect(first.runtime.client.processState?.().state).toBe('exited');

  // The adapter's cold path: fresh Host, then public recovery before prompt.
  const second = await runtimes.acquire(request);
  expect(second.fresh).toBe(true);
  expect(second.runtime.id).not.toBe(first.runtime.id);
  await expect(second.runtime.client.recover(threadId)).resolves.toMatchObject({
    recovered: true,
  });
  await turn(second.runtime, threadId, 'What is the project codename?');
  expect(model.requests).toHaveLength(2);
  const resumed = JSON.stringify(model.requests[1]!.messages);
  expect(resumed).toContain('Remember the project codename BLUE-WHALE.');
  expect(resumed).toContain('Noted: BLUE-WHALE.');
  expect(resumed).toContain('What is the project codename?');
}, 60_000);
