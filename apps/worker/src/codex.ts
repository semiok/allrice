import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

import {
  CodexProviderStatusSchema,
  type CodexExecutionSnapshot,
  SkillArtifactBundleSchema,
  type SkillArtifactBundle,
  type SkillCapability,
  type StorageObject,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { HandlerError } from './errors.js';

const maximumArtifactBytes = 2_000_000;
const maximumOutputBytes = 2_000_000;

export interface CodexRuntimeConfig {
  command: string;
  authHome?: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  storageRoot: string;
}

export function codexExecArguments(
  config: CodexRuntimeConfig,
  workDirectory: string,
  capabilities: SkillCapability[],
) {
  const disabledFeatures = [
    'shell_tool',
    'unified_exec',
    'apps',
    'auth_elicitation',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'code_mode',
    'code_mode_host',
    'computer_use',
    'image_generation',
    'in_app_browser',
    'multi_agent',
    'remote_plugin',
    'skill_mcp_dependency_install',
    'workspace_dependencies',
  ].flatMap((feature) => ['--disable', feature]);
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    ...disabledFeatures,
    ...(capabilities.includes('network:outbound')
      ? ['--enable', 'browser_use']
      : ['--disable', 'browser_use']),
    '--color',
    'never',
    '--sandbox',
    'workspace-write',
    '--cd',
    workDirectory,
    '--skip-git-repo-check',
    '--model',
    config.model,
    '--config',
    `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`,
    '-',
  ];
}

export function codexRuntimeConfig(): CodexRuntimeConfig {
  const effort = process.env.ALLRICE_CODEX_REASONING_EFFORT ?? 'high';
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error(
      'ALLRICE_CODEX_REASONING_EFFORT must be low, medium, high, or xhigh',
    );
  }
  return {
    command: process.env.ALLRICE_CODEX_COMMAND ?? 'codex',
    authHome:
      process.env.ALLRICE_CODEX_AUTH_HOME ||
      process.env.CODEX_HOME ||
      resolve(homedir(), '.codex'),
    model: process.env.ALLRICE_CODEX_MODEL ?? 'gpt-5.6-luna',
    reasoningEffort: effort as CodexRuntimeConfig['reasoningEffort'],
    storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
  };
}

function safeEnvironment(
  config: CodexRuntimeConfig,
  workDirectory: string,
  executionEnvironment: Readonly<Record<string, string>>,
) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: workDirectory,
    TMPDIR: workDirectory,
    ...(config.authHome ? { CODEX_HOME: config.authHome } : {}),
    ...executionEnvironment,
  };
}

function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: string;
  onStdoutLine?: (line: string) => void;
}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let outputBytes = 0;
    const abort = () => child.kill('SIGTERM');
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maximumOutputBytes) {
        child.kill('SIGTERM');
        return;
      }
      stdout += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) input.onStdoutLine?.(line);
    });
    child.stderr.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stderr += chunk;
      if (outputBytes > maximumOutputBytes) child.kill('SIGTERM');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      input.signal?.removeEventListener('abort', abort);
      if (pendingLine) input.onStdoutLine?.(pendingLine);
      if (input.signal?.aborted) {
        reject(
          new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false),
        );
      } else if (outputBytes > maximumOutputBytes) {
        reject(
          new HandlerError(
            'CODEX_OUTPUT_LIMIT',
            'Codex output exceeded the execution limit',
            false,
          ),
        );
      } else if (code !== 0) {
        reject(
          new HandlerError(
            'CODEX_EXEC_FAILED',
            `Codex exited unsuccessfully (${code ?? signal ?? 'unknown'})`,
            false,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(input.stdin);
  });
}

async function readArtifact(
  storageRoot: string,
  object: StorageObject,
): Promise<SkillArtifactBundle> {
  const stream = await new LocalStorageAdapter(storageRoot).get(object);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumArtifactBytes) {
        throw new HandlerError(
          'SKILL_ARTIFACT_TOO_LARGE',
          'Skill artifact exceeds the runtime limit',
          false,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks);
  const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (content.byteLength !== object.sizeBytes || checksum !== object.checksum) {
    throw new HandlerError(
      'SKILL_ARTIFACT_MISMATCH',
      'Skill artifact failed integrity validation',
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new HandlerError(
      'SKILL_ARTIFACT_INVALID',
      'Skill artifact is not valid JSON',
      false,
    );
  }
  return SkillArtifactBundleSchema.parse(parsed);
}

export async function materializeSkillBundle(
  bundle: SkillArtifactBundle,
  workDirectory: string,
) {
  const root = resolve(workDirectory, 'skill-artifact');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of bundle.files) {
    const path = resolve(root, file.path);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new HandlerError(
        'SKILL_PATH_INVALID',
        'Skill artifact path escaped the execution directory',
        false,
      );
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { encoding: 'utf8', mode: 0o600 });
  }
}

export interface NormalizedCodexEvent {
  kind: 'tool' | 'message' | 'usage';
  name?: string;
  status?: string;
  text?: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
}

export function normalizeCodexEvent(line: string): NormalizedCodexEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'turn.completed' && event.usage) {
    const usage = event.usage as Record<string, unknown>;
    return {
      kind: 'usage',
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0),
        cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
      },
    };
  }
  if (event.type !== 'item.completed' || !event.item) return null;
  const item = event.item as Record<string, unknown>;
  if (item.type === 'agent_message') {
    return { kind: 'message', text: String(item.text ?? '') };
  }
  if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
    return {
      kind: 'tool',
      name: String(item.type),
      status: String(item.status ?? 'completed'),
    };
  }
  return null;
}

export async function executeCodexSkill(input: {
  storageObject: StorageObject;
  workDirectory: string;
  executionEnvironment: Readonly<Record<string, string>>;
  prompt: string;
  providerSnapshot: CodexExecutionSnapshot;
  grantedCapabilities: SkillCapability[];
  signal: AbortSignal;
  onEvent: (event: NormalizedCodexEvent) => Promise<void>;
}) {
  const config = codexRuntimeConfig();
  config.model = input.providerSnapshot.model;
  config.reasoningEffort = input.providerSnapshot.reasoningEffort;
  const bundle = await readArtifact(config.storageRoot, input.storageObject);
  await materializeSkillBundle(bundle, input.workDirectory);
  const skillInstructions = bundle.files.find(
    (file) => file.path === bundle.entrypoint,
  )!.content;
  let answer = '';
  let usage: NormalizedCodexEvent['usage'];
  let eventChain = Promise.resolve();
  const args = codexExecArguments(
    config,
    input.workDirectory,
    input.grantedCapabilities,
  );
  await runCommand({
    command: config.command,
    args,
    cwd: input.workDirectory,
    environment: safeEnvironment(
      config,
      input.workDirectory,
      input.executionEnvironment,
    ),
    signal: input.signal,
    stdin: [
      'Follow these immutable SkillHub instructions:',
      '<skill-instructions>',
      skillInstructions,
      '</skill-instructions>',
      '',
      'Operate only inside the current working directory.',
      'Do not ask for, read, print, or persist authentication credentials.',
      'Shell and command execution are disabled in this V1 runtime.',
      input.grantedCapabilities.includes('network:outbound')
        ? 'Network use is allowed only through tools exposed by the Codex runtime.'
        : 'Do not use network tools.',
      '',
      'User request:',
      input.prompt,
    ].join('\n'),
    onStdoutLine(line) {
      const event = normalizeCodexEvent(line);
      if (!event) return;
      if (event.kind === 'message') answer = event.text ?? answer;
      if (event.kind === 'usage') usage = event.usage;
      eventChain = eventChain.then(() => input.onEvent(event));
    },
  });
  await eventChain;
  if (!answer.trim()) {
    throw new HandlerError(
      'CODEX_EMPTY_RESPONSE',
      'Codex completed without a final response',
      false,
    );
  }
  return {
    answer,
    usage: usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    provider: 'codex',
    authMode: 'chatgpt_subscription',
    model: config.model,
  };
}

export async function probeCodexProvider(workDirectory: string) {
  const config = codexRuntimeConfig();
  const checkedAt = new Date().toISOString();
  try {
    const version = await runCommand({
      command: config.command,
      args: ['--version'],
      cwd: workDirectory,
      environment: safeEnvironment(config, workDirectory, {}),
    });
    const status = await runCommand({
      command: config.command,
      args: ['login', 'status'],
      cwd: workDirectory,
      environment: safeEnvironment(config, workDirectory, {}),
    });
    const chatGptSubscription = /logged in using chatgpt/i.test(
      `${status.stdout}\n${status.stderr}`,
    );
    return CodexProviderStatusSchema.parse({
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      status: chatGptSubscription ? 'connected' : 'disconnected',
      cliVersion: version.stdout.trim() || version.stderr.trim() || null,
      detailCode: chatGptSubscription
        ? 'chatgpt_subscription_ready'
        : 'run_codex_login',
      checkedAt,
    });
  } catch (error) {
    return CodexProviderStatusSchema.parse({
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      status: 'error',
      cliVersion: null,
      detailCode:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'codex_cli_not_found'
          : 'codex_probe_failed',
      checkedAt,
    });
  }
}
