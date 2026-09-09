import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeLocalMcpResult,
  RuntimeLocalMcpPayload,
} from '@allrice/contracts';
import { testImage, testSocket } from '../test/toolchain.js';
import { fixturePayload, stdioFixture } from '../test/local-mcp.js';
import { LocalCommandRunner } from './local-command-runner.js';
import {
  LocalMcpRunner,
  type LocalMcpRunnerOptions,
} from './local-mcp-runner.js';
import { LocalMcpError } from './local-mcp-protocol.js';
import { writeConfig, type BridgeConfig } from './config.js';
import { saveSandboxOptIn } from './sandbox-settings.js';
import {
  localMcpEnabledForBinding,
  saveLocalMcpOptIn,
} from './local-mcp-settings.js';

const socketPath = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET;
const suite = socketPath ? describe.sequential : describe.skip;
const receipts: { attemptId: string; result: RuntimeLocalMcpResult }[] = [];
let directory: string, backend: LocalCommandRunner, runner: LocalMcpRunner;

suite('P17 actual isolated Linux VM stdio MCP', () => {
  beforeAll(async () => {
    if (socketPath !== testSocket)
      throw Error('explicit dedicated allrice-b2 VM required');
    directory = await mkdtemp(join(tmpdir(), 'allrice-p17-vm-'));
    vi.stubEnv(
      'ALLRICE_BRIDGE_CONFIG_PATH',
      join(directory, 'private/config.json'),
    );
    vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', '1');
    await mkdir(join(directory, 'private'), { mode: 0o700 });
    backend = new LocalCommandRunner({ socketPath, imageDigest: testImage });
    await backend.preflight();
    runner = new LocalMcpRunner(backend);
  });
  afterAll(async () => {
    try {
      for (const receipt of receipts)
        await runner.cleanup(receipt.attemptId, receipt.result.containerId);
    } finally {
      vi.unstubAllEnvs();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  async function execute(
    source: string,
    call = true,
    options: Partial<LocalMcpRunnerOptions> = {},
    mutate?: (value: RuntimeLocalMcpPayload) => void,
  ) {
    const attemptId = randomUUID(),
      root = join(directory, attemptId);
    await mkdir(root);
    await writeFile(join(root, 'server.mjs'), source);
    const payload = fixturePayload(source, call);
    mutate?.(payload);
    const intents: { requestId: string; digest: string }[] = [];
    const result = await runner.execute(root, payload, {
      attemptId,
      hardDeadlineAt: new Date(
        Date.now() + payload.arguments.limits.timeoutMs,
      ).toISOString(),
      maintainLease: async () => ({
        stopRequested: false,
        leaseExpiresAt: new Date(Date.now() + 5000).toISOString(),
      }),
      prepareCall: async (intent) => {
        // Actual fsync before sending: this is a private receipt fixture, not a
        // substitute assertion that the production journal also passes tests.
        const file = await open(
          join(directory, `${attemptId}.intent`),
          'wx',
          0o600,
        );
        try {
          await file.writeFile(JSON.stringify(intent));
          await file.sync();
        } finally {
          await file.close();
        }
        intents.push(intent);
      },
      ...options,
    });
    receipts.push({ attemptId, result });
    expect(await readFile(join(root, 'server.mjs'), 'utf8')).toBe(source);
    expect(result.sourceDirectoryModified).toBe(false);
    expect(result.stopConfirmed).toBe(true);
    return { result, intents, root, payload };
  }
  it('discovers through actual initialize + tools/list, without a tools/call or call intent', async () => {
    const { result, intents } = await execute(
      stdioFixture('throw Error("discovery must not call")'),
      false,
    );
    expect(result.reason).toBe('completed');
    expect(result.resultKnown).toBe(true);
    expect(result.tools?.[0]?.name).toBe('echo');
    expect(result.callAttempted).toBe(false);
    expect(intents).toEqual([]);
  }, 30000);
  it('calls once after durable intent, receives structured output and never touches the host source', async () => {
    const { result, intents, root } = await execute(
      stdioFixture(
        "calls++;fs.writeFileSync('only-in-copy.txt',String(calls));reply(q,{content:[{type:'text',text:'count:'+calls}],structuredContent:{value:'count:'+calls}})",
        "import fs from 'node:fs';let calls=0;",
      ),
    );
    expect(result.reason).toBe('completed');
    expect(result.resultKnown).toBe(true);
    expect(result.callAttempted).toBe(true);
    expect(result.toolResult?.structuredContent).toEqual({ value: 'count:1' });
    expect(intents).toHaveLength(1);
    await expect(
      readFile(join(root, 'only-in-copy.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);
  it('injects a synthetic token only into the unprivileged child private pipe, never Docker Env/argv or receipts', async () => {
    const secret = 'synthetic-mcp-"private"-token';
    const source = stdioFixture(
      "reply(q,{content:[{type:'text',text:'private credential received'}],structuredContent:{value:'private credential received'}})",
      `
      import fs from 'node:fs';
      if(process.getuid()!==1000||process.env.ALLRICE_INPUT_PARTS||process.env.SSH_AUTH_SOCK)throw Error('isolation');
      if(!process.env.ALLRICE_MCP_TOKEN)throw Error('credential missing');
      for(const p of ['/proc/1/environ','/var/run/docker.sock','/Users/a123/.ssh/id_rsa']){
        try{fs.readFileSync(p);throw Error('read escaped')}catch(e){if(!['EACCES','ENOENT'].includes(e.code))throw e;}
      }
      try{process.kill(1,'SIGSTOP');throw Error('PID1 escaped')}catch(e){if(e.code!=='EPERM')throw e;}
      if(!fs.readFileSync('/proc/self/status','utf8').includes('CapEff:\\t0000000000000000'))throw Error('caps');
    `,
    );
    const { result } = await execute(
      source,
      true,
      { resolveCredential: async () => secret },
      (value) => {
        const ref = { id: randomUUID(), revision: 1 };
        value.arguments.credential = ref;
        if (value.capability === 'local.mcp.call')
          value.arguments.tool.credentialReference = ref.id;
      },
    );
    expect(result.reason).toBe('completed');
    expect(JSON.stringify(result)).not.toContain(secret);
    const inspected = await backend.api.json<Record<string, unknown>>(
      'GET',
      `/containers/${result.containerId}/json`,
    );
    expect(JSON.stringify(inspected)).not.toContain(secret);
    const environment = (inspected.Config as { Env: string[] }).Env;
    const encoded = environment
      .filter((value) => /^ALLRICE_INPUT_\d+=/.test(value))
      .sort(
        (left, right) =>
          Number(left.match(/^ALLRICE_INPUT_(\d+)/)![1]) -
          Number(right.match(/^ALLRICE_INPUT_(\d+)/)![1]),
      )
      .map((value) => value.slice(value.indexOf('=') + 1))
      .join('');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).not.toContain(
      secret,
    );
    expect(inspected.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Binds: null,
    });
  }, 30000);
  it('does not send tools/call when durable preparation fails, while retaining started/unknown semantics', async () => {
    const { result } = await execute(
      stdioFixture('throw Error("must not be called")'),
      true,
      {
        prepareCall: async () => {
          throw new LocalMcpError('LOCAL_MCP_UNKNOWN');
        },
      },
    );
    expect(result.reason).toBe('unknown');
    expect(result.resultKnown).toBe(false);
    expect(result.callAttempted).toBe(false);
  }, 30000);
  it('checks exact input and structured result against the reviewed SDK validator', async () => {
    const denied = await execute(stdioFixture(), true, {}, (value) => {
      if (value.capability === 'local.mcp.call')
        value.arguments.toolArguments = { wrong: 'not authorized by schema' };
    });
    expect(denied.intents).toHaveLength(0);
    expect(denied.result.callAttempted).toBe(false);
    expect(denied.result.resultKnown).toBe(false);
    const malformed = await execute(
      stdioFixture('reply(q,{content:[],structuredContent:{value:99}})'),
    );
    expect(malformed.result.resultKnown).toBe(false);
    expect(malformed.result.callAttempted).toBe(true);
    expect(malformed.result.reason).toBe('protocol_error');
  }, 30000);
  it('stops before calling when the discovered schema no longer matches the frozen digest', async () => {
    const { result, intents } = await execute(
      stdioFixture(),
      true,
      {},
      (value) => {
        if (value.capability === 'local.mcp.call')
          value.arguments.tool.digest = `sha256:${'3'.repeat(64)}`;
      },
    );
    expect(result.reason).toBe('schema_changed');
    expect(result.callAttempted).toBe(false);
    expect(intents).toHaveLength(0);
  }, 30000);
  it('retains isError as an actual response without claiming effects:none', async () => {
    const { result } = await execute(
      stdioFixture(
        "reply(q,{content:[{type:'text',text:'synthetic error after write'}],isError:true})",
      ),
    );
    expect(result.reason).toBe('completed');
    expect(result.callAttempted).toBe(true);
    expect(result.toolResult?.isError).toBe(true);
    expect(result.resultKnown).toBe(true);
  }, 30000);
  it('marks a write followed by dropped response as unknown, never retransmits', async () => {
    const { result, intents } = await execute(
      stdioFixture(
        "fs.writeFileSync('synthetic-write.txt','written once');process.exit(0)",
        "import fs from 'node:fs';",
      ),
    );
    expect(result.callAttempted).toBe(true);
    expect(result.resultKnown).toBe(false);
    expect(result.reason).not.toBe('completed');
    expect(intents).toHaveLength(1);
  }, 30000);
  it('terminates a running call and its process tree when its credential is revoked', async () => {
    let revoked = false;
    const { result } = await execute(
      stdioFixture('setInterval(()=>{},1000)'),
      true,
      {
        resolveCredential: async () => {
          if (revoked) throw new LocalMcpError('LOCAL_MCP_CREDENTIAL_REVOKED');
          return 'synthetic-token';
        },
        onLifecycle: async (event) => {
          if (event.phase === 'calling') revoked = true;
        },
      },
      (value) => {
        const reference = { id: randomUUID(), revision: 1 };
        value.arguments.credential = reference;
        if (value.capability === 'local.mcp.call')
          value.arguments.tool.credentialReference = reference.id;
      },
    );
    expect(result.reason).toBe('lease_lost');
    expect(result.callAttempted).toBe(true);
    expect(result.resultKnown).toBe(false);
  }, 30000);
  it('loses the short lease on a real running call with detached descendants when the control plane disconnects', async () => {
    let disconnected = false;
    const { result } = await execute(
      stdioFixture(
        "spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)",
        "import {spawn} from 'node:child_process';",
      ),
      true,
      {
        maintainLease: async () => {
          if (disconnected) throw Error('synthetic control connection lost');
          return {
            stopRequested: false,
            leaseExpiresAt: new Date(Date.now() + 5000).toISOString(),
          };
        },
        onLifecycle: async (event) => {
          if (event.phase === 'calling') disconnected = true;
        },
      },
    );
    expect(result.callAttempted).toBe(true);
    expect(result.resultKnown).toBe(false);
    expect(result.reason).toBe('lease_lost');
    const state = await backend.api.json<{
      State: { Running: boolean; Pid: number };
    }>('GET', `/containers/${result.containerId}/json`);
    expect(state.State).toMatchObject({ Running: false, Pid: 0 });
  }, 30000);
  it('enforces an absolute timeout on silent calls and rejects raw stderr floods', async () => {
    const { result } = await execute(
      stdioFixture('setInterval(()=>{},1000)'),
      true,
      {},
      (value) => {
        value.arguments.limits.timeoutMs = 3000;
      },
    );
    expect(result.reason).toBe('timeout');
    expect(result.callAttempted).toBe(true);
    expect(result.resultKnown).toBe(false);
    const flooded = await execute(
      stdioFixture("process.stderr.write('x'.repeat(18000))"),
    );
    expect(flooded.result.reason).toBe('output_limit');
    expect(flooded.result.stderr).toBe('');
    expect(flooded.result.resultKnown).toBe(false);
  }, 30000);
  it('rejects JSON-escaped credential echoes before any result can enter the receipt', async () => {
    const secret = 'synthetic-"escaped"-token';
    const { result } = await execute(
      stdioFixture(
        "reply(q,{content:[{type:'text',text:process.env.ALLRICE_MCP_TOKEN}],structuredContent:{value:process.env.ALLRICE_MCP_TOKEN}})",
      ),
      true,
      { resolveCredential: async () => secret },
      (value) => {
        const reference = { id: randomUUID(), revision: 1 };
        value.arguments.credential = reference;
        if (value.capability === 'local.mcp.call')
          value.arguments.tool.credentialReference = reference.id;
      },
    );
    expect(result.resultKnown).toBe(false);
    expect(result.reason).toBe('protocol_error');
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 30000);
  it('normal App choice works without env, stops a live lease on disable and withdraws advertised capability', async () => {
    const config: BridgeConfig = {
      server: 'https://synthetic.example',
      deviceId: randomUUID(),
      deviceName: 'Synthetic',
      grants: [],
    };
    await writeConfig(config);
    await saveSandboxOptIn(config, true);
    await saveLocalMcpOptIn(config, true);
    vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', undefined);
    backend.config.localMcpEnabled = () => localMcpEnabledForBinding(config);
    try {
      expect((await backend.preflight()).features).toContain('local_mcp');
      const { result } = await execute(
        stdioFixture('setInterval(()=>{},1000)'),
        true,
        {
          onLifecycle: async (event) => {
            if (event.phase === 'calling')
              await saveLocalMcpOptIn(config, false);
          },
        },
        (value) => {
          value.arguments.deviceId = config.deviceId;
        },
      );
      expect(result.reason).toBe('lease_lost');
      expect(result.resultKnown).toBe(false);
      expect(result.callAttempted).toBe(true);
      expect((await backend.preflight()).features).not.toContain('local_mcp');
    } finally {
      delete backend.config.localMcpEnabled;
      vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', '1');
    }
  }, 30000);
});
