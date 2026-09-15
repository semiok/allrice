/* global AbortController, Buffer */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexSubscriptionQuotaSnapshotSchema } from '../../../packages/contracts/src/codex-subscription-quota.ts';
import {
  normalizeCodexSubscriptionQuota,
  readCodexSubscriptionQuota,
} from './allrice-codex-subscription-quota.mjs';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const syntheticAccount = 'synthetic-subscription-account';
function syntheticGrant(overrides = {}) {
  const expiresAt = Date.now() + 600_000;
  const payload = {
    exp: Math.floor(expiresAt / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: syntheticAccount },
  };
  return {
    accessToken: [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'synthetic-signature',
    ].join('.'),
    chatgptAccountId: syntheticAccount,
    expiresAt,
    ...overrides,
  };
}
const shortWindow = {
  usedPercent: 27.5,
  windowDurationMins: 300,
  resetsAt: 2_000_000_000,
};
const weeklyWindow = {
  usedPercent: 80,
  windowDurationMins: 10_080,
  resetsAt: 2_000_086_400,
};
const completeResult = {
  rateLimits: { primary: { ...shortWindow, usedPercent: 0 } },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: '额度',
      primary: weeklyWindow,
      secondary: shortWindow,
      planType: 'pro',
      credits: { balance: 'must-not-surface', unlimited: true },
    },
    codex_other: {
      limitId: 'codex_other',
      primary: { ...shortWindow, windowDurationMins: 60, usedPercent: 100 },
      secondary: null,
    },
  },
  rateLimitResetCredits: { availableCount: 9 },
};

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fakeServer(scenario = 'success', result = completeResult) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-quota-test-'));
  roots.push(root);
  const receipt = join(root, 'receipt.jsonl');
  const command = join(root, 'codex.mjs');
  const fixtureSource = await readFile(
    new URL('./fixtures/codex-quota-app-server.mjs', import.meta.url),
    'utf8',
  );
  await writeFile(
    command,
    `#!${process.execPath}\nconst fixture = ${JSON.stringify({ scenario, result, receipt })};\n${fixtureSource}`,
    { mode: 0o700 },
  );
  return {
    command,
    async records() {
      return (await readFile(receipt, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    },
  };
}

describe('subscription quota normalization', () => {
  it('keeps real durations and multiple buckets; never assumes secondary is weekly', () => {
    const result = normalizeCodexSubscriptionQuota(completeResult, fingerprint);
    expect(CodexSubscriptionQuotaSnapshotSchema.parse(result)).toEqual(result);
    expect(result.status).toBe('available');
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].windows).toMatchObject([
      { slot: 'primary', windowDurationMins: 10_080, usedPercent: 80 },
      { slot: 'secondary', windowDurationMins: 300, usedPercent: 27.5 },
    ]);
    expect(result.buckets[1].windows[1]).toEqual({
      slot: 'secondary',
      status: 'unknown',
      usedPercent: null,
      windowDurationMins: null,
      resetsAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/credits|balance|planType|额度/);
  });

  it('supports legacy buckets but never fabricates missing quota windows or infinity', () => {
    for (const wire of [
      {},
      { rateLimits: null },
      { rateLimitsByLimitId: {} },
      { rateLimits: { primary: null, secondary: null } },
      { rateLimits: { primary: { usedPercent: 0 } } },
      { rateLimits: { primary: { ...shortWindow, resetsAt: -1 } } },
      { rateLimits: { primary: { ...shortWindow, usedPercent: 100.1 } } },
      { rateLimits: { primary: { ...shortWindow, usedPercent: '25' } } },
      { rateLimits: { primary: { ...shortWindow, windowDurationMins: 0 } } },
    ]) {
      const result = normalizeCodexSubscriptionQuota(wire, fingerprint);
      expect(result.status).toBe('unknown');
      expect(
        CodexSubscriptionQuotaSnapshotSchema.safeParse(result).success,
      ).toBe(true);
    }
    const legacy = normalizeCodexSubscriptionQuota(
      { rateLimits: { primary: shortWindow } },
      fingerprint,
    );
    expect(legacy.buckets[0].limitId).toBeNull();
    expect(legacy.status).toBe('available');
  });

  it('rejects malformed identity, bucket containers and unbounded collections', () => {
    for (const wire of [
      null,
      [],
      { rateLimitsByLimitId: [] },
      { rateLimitsByLimitId: { codex: null } },
      { rateLimitsByLimitId: { codex: { limitId: 'other' } } },
      { rateLimitsByLimitId: { 'secret\nvalue': {} } },
      {
        rateLimitsByLimitId: Object.fromEntries(
          Array.from({ length: 33 }, (_, n) => [`bucket_${n}`, {}]),
        ),
      },
    ])
      expect(() =>
        normalizeCodexSubscriptionQuota(wire, fingerprint),
      ).toThrow();
  });

  it('contract refuses available without identity/complete windows and inconsistent slots', () => {
    const good = normalizeCodexSubscriptionQuota(completeResult, fingerprint);
    expect(
      CodexSubscriptionQuotaSnapshotSchema.safeParse({
        ...good,
        accountFingerprint: null,
      }).success,
    ).toBe(false);
    expect(
      CodexSubscriptionQuotaSnapshotSchema.safeParse({
        ...good,
        status: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      CodexSubscriptionQuotaSnapshotSchema.safeParse({ ...good, buckets: [] })
        .success,
    ).toBe(false);
    const windows = good.buckets[0].windows.map((window) => ({
      ...window,
      slot: 'secondary',
    }));
    expect(
      CodexSubscriptionQuotaSnapshotSchema.safeParse({
        ...good,
        buckets: [{ limitId: 'codex', windows }],
      }).success,
    ).toBe(false);
  });
});

describe('isolated subscription-only app-server transport', () => {
  it('sends only approved account RPCs with explicitly bound synthetic tokens and no inherited credentials', async () => {
    const fake = await fakeServer();
    const grant = syntheticGrant();
    const result = await readCodexSubscriptionQuota({
      ...grant,
      command: fake.command,
      chatgptPlanType: 'pro',
    });
    expect(result.status).toBe('available');
    expect(CodexSubscriptionQuotaSnapshotSchema.safeParse(result).success).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain(grant.accessToken);
    expect(JSON.stringify(result)).not.toContain(syntheticAccount);
    const records = await fake.records();
    const startup = records[0];
    expect(startup.homeMode).toBe(0o700);
    expect(startup.homeFiles).toEqual([]);
    expect(startup.cwd).toBe(startup.env.CODEX_HOME);
    expect(startup.env.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
    // macOS can insert its non-secret locale hint after exec; it is not inherited.
    expect(
      Object.keys(startup.env)
        .filter((key) => key !== '__CF_USER_TEXT_ENCODING')
        .sort(),
    ).toEqual([
      'CODEX_HOME',
      'LANG',
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
    ]);
    expect(startup.argv).toEqual([
      '-c',
      'cli_auth_credentials_store="ephemeral"',
      '-c',
      'check_for_update_on_startup=false',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    await expect(stat(startup.env.CODEX_HOME)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const requests = records
      .filter((record) => record.request)
      .map((record) => record.request);
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'account/login/start',
      'account/rateLimits/read',
    ]);
    expect(requests[0].params.capabilities).toEqual({ experimentalApi: true });
    expect(requests[2].params).toEqual({
      type: 'chatgptAuthTokens',
      accessToken: grant.accessToken,
      chatgptAccountId: syntheticAccount,
      chatgptPlanType: 'pro',
    });
    expect(records.some((record) => record.forbidden)).toBe(false);
  });

  it('preserves explicit reached status independently of percent and treats absence as unknown', () => {
    for (const [value, expected] of [
      [null, false],
      ['plan', true],
      [undefined, null],
      ['', null],
      [{}, null],
    ]) {
      const result = normalizeCodexSubscriptionQuota(
        { rateLimits: { rateLimitReachedType: value } },
        fingerprint,
      );
      expect(result.buckets[0].limitReached).toBe(expected);
      expect(result.status).toBe('unknown');
      expect(
        CodexSubscriptionQuotaSnapshotSchema.safeParse(result).success,
      ).toBe(true);
    }
  });

  it('decodes split UTF-8 output and returns unknown for absent windows', async () => {
    const fragmented = await fakeServer('fragmented');
    expect(
      (
        await readCodexSubscriptionQuota({
          ...syntheticGrant(),
          command: fragmented.command,
        })
      ).status,
    ).toBe('available');
    const empty = await fakeServer('success', {
      rateLimits: { primary: null },
    });
    expect(
      (
        await readCodexSubscriptionQuota({
          ...syntheticGrant(),
          command: empty.command,
        })
      ).status,
    ).toBe('unknown');
  });

  it.each([
    ['remote_connecting', 'codex_quota_remote_control_active'],
    ['remote_connected', 'codex_quota_remote_control_active'],
    ['remote_errored', 'codex_quota_remote_control_active'],
    ['remote_missing', 'codex_quota_remote_control_active'],
    [
      'remote_request',
      'codex_quota_server_request_rejected_remote_control_status',
    ],
    ['refresh', 'codex_quota_refresh_required'],
    ['server_request', 'codex_quota_server_request_rejected_command_exec'],
    ['thread_warning', 'codex_quota_notification_rejected_thread_warning'],
    ['warning_request', 'codex_quota_server_request_rejected_config_warning'],
    ['unknown_notification', 'codex_quota_notification_rejected_thread'],
    ['unknown_method', 'codex_quota_notification_rejected_unrecognized'],
    [
      'deprecation_notice',
      'codex_quota_notification_rejected_deprecation_notice',
    ],
    ['null_id', 'codex_quota_server_request_rejected_account_updated_null_id'],
    ['wrong_auth', 'codex_quota_auth_failed'],
    ['login_failed', 'codex_quota_auth_failed'],
    ['changed_auth', 'codex_quota_auth_failed'],
    ['auth_error', 'codex_quota_auth_failed'],
    ['rpc_error', 'codex_quota_rpc_failed'],
    ['wrong_id', 'codex_quota_protocol_error'],
    ['malformed', 'codex_quota_protocol_error'],
    ['stdout_limit', 'codex_quota_output_limit'],
    ['stderr_limit', 'codex_quota_output_limit'],
    ['early_exit', 'codex_quota_process_closed'],
  ])(
    'fails closed on %s and does not leak raw output',
    async (scenario, code) => {
      const fake = await fakeServer(scenario);
      const grant = syntheticGrant();
      const result = await readCodexSubscriptionQuota({
        ...grant,
        command: fake.command,
      });
      expect(result).toMatchObject({
        status: 'error',
        detailCode: code,
        buckets: [],
      });
      expect(
        CodexSubscriptionQuotaSnapshotSchema.safeParse(result).success,
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(grant.accessToken);
      expect(JSON.stringify(result)).not.toContain(
        'synthetic-sensitive-installation',
      );
      expect(JSON.stringify(result)).not.toContain(
        'synthetic-sensitive-server',
      );
      expect(JSON.stringify(result)).not.toContain(
        'secret-provider-diagnostic',
      );
      if (scenario === 'unknown_method') {
        expect(result.rejectedMethodFingerprint).toBe(
          `sha256:${createHash('sha256').update('synthetic-sensitive-arbitrary-method').digest('hex')}`,
        );
        expect(JSON.stringify(result)).not.toContain(
          'synthetic-sensitive-arbitrary-method',
        );
      }
      const records = await fake.records();
      expect(records.some((record) => record.forbidden)).toBe(false);
      await expect(stat(records[0].env.CODEX_HOME)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.each(['startup_warnings', 'remote_disabled'])(
    'ignores safe %s startup notification without exposing payloads',
    async (scenario) => {
      const fake = await fakeServer(scenario);
      const result = await readCodexSubscriptionQuota({
        ...syntheticGrant(),
        command: fake.command,
      });
      expect(result.status).toBe('available');
      expect(JSON.stringify(result)).not.toContain('synthetic-sensitive');
      const requests = (await fake.records())
        .filter((entry) => entry.request)
        .map((entry) => entry.request.method);
      expect(requests).toEqual([
        'initialize',
        'initialized',
        'account/login/start',
        'account/rateLimits/read',
      ]);
    },
  );

  it('bounds timeout and abort and cleans the private home', async () => {
    const fake = await fakeServer('stall');
    const timedOut = await readCodexSubscriptionQuota({
      ...syntheticGrant(),
      command: fake.command,
      timeoutMs: 1500,
    });
    expect(timedOut.detailCode).toBe('codex_quota_timeout');
    const controller = new AbortController();
    const another = await fakeServer('stall');
    const pendingAbort = readCodexSubscriptionQuota({
      ...syntheticGrant(),
      command: another.command,
      signal: controller.signal,
    });
    await vi.waitFor(
      async () => expect((await another.records())[0].startup).toBe(true),
      { timeout: 4000 },
    );
    controller.abort();
    const aborted = await pendingAbort;
    expect(aborted.detailCode).toBe('codex_quota_aborted');
    await expect(
      stat((await fake.records())[0].env.CODEX_HOME),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat((await another.records())[0].env.CODEX_HOME),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('only forwards explicit deployment proxy keys, not other supplied environment values', async () => {
    const fake = await fakeServer();
    const result = await readCodexSubscriptionQuota({
      ...syntheticGrant(),
      command: fake.command,
      egressEnvironment: {
        HTTP_PROXY: 'http://127.0.0.1:9229',
        HTTPS_PROXY: 'http://127.0.0.1:9229',
        NO_PROXY: 'localhost,127.0.0.1',
        OPENAI_API_KEY: 'synthetic-must-not-inherit',
        CODEX_ACCESS_TOKEN: 'synthetic-must-not-inherit',
        NODE_OPTIONS: '--inspect',
      },
    });
    expect(result.status).toBe('available');
    const env = (await fake.records())[0].env;
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:9229');
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('rejects missing/expired/mismatched grants and untrusted commands before spawn', async () => {
    const fake = await fakeServer();
    for (const overrides of [
      { accessToken: undefined },
      { accessToken: 'not-a-jwt' },
      { chatgptAccountId: 'other-account' },
      { expiresAt: Date.now() },
      { expiresAt: undefined },
      { command: 'codex' },
      { command: '/does-not-exist/codex' },
      { timeoutMs: 0 },
      { timeoutMs: 15001 },
    ]) {
      const result = await readCodexSubscriptionQuota({
        ...syntheticGrant(),
        command: fake.command,
        ...overrides,
      });
      expect(result.status).toBe('error');
      expect(
        CodexSubscriptionQuotaSnapshotSchema.safeParse(result).success,
      ).toBe(true);
    }
    await expect(fake.records()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
