import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { DshExecutionSnapshot } from '@allrice/contracts';

import { HandlerError } from '../../errors.js';
import type {
  HarnessExecutionInput,
  HarnessRuntimeProcessSnapshot,
} from '../adapter.js';
import {
  DeploymentDshCredentialResolver,
  type DshCredentialResolver,
} from '../dsh-credential-resolver.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../dsh-distribution.js';
import { dshEgressEnvironment } from '../dsh-egress-environment.js';
import { DshProtocolClient } from '../dsh-protocol-client.js';
import { isDshNativeTool } from './tool-bridge.js';

export interface DshRuntime {
  client: DshProtocolClient;
  id: string;
  fingerprint: string;
  sessionId: string;
  organizationId: string;
  workspaceId: string;
  productSessionId: string;
  ownerId: string;
  providerRoute: string;
  model: string;
  reasoningEffort: string;
  nativeTools: string[];
  startedAt: string;
  lastActivityAt: string;
}

export interface DshRuntimePoolOptions {
  credentialResolver?: DshCredentialResolver;
  runtimeCommand?: string;
  runtimeArgs?: readonly string[];
  runtimeRoot?: string;
  cordisConfig?: string;
  requestTimeoutMs?: number;
}

function parseRuntimeArgs(value: string | undefined) {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string')
  ) {
    throw new HandlerError(
      'DSH_RUNTIME_CONFIG_INVALID',
      'ALLRICE_DSH_RUNTIME_ARGS must be a JSON string array',
      false,
    );
  }
  return parsed;
}

function requestTimeout(value: number | undefined) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 3_600_000
    ? value
    : 300_000;
}

function mappedReasoning(
  effort: DshExecutionSnapshot['reasoningEffort'],
): string {
  if (effort === 'none') return 'off';
  if (effort === 'medium') return 'high';
  if (effort === 'xhigh') return 'max';
  return effort;
}

export class DshRuntimePool {
  private readonly runtimes = new Map<string, DshRuntime>();
  private readonly credentialResolver: DshCredentialResolver;
  private readonly runtimeCommand: string | undefined;
  private readonly runtimeArgs: readonly string[];
  private readonly runtimeRoot: string;
  private readonly cordisConfig: string;
  private readonly requestTimeoutMs: number;

  constructor(options: DshRuntimePoolOptions = {}) {
    this.credentialResolver =
      options.credentialResolver ?? new DeploymentDshCredentialResolver();
    const configuredRuntimeCommand =
      options.runtimeCommand ?? process.env.ALLRICE_DSH_RUNTIME_COMMAND;
    this.runtimeCommand = configuredRuntimeCommand ?? process.execPath;
    this.runtimeArgs =
      options.runtimeArgs ??
      (process.env.ALLRICE_DSH_RUNTIME_ARGS
        ? parseRuntimeArgs(process.env.ALLRICE_DSH_RUNTIME_ARGS)
        : configuredRuntimeCommand
          ? []
          : [
              resolve(
                import.meta.dirname,
                '../../../dsh/allrice-jsonrpc-runtime.mjs',
              ),
            ]);
    this.runtimeRoot = resolve(
      options.runtimeRoot ??
        process.env.ALLRICE_DSH_RUNTIME_ROOT ??
        '.local/dsh-runtime',
    );
    this.cordisConfig = resolve(
      options.cordisConfig ??
        process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        resolve(
          import.meta.dirname,
          '../../../dsh/allrice-restricted.cordis.yml',
        ),
    );
    this.requestTimeoutMs = requestTimeout(
      options.requestTimeoutMs ??
        Number(process.env.ALLRICE_DSH_REQUEST_TIMEOUT_MS ?? 300_000),
    );
  }

  isConfigured(snapshot: HarnessExecutionInput['providerSnapshot']) {
    return snapshot.provider === 'dsh' && Boolean(this.runtimeCommand);
  }

  get(threadId: string) {
    return this.runtimes.get(threadId);
  }

  touch(runtime: DshRuntime) {
    runtime.lastActivityAt = new Date().toISOString();
  }

  async acquire(input: {
    input: HarnessExecutionInput;
    snapshot: DshExecutionSnapshot;
    threadId: string;
    systemInstructions: string;
    nativeSkills: NonNullable<HarnessExecutionInput['nativeSkills']>;
  }) {
    if (
      input.snapshot.route === 'gemini' &&
      process.env.ALLRICE_GEMINI_API_ENABLED !== '1'
    ) {
      throw new HandlerError(
        'GEMINI_API_DISABLED',
        'Gemini API execution is disabled; historical sessions remain readable',
        false,
      );
    }
    if (!this.runtimeCommand) {
      throw new HandlerError(
        'DSH_RUNTIME_UNAVAILABLE',
        'DSH is not configured in this deployment',
        false,
      );
    }
    const organizationId =
      input.input.executionEnvironment.ALLRICE_ORGANIZATION_ID;
    const workspaceId = input.input.executionEnvironment.ALLRICE_WORKSPACE_ID;
    const ownerId = input.input.executionEnvironment.ALLRICE_OWNER_ID;
    if (!organizationId || !workspaceId || !ownerId) {
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH execution is missing tenant isolation context',
        false,
      );
    }
    const dshPlatformHome = resolve(
      process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
    );
    const dshCredentialsPath = resolve(dshPlatformHome, '.credentials.yaml');
    const credential =
      input.snapshot.route === 'openai-codex'
        ? null
        : await this.credentialResolver.resolve({
            reference: input.snapshot.credentialReference,
            organizationId,
            workspaceId,
            ownerId,
            route: input.snapshot.route,
          });
    const codexGrantMetadata =
      input.snapshot.route === 'openai-codex'
        ? await stat(dshCredentialsPath).catch(() => null)
        : null;
    if (input.snapshot.route === 'openai-codex' && !codexGrantMetadata) {
      throw new HandlerError(
        'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
        'The platform Codex subscription must be authorized before DSH can use it',
        false,
      );
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          snapshot: input.snapshot,
          runtimePackageChecksum: input.input.kernel.runtimePackageChecksum,
          systemInstructions: input.systemInstructions,
          nativeTools: input.input.tools
            .map((tool) => tool.name)
            .filter(isDshNativeTool)
            .sort(),
          nativeSkills: input.nativeSkills.map((skill) => ({
            id: skill.id,
            checksum: skill.checksum,
            name: skill.name,
            invocation: skill.invocation,
          })),
          credentialDigest: credential
            ? createHash('sha256').update(credential.apiKey).digest('hex')
            : `codex-grant:${codexGrantMetadata?.mtimeMs ?? 0}:${codexGrantMetadata?.size ?? 0}`,
        }),
      )
      .digest('hex');
    const existing = this.runtimes.get(input.threadId);
    if (existing?.fingerprint === fingerprint) {
      return { runtime: existing, fresh: false };
    }
    if (existing) await this.drop(input.threadId);
    const tenantRoot = resolve(
      this.runtimeRoot,
      organizationId,
      workspaceId,
      ownerId,
      input.input.kernel.sessionId,
    );
    if (!tenantRoot.startsWith(`${this.runtimeRoot}${sep}`)) {
      throw new HandlerError(
        'DSH_TENANT_CONTEXT_INVALID',
        'DSH runtime path escaped its tenant root',
        false,
      );
    }
    await mkdir(tenantRoot, { recursive: true, mode: 0o700 });
    await mkdir(dshPlatformHome, { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      ...dshEgressEnvironment(),
      DSH_CORDIS_CONFIG: this.cordisConfig,
      DSH_HOME: dshPlatformHome,
      DSH_RUNTIME_HOME: tenantRoot,
      DSH_CREDENTIALS_PATH: resolve(dshPlatformHome, '.credentials.yaml'),
      DSH_CWD: tenantRoot,
      DSH_SESSION_ROOT: resolve(tenantRoot, 'sessions'),
      DSH_MODEL:
        input.snapshot.route === 'gemini' && input.snapshot.model === '3.8flash'
          ? 'gemini-3.8-flash'
          : input.snapshot.model,
      DSH_CODEX_MODEL:
        input.snapshot.route === 'openai-codex'
          ? input.snapshot.model
          : 'gpt-5.6-luna',
      DSH_GEMINI_MODEL:
        input.snapshot.route === 'gemini'
          ? input.snapshot.model === '3.8flash'
            ? 'gemini-3.8-flash'
            : input.snapshot.model
          : 'gemini-3.8-flash',
      DSH_OPENAI_COMPATIBLE_MODEL:
        input.snapshot.route === 'openai-compatible'
          ? input.snapshot.model
          : 'allrice-unused',
      DSH_REASONING_EFFORT: mappedReasoning(input.snapshot.reasoningEffort),
      DSH_SYSTEM_PROMPT: [
        input.systemInstructions,
        'All host capabilities are disabled. Use only capabilities explicitly supplied by AllRice in the current turn.',
      ].join('\n\n'),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_MAX_OUTPUT_TOKENS: String(input.input.maxOutputTokens ?? 16_000),
    };
    if (input.snapshot.route === 'openai-codex') {
      // The DSH credential service resolves and refreshes the platform OAuth
      // grant. No token is copied into the child environment.
    } else if (input.snapshot.route === 'gemini') {
      // Never inherit an ambient key or another provider's credentials. Only
      // the selected, authorized reference enters this Gemini child process.
      environment.GEMINI_API_KEY = credential!.apiKey;
    } else if (input.snapshot.route === 'deepseek-official') {
      environment.DEEPSEEK_API_KEY = credential!.apiKey;
      if (input.snapshot.baseUrl) {
        environment.DEEPSEEK_BASE_URL = input.snapshot.baseUrl;
      }
    } else {
      environment.OPENAI_COMPATIBLE_API_KEY = credential!.apiKey;
      environment.OPENAI_COMPATIBLE_BASE_URL = input.snapshot.baseUrl!;
    }
    const nativeTools = input.input.tools
      .map((tool) => tool.name)
      .filter(isDshNativeTool);
    const startedAt = new Date().toISOString();
    const runtime: DshRuntime = {
      client: new DshProtocolClient({
        command: this.runtimeCommand,
        args: this.runtimeArgs,
        cwd: tenantRoot,
        environment,
        requestTimeoutMs: this.requestTimeoutMs,
      }),
      id: randomUUID(),
      fingerprint,
      sessionId: input.threadId,
      organizationId,
      workspaceId,
      productSessionId: input.input.kernel.sessionId,
      ownerId,
      providerRoute: input.snapshot.route,
      model: input.snapshot.model,
      reasoningEffort: input.snapshot.reasoningEffort,
      nativeTools,
      startedAt,
      lastActivityAt: startedAt,
    };
    try {
      await runtime.client.initialize({
        cwd: tenantRoot,
        provider: input.snapshot.route,
        model: input.snapshot.model,
        nativeTools,
        nativeSkills: input.nativeSkills,
        maxTokens: input.input.maxOutputTokens,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      this.runtimes.set(input.threadId, runtime);
      return { runtime, fresh: true };
    } catch (error) {
      await runtime.client.close();
      throw error;
    }
  }

  async interrupt(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.interrupt(runtime.sessionId);
  }

  async compact(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.compact(runtime.sessionId);
  }

  async recover(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    await runtime.client.recover(runtime.sessionId);
  }

  async steer(threadId: string, message: string) {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw new HandlerError(
        'DSH_SESSION_NOT_LIVE',
        'DSH session is not live on this worker',
        true,
      );
    }
    await runtime.client.steer(runtime.sessionId, message);
  }

  inventory(): readonly HarnessRuntimeProcessSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.id,
      organizationId: runtime.organizationId,
      workspaceId: runtime.workspaceId,
      sessionId: runtime.productSessionId,
      ownerId: runtime.ownerId,
      threadId: runtime.sessionId,
      providerRoute: runtime.providerRoute,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
      profileFingerprint: runtime.fingerprint,
      nativeTools: [...runtime.nativeTools],
      startedAt: runtime.startedAt,
      lastActivityAt: runtime.lastActivityAt,
    }));
  }

  async drop(threadId: string) {
    const runtime = this.runtimes.get(threadId);
    this.runtimes.delete(threadId);
    await runtime?.client.close();
  }

  async close() {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }
}
