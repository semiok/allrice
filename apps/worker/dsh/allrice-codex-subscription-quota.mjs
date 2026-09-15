/* global Buffer, clearTimeout, setTimeout */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

const maximumTimeoutMs = 15_000;
const maximumOutputBytes = 1_048_576;
const maximumLineBytes = 262_144;
const allowedRequests = new Set([
  'initialize',
  'account/login/start',
  'account/rateLimits/read',
]);
const allowedNotifications = new Set([
  'account/login/completed',
  'account/updated',
  'account/rateLimits/updated',
  // Verified against the installed official CLI schema. Only the explicitly
  // disabled notification is accepted below; this never enables remote control.
  'remoteControl/status/changed',
  // Official recoverable startup/runtime notices. Discard all payload fields;
  // allowing a notification does not authorize any server-initiated request.
  'configWarning',
  'warning',
]);
const limitIdPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
// Diagnostic vocabulary is fixed, never arbitrary method text or payload.
// These classifications DO NOT expand the protocol allowlist.
const diagnosticMethods = new Map([
  ['deprecationNotice', 'deprecation_notice'],
  ['mcpServer/startupStatus/updated', 'mcp_startup'],
  ['remoteControl/status/changed', 'remote_control_status'],
  ['skills/changed', 'skills_changed'],
  ['app/list/updated', 'app_list_updated'],
  ['serverRequest/resolved', 'server_request_resolved'],
  ['codex/event', 'legacy_codex_event'],
  ['error', 'error'],
  ['configWarning', 'config_warning'],
  ['warning', 'warning'],
  ['account/login/completed', 'account_login_completed'],
  ['account/updated', 'account_updated'],
  ['account/rateLimits/updated', 'account_rate_limits_updated'],
  ['command/exec', 'command_exec'],
]);
function rejectedRpcCode(kind, method, id) {
  const name =
    diagnosticMethods.get(method) ??
    (method.startsWith('codex/event/')
      ? 'legacy_codex_event'
      : method.startsWith('thread/')
        ? 'thread'
        : method.startsWith('turn/')
          ? 'turn'
          : 'unrecognized');
  return `codex_quota_${kind}_rejected_${name}${id === null ? '_null_id' : ''}`;
}

class QuotaError extends Error {
  constructor(code, rejectedMethod) {
    super(code);
    this.code = code;
    if (typeof rejectedMethod === 'string')
      this.rejectedMethodFingerprint = `sha256:${createHash('sha256').update(rejectedMethod).digest('hex')}`;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function windowSnapshot(slot, value) {
  const window = object(value);
  const usedPercent =
    typeof window?.usedPercent === 'number' &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100
      ? window.usedPercent
      : null;
  const windowDurationMins =
    Number.isSafeInteger(window?.windowDurationMins) &&
    window.windowDurationMins > 0
      ? window.windowDurationMins
      : null;
  const resetsAt =
    Number.isSafeInteger(window?.resetsAt) &&
    window.resetsAt > 0 &&
    window.resetsAt <= 253402300799
      ? window.resetsAt
      : null;
  return {
    slot,
    status:
      usedPercent !== null && windowDurationMins !== null && resetsAt !== null
        ? 'available'
        : 'unknown',
    usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

/** Only allowlisted scalars survive; no labels, credits, raw errors or headers. */
export function normalizeCodexSubscriptionQuota(result, accountFingerprint) {
  if (
    typeof accountFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(accountFingerprint)
  )
    throw new QuotaError('codex_quota_account_mismatch');
  const body = object(result);
  if (!body) throw new QuotaError('codex_quota_invalid_response');
  const multi = object(body.rateLimitsByLimitId);
  if (body.rateLimitsByLimitId != null && !multi)
    throw new QuotaError('codex_quota_invalid_response');
  const entries = multi
    ? Object.entries(multi)
    : object(body.rateLimits)
      ? [[null, body.rateLimits]]
      : [];
  if (entries.length > 32) throw new QuotaError('codex_quota_invalid_response');
  const buckets = entries.map(([key, value]) => {
    const bucket = object(value);
    if (!bucket || (key !== null && !limitIdPattern.test(key)))
      throw new QuotaError('codex_quota_invalid_response');
    const reportedId = bucket.limitId;
    if (
      reportedId != null &&
      (typeof reportedId !== 'string' ||
        !limitIdPattern.test(reportedId) ||
        (key !== null && key !== reportedId))
    )
      throw new QuotaError('codex_quota_invalid_response');
    return {
      limitId: key ?? reportedId ?? null,
      limitReached:
        bucket.rateLimitReachedType === null
          ? false
          : typeof bucket.rateLimitReachedType === 'string' &&
              /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(bucket.rateLimitReachedType)
            ? true
            : null,
      windows: [
        windowSnapshot('primary', bucket.primary),
        windowSnapshot('secondary', bucket.secondary),
      ],
    };
  });
  const measured = buckets.some((bucket) =>
    bucket.windows.some((window) => window.status === 'available'),
  );
  return {
    source: 'codex_app_server',
    status: measured ? 'available' : 'unknown',
    checkedAt: new Date().toISOString(),
    accountFingerprint,
    detailCode: measured ? 'codex_quota_read' : 'codex_quota_windows_unknown',
    buckets,
  };
}

function validateAccount(
  { accessToken, chatgptAccountId, expiresAt },
  timeoutMs,
) {
  if (
    typeof accessToken !== 'string' ||
    accessToken.length > 32_768 ||
    typeof chatgptAccountId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(chatgptAccountId) ||
    !Number.isSafeInteger(expiresAt)
  )
    throw new QuotaError('codex_quota_subscription_grant_required');
  const parts = accessToken.split('.');
  if (
    parts.length !== 3 ||
    !parts.every((part) => /^[a-zA-Z0-9_-]+$/.test(part))
  )
    throw new QuotaError('codex_quota_subscription_grant_required');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new QuotaError('codex_quota_subscription_grant_required');
  }
  if (
    payload?.['https://api.openai.com/auth']?.chatgpt_account_id !==
    chatgptAccountId
  )
    throw new QuotaError('codex_quota_account_mismatch');
  const deadline = Date.now() + timeoutMs;
  if (
    expiresAt <= deadline ||
    (payload.exp !== undefined &&
      (!Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= deadline))
  )
    throw new QuotaError('codex_quota_unexpired_grant_required');
  // This is a correlation identifier, not a claim that JWT signature was
  // locally verified. The actual service validates auth on rateLimits/read.
  return `sha256:${createHash('sha256')
    .update(`allrice-codex-subscription-account\0${chatgptAccountId}`)
    .digest('hex')}`;
}

async function controlledCommand(command) {
  if (typeof command !== 'string' || !isAbsolute(command))
    throw new QuotaError('codex_quota_binary_required');
  try {
    const path = await realpath(command);
    const metadata = await stat(path);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' &&
        metadata.uid !== 0 &&
        metadata.uid !== process.getuid())
    )
      throw new Error('unsafe');
    await access(path, constants.X_OK);
    return path;
  } catch {
    throw new QuotaError('codex_quota_binary_unavailable');
  }
}

function createTransport(child, signal, timeoutMs) {
  let sequence = 0;
  let pending = null;
  let failure = null;
  let stopping = false;
  let closed = false;
  let loginSent = false;
  let buffer = '';
  let outputBytes = 0;
  const decoder = new StringDecoder('utf8');
  let closeResolve;
  const closePromise = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const fail = (code, rejectedMethod) => {
    if (stopping || failure) return;
    failure = new QuotaError(code, rejectedMethod);
    pending?.reject(failure);
    pending = null;
    child.kill('SIGTERM');
  };
  const abort = () => fail('codex_quota_aborted');
  const timer = setTimeout(() => fail('codex_quota_timeout'), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', () => fail('codex_quota_process_failed'));
  child.stdin.on('error', () => fail('codex_quota_process_failed'));
  child.once('close', () => {
    closed = true;
    closeResolve();
    fail('codex_quota_process_closed');
  });
  // Never surface stderr: vendor diagnostics can contain auth material.
  child.stderr.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) fail('codex_quota_output_limit');
  });
  child.stdout.on('data', (chunk) => {
    if (failure || stopping) return;
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes)
      return fail('codex_quota_output_limit');
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maximumLineBytes)
        return fail('codex_quota_output_limit');
      let message;
      try {
        message = object(JSON.parse(line));
      } catch {
        return fail('codex_quota_protocol_error');
      }
      if (!message) return fail('codex_quota_protocol_error');
      if (typeof message.method === 'string') {
        // No server-initiated requests are authorized, including token refresh.
        if (Object.hasOwn(message, 'id'))
          return fail(
            message.method === 'account/chatgptAuthTokens/refresh'
              ? 'codex_quota_refresh_required'
              : rejectedRpcCode('server_request', message.method, message.id),
            message.method,
          );
        if (!allowedNotifications.has(message.method))
          return fail(
            rejectedRpcCode('notification', message.method),
            message.method,
          );
        if (
          message.method === 'remoteControl/status/changed' &&
          message.params?.status !== 'disabled'
        )
          return fail('codex_quota_remote_control_active', message.method);
        if (message.method === 'warning' && message.params?.threadId != null)
          return fail(
            'codex_quota_notification_rejected_thread_warning',
            message.method,
          );
        if (
          message.method === 'account/login/completed' &&
          message.params?.success !== true
        )
          return fail('codex_quota_auth_failed');
        if (
          loginSent &&
          message.method === 'account/updated' &&
          message.params?.authMode !== 'chatgptAuthTokens'
        )
          return fail('codex_quota_auth_failed');
        continue;
      }
      if (
        !pending ||
        message.id !== pending.id ||
        Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')
      )
        return fail('codex_quota_protocol_error');
      if (Object.hasOwn(message, 'error'))
        return fail(
          pending.method === 'account/login/start'
            ? 'codex_quota_auth_failed'
            : 'codex_quota_rpc_failed',
        );
      const current = pending;
      pending = null;
      current.resolve(message.result);
    }
    if (Buffer.byteLength(buffer) > maximumLineBytes)
      fail('codex_quota_output_limit');
  });
  if (signal?.aborted) abort();
  const check = () => {
    if (failure) throw failure;
    if (stopping) throw new QuotaError('codex_quota_process_closed');
  };
  return {
    check,
    request(method, params) {
      check();
      if (!allowedRequests.has(method) || pending)
        throw new QuotaError('codex_quota_outgoing_rpc_not_allowed');
      if (method === 'account/login/start') loginSent = true;
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, method, resolve, reject };
        child.stdin.write(
          `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        );
      });
    },
    initialized() {
      check();
      child.stdin.write('{"method":"initialized","params":{}}\n');
    },
    async close() {
      stopping = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      if (closed) return;
      child.kill('SIGTERM');
      let killTimer;
      await Promise.race([
        closePromise,
        new Promise((resolve) => {
          killTimer = setTimeout(resolve, 500);
        }),
      ]);
      clearTimeout(killTimer);
      if (!closed) {
        child.kill('SIGKILL');
        await Promise.race([
          closePromise,
          new Promise((resolve) => {
            killTimer = setTimeout(resolve, 500);
          }),
        ]);
        clearTimeout(killTimer);
      }
      if (!closed) throw new QuotaError('codex_quota_cleanup_failed');
    },
  };
}

/**
 * Caller must be the deployment-owned DSH credential service. No credential
 * files, desktop account, model request, purchases, credits reset or logout.
 * command is an administrator-configured absolute trusted Codex binary, never
 * request input. Tokens go only over private stdin, never argv/env/disk/logs.
 * Only this helper's new private temporary home is removed on completion.
 *
 * Official experimental account protocol and memory-only credential storage:
 * https://learn.chatgpt.com/docs/app-server#authentication-endpoints
 * https://learn.chatgpt.com/docs/auth#credential-storage
 * This is not evidence of live compatibility or production deployment approval.
 */
export async function readCodexSubscriptionQuota({
  command,
  accessToken,
  chatgptAccountId,
  expiresAt,
  chatgptPlanType,
  egressEnvironment = {},
  signal,
  timeoutMs = maximumTimeoutMs,
} = {}) {
  let accountFingerprint = null;
  let quotaHome;
  let transport;
  let result;
  try {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > maximumTimeoutMs
    )
      throw new QuotaError('codex_quota_invalid_timeout');
    accountFingerprint = validateAccount(
      { accessToken, chatgptAccountId, expiresAt },
      timeoutMs,
    );
    if (signal?.aborted) throw new QuotaError('codex_quota_aborted');
    if (
      signal !== undefined &&
      (typeof signal?.addEventListener !== 'function' ||
        typeof signal?.removeEventListener !== 'function')
    )
      throw new QuotaError('codex_quota_invalid_signal');
    const binary = await controlledCommand(command);
    const proxyEnvironment = {};
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      const value = egressEnvironment?.[key];
      if (value === undefined) continue;
      if (
        typeof value !== 'string' ||
        value.length > 8192 ||
        /[\r\n\0]/.test(value)
      )
        throw new QuotaError('codex_quota_invalid_egress');
      proxyEnvironment[key] = value;
    }
    quotaHome = await mkdtemp(join(tmpdir(), 'allrice-codex-quota-'));
    quotaHome = await realpath(quotaHome);
    await chmod(quotaHome, 0o700);
    const child = spawn(
      binary,
      [
        '-c',
        'cli_auth_credentials_store="ephemeral"',
        '-c',
        'check_for_update_on_startup=false',
        'app-server',
        '--listen',
        'stdio://',
      ],
      {
        cwd: quotaHome,
        // Deliberately no inherited env: CODEX_ACCESS_TOKEN, API keys, NODE_*,
        // desktop Codex configuration must not leak in. Only the caller's
        // existing, deployment-controlled proxy allowlist is forwarded.
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          CODEX_HOME: quotaHome,
          XDG_CONFIG_HOME: quotaHome,
          XDG_CACHE_HOME: quotaHome,
          TMPDIR: quotaHome,
          ...proxyEnvironment,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    );
    transport = createTransport(child, signal, timeoutMs);
    const initialized = await transport.request('initialize', {
      clientInfo: {
        name: 'allrice_subscription_quota',
        title: 'AllRice subscription quota reader',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    if (!object(initialized))
      throw new QuotaError('codex_quota_protocol_error');
    transport.initialized();
    const login = await transport.request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken,
      chatgptAccountId,
      ...(typeof chatgptPlanType === 'string' &&
      /^[a-z_]{1,64}$/.test(chatgptPlanType)
        ? { chatgptPlanType }
        : {}),
    });
    if (login?.type !== 'chatgptAuthTokens')
      throw new QuotaError('codex_quota_auth_failed');
    const raw = await transport.request('account/rateLimits/read');
    transport.check();
    result = normalizeCodexSubscriptionQuota(raw, accountFingerprint);
  } catch (error) {
    result = {
      source: 'codex_app_server',
      status: 'error',
      checkedAt: new Date().toISOString(),
      accountFingerprint,
      detailCode:
        error instanceof QuotaError ? error.code : 'codex_quota_unavailable',
      ...(error instanceof QuotaError && error.rejectedMethodFingerprint
        ? { rejectedMethodFingerprint: error.rejectedMethodFingerprint }
        : {}),
      buckets: [],
    };
  } finally {
    try {
      await transport?.close();
      if (quotaHome) await rm(quotaHome, { recursive: true, force: true });
    } catch {
      result = {
        source: 'codex_app_server',
        status: 'error',
        checkedAt: new Date().toISOString(),
        accountFingerprint,
        detailCode: 'codex_quota_cleanup_failed',
        buckets: [],
      };
    }
  }
  return result;
}
