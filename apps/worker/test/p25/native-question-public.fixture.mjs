/* global process */
import { mkdtemp, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createAllRiceRuntime } from '../../dsh/allrice-jsonrpc-implementation.mjs';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.ts';

// Real production Host/profile/projection; only the LLM and the already-issued
// DB Broker preparation response are supplied by the test. No Vitest hooks or
// ambient credential files, and restore only this fixture's environment keys.
export async function withQuestionHost(
  { sessionId, callId, preview },
  consume,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'native-question-public-')),
  );
  const values = {
    DSH_CORDIS_CONFIG: resolve(
      import.meta.dirname,
      '../../dsh/allrice-restricted.cordis.yml',
    ),
    DSH_HOME: directory,
    DSH_SESSION_ROOT: join(directory, 'sessions'),
    DSH_CWD: directory,
    DSH_CREDENTIALS_PATH: join(directory, 'credentials.yml'),
    ALLRICE_ASK_USER_MODE: 'timed',
    ALLRICE_ASK_USER_TIMEOUT: undefined,
    ALLRICE_ASSISTANTS_ENABLED: undefined,
    ALLRICE_PROGRESS_GUARD_ENABLED: undefined,
    DSH_RUNTIME_HOME: undefined,
  };
  const previousEnv = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const listeners = new Map(
    ['uncaughtException', 'unhandledRejection'].map((name) => [
      name,
      process.listeners(name),
    ]),
  );
  let runtime;
  try {
    await symlink(
      resolve(import.meta.dirname, '../../node_modules'),
      join(directory, 'node_modules'),
    );
    await writeFile(values.DSH_CREDENTIALS_PATH, '{"version":1,"records":{}}', {
      mode: 0o600,
    });
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    runtime = await createAllRiceRuntime(
      {
        notify() {},
        request: async () => {
          throw Error('unexpected broker');
        },
      },
      {
        runtimeName: 'native-question-public-test',
        installedDshRuntimeVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        assertInitializationOpen() {},
        ownContext() {},
        ownServer() {},
      },
    );
    let step = 0;
    class Synthetic extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model };
      }
      async *stream() {
        const block =
          ++step === 1
            ? {
                type: 'tool-call',
                id: callId,
                name: 'ask_user_question',
                arguments: JSON.stringify({
                  ...preview.askUserQuestion,
                  timeout: -1,
                }),
              }
            : { type: 'text', text: '已确认。' };
        yield { type: 'block-start', index: 0, blockType: block.type };
        if (block.type === 'text')
          yield { type: 'text-delta', index: 0, text: block.text };
        yield { type: 'block-end', index: 0, block };
        yield {
          type: 'usage',
          usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
        };
        yield {
          type: 'finish',
          reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' },
        };
      }
    }
    runtime.ctx.llm.registerAdapter(['question-synthetic'], new Synthetic());
    await runtime.server.handleRequest('initialize', {
      cwd: directory,
      provider: 'question-synthetic',
      model: 'fixed',
      nativeTools: [],
      nativeSkills: [],
      contentScenes: [],
      requireContentGuard: false,
      requireTaskProgress: false,
    });
    const root = (await runtime.server.ensureRoot(sessionId)).agent;
    const token = runtime.server.preparedMethodQuestions.begin(root);
    runtime.server.preparedMethodQuestions.complete(root, token, {
      modelContent: JSON.stringify(preview),
    });
    await consume({
      ...runtime,
      root,
      prompt: () =>
        runtime.server.handleRequest('session/prompt', {
          sessionId,
          contentBlocks: [
            { type: 'text', text: '请确认刚才通过测试的公司工作方法。' },
          ],
        }),
      wait: () => runtime.server.handleRequest('session/wait', { sessionId }),
    });
  } finally {
    if (runtime) {
      await runtime.server.shutdown();
      await runtime.ctx.fiber.dispose();
    }
    for (const [name, previous] of listeners)
      for (const listener of process.listeners(name))
        if (!previous.includes(listener))
          process.removeListener(name, listener);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
