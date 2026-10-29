import { readDshToolResult } from '@allrice/contracts';
/* global Buffer, process */
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DshProtocolClient } from '../src/harness/dsh-protocol-client.ts';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../src/harness/dsh-distribution.ts';

const overload =
  'Our servers are currently overloaded. Please try again later.';
const generic =
  'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.';
const skillContent = '# Synthetic method\nFROZEN_NATIVE_SKILL_BODY_42';
const privatePin = {
  organizationId: 'f6ea2d79-f2d0-44ab-889f-223052f81e54',
  ownerId: '9d55a797-b76f-444e-b2b8-ec877d846229',
  instanceId: '85823d50-6d5c-460f-9427-0c551bb3445d',
  installationId: 'a86d89da-9027-4b6e-bc21-b4be31624549',
  versionId: 'c71f464e-bd67-4dd7-bc64-09cd2f78ea47',
  bindingId: 'a85a1726-036c-4070-840e-dad1b09287db',
  bindingEpoch: 1,
  definitionChecksum: `sha256:${'b'.repeat(64)}`,
};
const sceneId = '189c8b5b-72cb-4f41-89c2-f3034c5ec0e4';
const sceneName = `allrice-scene-${sceneId}`;
const sceneDigest = `sha256:${'a'.repeat(64)}`;
const sceneReceipt = {
  sceneId,
  sceneDigest,
  receiptId: '62f49e1d-9f1a-4bb0-9c26-decb3d732180',
};
// Generated test grant; never read ambient credentials or call a remote model.
const syntheticToken = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-loopback',
      },
    }),
  ).toString('base64url'),
  'synthetic-signature',
].join('.');

/** Production AllRice JSON-RPC host + pinned DSH loop/retry + pi-ai, over real
 * loopback SSE. Only the provider responses and platform ACKs are synthetic. */
async function scenario({
  failures = [overload],
  toolFirst = false,
  skillFirst = false,
  personalSkill = false,
  personalInstall = false,
  personalInstallArguments,
  rejectPersonalSkill = false,
  personalSlash = false,
  sceneFirst = false,
  sceneProbe = false,
  rejectSceneAdoption = false,
  recoverScene = false,
  rebind = false,
  settle = true,
  cancel = false,
  contentCallsAllowed,
  compact = false,
  progressPause = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-model-recovery-'));
  const requests = [],
    notices = [],
    bridgeCalls = [],
    toolCalls = [];
  const connections = [];
  let serverError;
  let adoptionAttempts = 0;
  let contentCalls = 0,
    compactionRejected = false,
    progressChecks = 0,
    progressContinued = false;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const decoded =
        req.headers['content-encoding'] === 'zstd'
          ? zstdDecompressSync(raw)
          : raw;
      requests.push(JSON.parse(decoded.toString()));
      expect(req.headers.authorization).toBe(`Bearer ${syntheticToken}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const index = requests.length - 1;
      connections.push(`open:${index}`);
      res.on('close', () => connections.push(`close:${index}`));
      const firstTool =
        toolFirst || skillFirst || sceneFirst || personalInstall;
      if (
        !(firstTool && index === 0) &&
        failures[index - (firstTool ? 1 : 0)]
      ) {
        // This structured wire code is synthetic, not recovered from the
        // historical incidents. pi-ai loses it before the AllRice seam.
        send({
          type: 'error',
          code: 'server_error',
          message: failures[index - (firstTool ? 1 : 0)],
        });
        res.end();
        return;
      }
      const item =
        (firstTool && index === 0) || (skillFirst && rebind && index === 2)
          ? {
              type: 'function_call',
              id: `fc_synthetic_${index}`,
              call_id: `call_synthetic_${index}`,
              name: personalInstall
                ? 'workspace_personal_skill_install'
                : skillFirst || sceneFirst
                  ? 'skill'
                  : 'local_fs_list',
              arguments: JSON.stringify(
                personalInstall
                  ? (personalInstallArguments ?? {
                      objectId: privatePin.versionId,
                    })
                  : sceneFirst
                    ? { name: sceneName }
                    : skillFirst
                      ? { name: 'synthetic-method' }
                      : { path: '.' },
              ),
              status: 'completed',
            }
          : {
              type: 'message',
              id: 'msg_synthetic',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'Recovered using the saved result.',
                  annotations: [],
                },
              ],
            };
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          ...item,
          ...(item.type === 'message' ? { content: [] } : { arguments: '' }),
        },
      });
      if (item.type === 'message')
        send({
          type: 'response.output_text.delta',
          output_index: 0,
          delta: 'Recovered using the saved result.',
        });
      else
        send({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: item.arguments,
        });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({
        type: 'response.completed',
        response: {
          id: `resp_${index}`,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 7,
            total_tokens: 27,
          },
        },
      });
      res.end();
    })().catch((error) => {
      serverError = error;
      res.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  let client;
  try {
    await symlink(
      resolve(import.meta.dirname, '../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const source = await readFile(
      resolve(import.meta.dirname, 'allrice-restricted.cordis.yml'),
      'utf8',
    );
    await writeFile(
      join(root, 'profile.yml'),
      source.replace(
        '      openai-codex:\n',
        `      openai-codex:\n        baseURL: ${baseURL}\n        transport: sse\n`,
      ),
    );
    await writeFile(
      join(root, 'credentials.yaml'),
      JSON.stringify({
        version: 1,
        records: {
          'llm-pi-ai/openai-codex': {
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: syntheticToken,
              refresh: 'never-used',
              expires: Date.now() + 3600000,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    async function launch() {
      client = new DshProtocolClient({
        command: process.execPath,
        args: [resolve(import.meta.dirname, 'allrice-jsonrpc-runtime.mjs')],
        cwd: root,
        requestTimeoutMs: 15000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ALLRICE_PROGRESS_GUARD_ENABLED: '1',
          DSH_CORDIS_CONFIG: join(root, 'profile.yml'),
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(root, 'sessions'),
          DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
          DSH_HOME: root,
          DSH_CWD: root,
          DSH_CODEX_MODEL: 'gpt-5.6-luna',
          DSH_SYSTEM_PROMPT:
            'Synthetic recovery fixture. Use only supplied test tools.',
        },
      });
      client.subscribe((notice) => notices.push(notice));
      client.setRequestHandler(async (method, p) => {
        bridgeCalls.push({ method, ...p });
        if (method === 'allrice/progress') {
          if (p.action === 'finish' && p.kind === 'model' && !settle)
            throw Error('synthetic_model_receipt_rejected');
          if (p.action === 'check') progressChecks++;
          if (p.action === 'decide') progressContinued = true;
          return {
            paused: progressPause && progressChecks >= 1 && !progressContinued,
            pauseId: 'synthetic-pause',
            reason: 'repeated_failure',
            recent: [],
          };
        }
        if (method === 'allrice/content-scene-load') {
          expect(p).toEqual({ sceneId, sceneDigest });
          return { receipt: sceneReceipt, content: 'SCENE_WEEKLY_ONLY_85' };
        }
        if (method === 'allrice/content-scene-adopt') {
          expect(p).toMatchObject(sceneReceipt);
          expect(requests).toHaveLength(1);
          adoptionAttempts++;
          if ((recoverScene && adoptionAttempts === 1) || rejectSceneAdoption)
            throw Error('employee_scene_adoption_denied');
          return { adopted: p };
        }
        if (method === 'allrice/personal-skill-check') {
          expect(p).toEqual(privatePin);
          if (rejectPersonalSkill) throw Error('personal_skill_revoked');
          return { allowed: true };
        }
        if (method === 'allrice/content-check') {
          contentCalls += 1;
          if (contentCalls > contentCallsAllowed)
            throw Error('employee_content_revoked');
          return { allowed: true };
        }
        if (method === 'allrice/tool-call') {
          toolCalls.push(p);
          return { modelContent: 'SAVED_TOOL_RESULT_42' };
        }
        throw Error(`unexpected_fixture_bridge:${method}`);
      });
      await client.initialize({
        cwd: root,
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        maxTokens: 64,
        nativeTools: personalInstall
          ? ['workspace.personal_skill.install']
          : ['local.fs.list'],
        nativeSkills:
          skillFirst || personalSkill
            ? [
                {
                  id: personalSkill
                    ? privatePin.versionId
                    : 'synthetic-method-id',
                  ...(personalSkill
                    ? {
                        personal: privatePin,
                        whenToUse: 'Checking deliverables',
                        metadata: { test: true },
                      }
                    : {}),
                  name: 'synthetic-method',
                  description:
                    'Frozen synthetic method for the native loader regression.',
                  content: skillContent,
                  checksum: `sha256:${createHash('sha256').update(skillContent).digest('hex')}`,
                  invocation: { modelInvocable: true, userInvocable: true },
                  requiredToolRefs: personalSkill ? [] : ['local.fs.list'],
                },
              ]
            : [],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        contentScenes:
          sceneFirst || sceneProbe
            ? [
                {
                  id: sceneId,
                  nativeName: sceneName,
                  digest: sceneDigest,
                  name: '周报',
                  appliesWhen: '每周经营复盘',
                },
              ]
            : [],
        requireContentGuard:
          contentCallsAllowed !== undefined ||
          sceneFirst ||
          sceneProbe ||
          personalSkill,
        requireTaskProgress: true,
      });
    }
    await launch();
    const sessionId = `synthetic-recovery-${randomUUID()}`;
    const events = () =>
      notices
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event);
    await client.prompt(
      sessionId,
      personalSlash
        ? '/synthetic-method Synthetic request'
        : sceneProbe
          ? `/${sceneName} Synthetic request`
          : 'Synthetic request: list once then answer.',
    );
    if (progressPause) {
      await expect
        .poll(() => notices.some((n) => n.method === 'session.user-question'), {
          timeout: 12000,
        })
        .toBe(true);
      expect(requests).toHaveLength(0);
      contentCallsAllowed = 0; // A typed answer while waiting for the user.
      const question = notices.find(
        (n) => n.method === 'session.user-question',
      );
      const turn = events().findLast((e) => e.type === 'turn/start');
      // Only a typed answer answers a question (MET-210).
      await client.steer(
        sessionId,
        `allrice:user-question:v1:${JSON.stringify({
          questionId: question.params.questionId,
          answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
        })}`,
        {
          inputId: randomUUID(),
          turnId: `${sessionId}:turn:${turn.data.turn}`,
          kind: 'ask_user',
        },
      );
    }
    if (cancel) {
      await expect
        .poll(() => events().some((e) => e.type === 'llm/retry'), {
          timeout: 12000,
          interval: 10,
        })
        .toBe(true);
      await client.interrupt(sessionId);
    }
    await expect
      .poll(() => events().some((e) => e.type === 'turn/end'), {
        timeout: 15000,
      })
      .toBe(true);
    if (recoverScene) {
      expect(requests).toHaveLength(1);
      await client.close();
      await launch();
      await client.prompt(
        sessionId,
        'Continue the same task using the loaded scene.',
      );
      await expect
        .poll(() => events().filter((e) => e.type === 'turn/end').length, {
          timeout: 15000,
        })
        .toBe(2);
    }
    if (rebind) {
      await client.closeSession(sessionId);
      await client.prompt(sessionId, 'Load the same frozen method once again.');
      await expect
        .poll(() => events().filter((e) => e.type === 'turn/end').length, {
          timeout: 15000,
        })
        .toBe(2);
    }
    if (compact) {
      try {
        await client.compact(sessionId);
      } catch {
        compactionRejected = true;
      }
    }
    if (serverError) throw serverError;
    return {
      requests,
      events: events(),
      bridgeCalls,
      toolCalls,
      contentCalls,
      compactionRejected,
      connections,
      notices,
    };
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}

describe('content authorization uses actual DSH dispatch and compaction', () => {
  it(`rechecks content after a native progress pause and before dispatch accounting`, async () => {
    const result = await scenario({
      contentCallsAllowed: 10,
      failures: [],
      progressPause: true,
    });
    expect(result.requests).toHaveLength(0);
    expect(result.contentCalls).toBeGreaterThan(0);
    expect(
      result.bridgeCalls.some(
        (c) =>
          c.method === 'allrice/progress' &&
          c.action === 'start' &&
          c.kind === 'model',
      ),
    ).toBe(false);
    expect(
      result.bridgeCalls.some(
        (c) =>
          c.method === 'allrice/progress' &&
          c.action === 'finish' &&
          c.kind === 'model',
      ),
    ).toBe(false);
  });
  it(`blocks the provider before the first request`, async () => {
    const result = await scenario({
      contentCallsAllowed: 0,
      failures: [],
    });
    expect(result.requests).toHaveLength(0);
    expect(result.contentCalls).toBeGreaterThan(0);
    expect(
      result.bridgeCalls.some(
        (c) =>
          c.method === 'allrice/progress' &&
          c.action === 'start' &&
          c.kind === 'model',
      ),
    ).toBe(false);
    expect(
      result.bridgeCalls.some(
        (c) =>
          c.method === 'allrice/progress' &&
          c.action === 'finish' &&
          c.kind === 'model',
      ),
    ).toBe(false);
    expect(result.events.some((e) => e.type === 'turn/end')).toBe(true);
  });
  it(`rechecks before native compaction`, async () => {
    const result = await scenario({
      contentCallsAllowed: 1,
      failures: [],
      compact: true,
    });
    expect(result.requests).toHaveLength(1);
    expect(result.contentCalls).toBeGreaterThan(1);
    expect(result.compactionRejected).toBe(true);
  });
  it('does not resend to the provider after revocation during a native retry', async () => {
    const result = await scenario({
      contentCallsAllowed: 1,
      failures: [overload],
    });
    expect(result.requests).toHaveLength(1);
    expect(result.contentCalls).toBeGreaterThan(1);
  });
  it('keeps a completed tool while preventing the next model request', async () => {
    const result = await scenario({
      toolFirst: true,
      failures: [],
      contentCallsAllowed: 1,
    });
    expect(result.requests).toHaveLength(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.contentCalls).toBeGreaterThan(1);
  });
});

describe('ordinary Run uses the actual native Skill loader', () => {
  it('exposes and loads the frozen method before creation and after Session close/reopen', async () => {
    const result = await scenario({
      skillFirst: true,
      rebind: true,
      failures: [],
    });
    expect(result.requests).toHaveLength(4);
    for (const index of [0, 2]) {
      const tools = result.requests[index].tools.map((tool) => tool.name);
      expect(tools).toContain('skill');
      expect(tools).not.toContain('local_process_execute');
      expect(JSON.stringify(result.requests[index])).toContain(
        'synthetic-method',
      );
      expect(JSON.stringify(result.requests[index + 1])).toContain(
        'FROZEN_NATIVE_SKILL_BODY_42',
      );
    }
    expect(JSON.stringify(result.requests[0])).not.toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
    const loaded = result.events.filter((e) => e.type === 'tool/result');
    expect(loaded).toHaveLength(2);
    for (const event of loaded) {
      expect(readDshToolResult(event.data.message).isError).toBe(false);
      expect(JSON.stringify(event.data)).toContain(
        'FROZEN_NATIVE_SKILL_BODY_42',
      );
    }
    expect(result.toolCalls).toHaveLength(0);
  }, 30000);

  it('keeps an empty native catalog out of the ordinary root scope', async () => {
    const result = await scenario({ failures: [] });
    expect(result.requests[0].tools.map((tool) => tool.name)).not.toContain(
      'skill',
    );
  }, 30000);
});

describe('AllRice overload recovery through the actual native loop', () => {
  it('retries a model step, retains its prior tool result and never repeats that tool', async () => {
    const result = await scenario({ toolFirst: true });
    expect(result.requests).toHaveLength(3);
    expect(
      result.toolCalls,
      JSON.stringify({
        events: result.events.filter((e) => e.type === 'tool/result'),
        bridge: result.bridgeCalls.map((p) => p.method),
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(result.requests[2])).toContain(
      'SAVED_TOOL_RESULT_42',
    );
    expect(result.events.filter((e) => e.type === 'turn/start')).toHaveLength(
      1,
    );
    expect(result.events.filter((e) => e.type === 'llm/retry')).toHaveLength(1);
    expect(
      result.events.find((e) => e.type === 'llm/retry').data,
    ).toMatchObject({
      retry: 1,
      maxRetries: 2,
      failure: { code: 'SERVER', message: `Codex error: ${overload}` },
    });
    expect(
      result.events.find((e) => e.type === 'turn/end').data.reason.kind,
    ).toBe('completed');
    const settled = result.bridgeCalls.filter(
      (p) =>
        p.method === 'allrice/progress' &&
        p.action === 'finish' &&
        p.kind === 'model',
    );
    expect(settled).toHaveLength(3);
    expect(new Set(settled.map((p) => p.callId)).size).toBe(3);
    expect(settled[1]).not.toHaveProperty('inputTokens');
    expect(settled[1]).not.toHaveProperty('outputTokens');
  }, 30000);

  it('stops after the existing two native retries, without re-enqueuing a turn', async () => {
    const result = await scenario({ failures: [overload, overload, overload] });
    expect(result.requests).toHaveLength(3);
    expect(result.events.filter((e) => e.type === 'llm/retry')).toHaveLength(2);
    expect(result.events.filter((e) => e.type === 'turn/start')).toHaveLength(
      1,
    );
    expect(result.events.find((e) => e.type === 'turn/end').data).toMatchObject(
      { reason: { kind: 'error' } },
    );
  }, 30000);

  it('leaves the historical generic processing error unclassified instead of retrying blindly', async () => {
    const result = await scenario({ failures: [generic] });
    expect(result.requests).toHaveLength(1);
    expect(result.events.filter((e) => e.type === 'llm/retry')).toHaveLength(0);
    expect(JSON.stringify(result.events)).toContain('PI_AI_ERROR');
  }, 30000);

  it('does not dispatch again without an accounting acknowledgement', async () => {
    const result = await scenario({ settle: false });
    expect(result.requests).toHaveLength(1);
    expect(
      result.events.find((e) => e.type === 'turn/end').data.reason.kind,
    ).toBe('error');
    expect(
      result.bridgeCalls.filter(
        (p) =>
          p.method === 'allrice/progress' &&
          p.action === 'start' &&
          p.kind === 'model',
      ),
    ).toHaveLength(1);
  }, 30000);

  it('cancels the native backoff without another model dispatch', async () => {
    const result = await scenario({ cancel: true });
    expect(result.requests).toHaveLength(1);
    expect(
      result.events.find((e) => e.type === 'turn/end').data.reason.kind,
    ).toBe('aborted');
  }, 30000);
});

describe('progressive native work scenes', () => {
  it('loads through the real native provider and commits adoption before dispatch', async () => {
    const r = await scenario({ failures: [], sceneFirst: true });
    expect(r.requests).toHaveLength(2);
    expect(JSON.stringify(r.requests[0])).toContain(sceneName);
    expect(JSON.stringify(r.requests[0])).not.toContain('SCENE_WEEKLY_ONLY_85');
    expect(JSON.stringify(r.requests[1])).toContain('SCENE_WEEKLY_ONLY_85');
    const calls = r.bridgeCalls.map((c) => c.method);
    expect(
      calls.filter((c) => c === 'allrice/content-scene-load'),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c === 'allrice/content-scene-adopt'),
    ).toHaveLength(1);
    expect(calls.indexOf('allrice/content-scene-adopt')).toBeLessThan(
      calls.lastIndexOf('allrice/content-check'),
    );
  }, 45000);
  it('slash get is a conservative read, not a successful native adoption', async () => {
    const r = await scenario({ failures: [], sceneProbe: true });
    expect(
      r.bridgeCalls.some((c) => c.method === 'allrice/content-scene-load'),
    ).toBe(true);
    expect(
      r.bridgeCalls.some((c) => c.method === 'allrice/content-scene-adopt'),
    ).toBe(false);
    expect(JSON.stringify(r.requests)).not.toContain('SCENE_WEEKLY_ONLY_85');
  }, 45000);
  it('a rejected adoption prevents the next provider dispatch and native compaction', async () => {
    const r = await scenario({
      failures: [],
      sceneFirst: true,
      rejectSceneAdoption: true,
      compact: true,
    });
    expect(r.requests).toHaveLength(1);
    expect(
      r.bridgeCalls.some((c) => c.method === 'allrice/content-scene-adopt'),
    ).toBe(true);
    expect(r.compactionRejected).toBe(true);
  }, 45000);
});

it('cold native recovery reconciles the saved successful scene result before the next request', async () => {
  const r = await scenario({
    failures: [],
    sceneFirst: true,
    recoverScene: true,
  });
  expect(r.requests).toHaveLength(2);
  expect(
    r.bridgeCalls.filter((c) => c.method === 'allrice/content-scene-adopt'),
  ).toHaveLength(2);
  expect(JSON.stringify(r.requests[1])).toContain('SCENE_WEEKLY_ONLY_85');
}, 45000);

describe('personal Skills use the native loader with current authority', () => {
  it.each([
    { url: 'https://github.com/acme/skills/tree/main/weekly' },
    { importId: privatePin.installationId, candidatePath: 'weekly/SKILL.md' },
    { importId: privatePin.installationId, operation: 'cancel' },
  ])(
    'round-trips source, selection and cancellation through actual native schema: %j',
    async (args) => {
      const result = await scenario({
        personalInstall: true,
        personalInstallArguments: args,
        failures: [],
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        name: 'workspace.personal_skill.install',
        arguments: args,
      });
      expect(JSON.stringify(result.requests[1])).toContain(
        'SAVED_TOOL_RESULT_42',
      );
    },
    30000,
  );
  it('round-trips actual install tool parameters through the native Broker wire', async () => {
    const result = await scenario({ personalInstall: true, failures: [] });
    expect(result.requests[0].tools.map((t) => t.name)).toContain(
      'workspace_personal_skill_install',
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'workspace.personal_skill.install',
      arguments: { objectId: privatePin.versionId },
    });
    expect(JSON.stringify(result.requests[1])).toContain(
      'SAVED_TOOL_RESULT_42',
    );
  }, 30000);
  it('checks exact private pin before native Skill content and after rebind', async () => {
    const result = await scenario({
      personalSkill: true,
      skillFirst: true,
      rebind: true,
      failures: [],
    });
    expect(
      result.bridgeCalls.filter(
        (c) => c.method === 'allrice/personal-skill-check',
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(result.requests[0])).not.toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
    expect(JSON.stringify(result.requests[1])).toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
    expect(result.requests[0].tools.map((t) => t.name)).not.toContain(
      'workspace_personal_skill_read',
    );
  }, 30000);
  it('denies native get without exposing the revoked body', async () => {
    const result = await scenario({
      personalSkill: true,
      skillFirst: true,
      rejectPersonalSkill: true,
      failures: [],
    });
    expect(
      result.bridgeCalls.some(
        (c) => c.method === 'allrice/personal-skill-check',
      ),
    ).toBe(true);
    expect(JSON.stringify(result.requests)).not.toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
  }, 30000);
  it('checks slash invocation through the same provider before sending the body', async () => {
    const result = await scenario({
      personalSkill: true,
      personalSlash: true,
      failures: [],
    });
    expect(
      result.bridgeCalls.some(
        (c) => c.method === 'allrice/personal-skill-check',
      ),
    ).toBe(true);
    expect(JSON.stringify(result.requests[0])).toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
  }, 30000);
  it('blocks a revoked loaded context before another model call or compaction', async () => {
    const result = await scenario({
      personalSkill: true,
      skillFirst: true,
      contentCallsAllowed: 1,
      failures: [],
      compact: true,
    });
    expect(result.requests).toHaveLength(1);
    expect(result.compactionRejected).toBe(true);
    expect(JSON.stringify(result.requests)).not.toContain(
      'FROZEN_NATIVE_SKILL_BODY_42',
    );
  }, 30000);
});
