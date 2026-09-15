import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  CodexProviderStatus,
  ProviderAuthorizationFlow,
} from '@allrice/contracts';
import { CodexSubscriptionQuotaSnapshotSchema } from '@allrice/contracts';
import {
  claimCodexAuthorizationFlow,
  codexAuthorizationFlowState,
  completeCodexAuthorization,
  publishCodexAuthorizationChallenge,
  recordCodexProviderStatus,
} from '@allrice/database';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from './harness/dsh-distribution.js';
import { dshEgressEnvironment } from './harness/dsh-egress-environment.js';
import {
  DshProtocolClient,
  type DshNotification,
} from './harness/dsh-protocol-client.js';

function platformHome() {
  return resolve(
    process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
  );
}

function runtimeEnvironment(root: string) {
  const home = platformHome();
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...dshEgressEnvironment(),
    ...(process.env.ALLRICE_CODEX_QUOTA_COMMAND
      ? { ALLRICE_CODEX_QUOTA_COMMAND: process.env.ALLRICE_CODEX_QUOTA_COMMAND }
      : {}),
    DSH_CORDIS_CONFIG: resolve(
      process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        resolve(import.meta.dirname, '../dsh/allrice-restricted.cordis.yml'),
    ),
    DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
    DSH_HOME: home,
    DSH_CREDENTIALS_PATH: resolve(home, '.credentials.yaml'),
    DSH_SESSION_ROOT: resolve(root, 'sessions'),
    DSH_CWD: root,
    DSH_MODEL:
      process.env.ALLRICE_DSH_CODEX_MODEL ??
      process.env.ALLRICE_CODEX_MODEL ??
      'gpt-5.6-luna',
    DSH_CODEX_MODEL:
      process.env.ALLRICE_DSH_CODEX_MODEL ??
      process.env.ALLRICE_CODEX_MODEL ??
      'gpt-5.6-luna',
    DSH_OPENAI_COMPATIBLE_MODEL: 'allrice-unused',
    OPENAI_COMPATIBLE_BASE_URL: 'https://unused.invalid/v1',
    DSH_REASONING_EFFORT: 'max',
    DSH_MAX_OUTPUT_TOKENS: '256',
    DSH_SYSTEM_PROMPT: 'AllRice platform authorization broker.',
  };
}

async function createAuthorizationClient(root: string) {
  const home = platformHome();
  await Promise.all([
    mkdir(root, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../dsh/allrice-jsonrpc-runtime.mjs')],
    cwd: root,
    environment: runtimeEnvironment(root),
    requestTimeoutMs: 300_000,
  });
  await client.initialize({
    cwd: root,
    provider: 'openai-codex',
    model:
      process.env.ALLRICE_DSH_CODEX_MODEL ??
      process.env.ALLRICE_CODEX_MODEL ??
      'gpt-5.6-luna',
    maxTokens: 256,
    expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
  });
  return client;
}

export function parseDshAuthorizationChallenge(notification: DshNotification) {
  if (notification.method !== 'provider.authorization') return null;
  const url = notification.params.url;
  const code = notification.params.code;
  return typeof url === 'string' && typeof code === 'string'
    ? { verificationUri: url, userCode: code }
    : null;
}

export async function probeDshCodexProvider(
  executionRoot: string,
): Promise<CodexProviderStatus> {
  const checkedAt = new Date().toISOString();
  let client: DshProtocolClient | null = null;
  try {
    client = await createAuthorizationClient(
      resolve(executionRoot, 'provider-probe'),
    );
    const status = await client.providerStatus();
    // Optional official account-RPC adapter. Failure to read allowance is not
    // evidence of either exhausted quota or disconnected model credentials.
    const rawQuota =
      status.configured === true
        ? await client.providerQuota().catch(() => null)
        : null;
    const quota = CodexSubscriptionQuotaSnapshotSchema.safeParse(rawQuota);
    return {
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      status: status.configured === true ? 'connected' : 'disconnected',
      cliVersion: `dsh-${DSH_DISTRIBUTION_CURRENT_VERSION}`,
      detailCode:
        status.configured === true
          ? 'dsh_openai_codex_provider_ready'
          : 'dsh_openai_codex_authorization_required',
      checkedAt,
      quota: quota.success ? quota.data : null,
    };
  } catch {
    return {
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      status: 'error',
      cliVersion: `dsh-${DSH_DISTRIBUTION_CURRENT_VERSION}`,
      detailCode: 'dsh_provider_probe_failed',
      checkedAt,
    };
  } finally {
    await client?.close();
  }
}

async function runDeviceAuthorization(input: {
  workerId: string;
  flow: ProviderAuthorizationFlow;
  executionRoot: string;
  signal: AbortSignal;
}) {
  const root = resolve(input.executionRoot, 'provider-authorization');
  let client: DshProtocolClient;
  try {
    client = await createAuthorizationClient(root);
  } catch {
    await completeCodexAuthorization({
      flowId: input.flow.id,
      workerId: input.workerId,
      connected: false,
      detailCode: 'dsh_openai_codex_authorization_runtime_failed',
    });
    return;
  }
  let challengePublished = false;
  const unsubscribe = client.subscribe((notification) => {
    if (challengePublished) return;
    const challenge = parseDshAuthorizationChallenge(notification);
    if (!challenge) return;
    challengePublished = true;
    void publishCodexAuthorizationChallenge({
      flowId: input.flow.id,
      workerId: input.workerId,
      ...challenge,
    });
  });
  let cancellationRequested = false;
  const monitor = setInterval(() => {
    void (async () => {
      const state = await codexAuthorizationFlowState(input.flow.id).catch(
        () => null,
      );
      if (
        !cancellationRequested &&
        (state === 'canceled' || state === 'expired')
      ) {
        cancellationRequested = true;
        await client.cancelCodexAuthorization().catch(() => undefined);
      }
    })();
  }, 1_000);
  const abort = () => {
    cancellationRequested = true;
    void client.cancelCodexAuthorization().catch(() => undefined);
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await client.authorizeCodex();
    const connected = result.status === 'authorized';
    await completeCodexAuthorization({
      flowId: input.flow.id,
      workerId: input.workerId,
      connected,
      detailCode: connected
        ? 'dsh_openai_codex_provider_ready'
        : 'dsh_openai_codex_authorization_canceled',
    });
    await recordCodexProviderStatus(
      await probeDshCodexProvider(input.executionRoot),
    );
  } catch {
    await completeCodexAuthorization({
      flowId: input.flow.id,
      workerId: input.workerId,
      connected: false,
      detailCode: 'dsh_openai_codex_authorization_failed',
    });
  } finally {
    clearInterval(monitor);
    unsubscribe();
    input.signal.removeEventListener('abort', abort);
    await client.close();
  }
}

export class CodexAuthorizationBroker {
  private active: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly workerId: string,
    private readonly executionRoot: string,
  ) {}

  tick() {
    if (this.active) return;
    this.abortController = new AbortController();
    this.active = claimCodexAuthorizationFlow(this.workerId)
      .then((flow) =>
        flow
          ? runDeviceAuthorization({
              workerId: this.workerId,
              flow,
              executionRoot: this.executionRoot,
              signal: this.abortController!.signal,
            })
          : undefined,
      )
      .catch((error: unknown) => {
        console.error('[MET-81] DSH Codex Provider authorization failed', {
          message:
            error instanceof Error ? error.message : 'authorization_failed',
        });
      })
      .finally(() => {
        this.active = null;
        this.abortController = null;
      });
  }

  async close() {
    this.abortController?.abort();
    await this.active;
  }
}
