import { defaultWorkAutomation } from '../work-automation.ts';
import { describe, expect, it } from 'vitest';
import {
  evaluateRuntimePolicy,
  runtimePolicyActionDecision,
  isRuntimeRelativePath,
  runtimeStaticPreviewPolicy,
} from './policy.ts';
import { RuntimeActionBindingSchema } from './identity.ts';

const id = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'a'.repeat(64)}`;
const binding = RuntimeActionBindingSchema.parse({
  task: {
    scope: { organizationId: id, workspaceId: id, projectId: null },
    chatSessionId: null,
    runId: id,
    rootRunId: id,
    parentRunId: null,
    frozenConfiguration: { employeeVersionId: null, digest },
  },
  attempt: {
    operationId: id,
    attemptId: id,
    attemptNumber: 1,
    generation: 0,
    fence: 1,
  },
  requestedBy: { type: 'user', id },
  policy: { snapshotId: id, digest },
  execution: {
    targetId: id,
    targetKind: 'rice_bridge',
    deviceId: id,
    grantId: id,
    grantVersion: 1,
    scopeDigest: digest,
    workCopy: { id, kind: 'in_place' },
  },
  action: 'local.fs.write',
  inputDigest: digest,
  dataScope: [],
  baseline: [],
  command: null,
});
const controls = {
  version: 1,
  enabled: true,
  mode: 'execute',
  rules: [{ action: binding.action, effect: 'allow' }],
};
describe('B1 deterministic policy', () => {
  it('projects existing delegation authority without inventing an Ask approval path', () => {
    const action = 'assistant.delegate';
    for (const effect of ['allow', 'deny', 'ask'] as const) {
      expect(
        runtimePolicyActionDecision(
          { ...controls, rules: [{ action, effect }] },
          action,
        ).effect,
      ).toBe(effect === 'allow' ? 'allow' : 'deny');
    }
    expect(
      runtimePolicyActionDecision({ ...controls, rules: [] }, action).effect,
    ).toBe('deny');
    expect(
      runtimePolicyActionDecision(
        {
          ...controls,
          mode: 'plan_only',
          rules: [{ action, effect: 'allow' }],
        },
        action,
      ).effect,
    ).toBe('deny');
    expect(
      runtimePolicyActionDecision(
        {
          ...controls,
          rules: [
            { action, effect: 'allow' },
            { action, effect: 'ask' },
          ],
        },
        action,
      ).effect,
    ).toBe('deny');
  });
  it('explicit supported allow only', () =>
    expect(evaluateRuntimePolicy(controls, binding).effect).toBe('allow'));
  it('Deny cannot be erased by a later Allow', () =>
    expect(
      evaluateRuntimePolicy(
        {
          ...controls,
          rules: [
            { action: binding.action, effect: 'deny' },
            ...controls.rules,
          ],
        },
        binding,
      ).reason,
    ).toBe('tenant_deny'));
  it('Ask cannot be erased by Allow', () =>
    expect(
      evaluateRuntimePolicy(
        {
          ...controls,
          rules: [...controls.rules, { action: binding.action, effect: 'ask' }],
        },
        binding,
      ).effect,
    ).toBe('ask'));
  it('platform deny beats tenant Allow', () =>
    expect(
      evaluateRuntimePolicy(controls, binding, [binding.action]).reason,
    ).toBe('platform_deny'));
  it('plan-only prevents file writes', () =>
    expect(
      evaluateRuntimePolicy({ ...controls, mode: 'plan_only' }, binding).reason,
    ).toBe('plan_only'));
  it('disabled controls deny', () =>
    expect(
      evaluateRuntimePolicy({ ...controls, enabled: false }, binding).effect,
    ).toBe('deny'));
  it.each([
    'local.command.run',
    'local.git.status',
    'local.git.diff',
    'hooks.execute',
    'plugins.install',
    'boost',
    'teamwork',
    'preview.html.execute',
  ])('cannot register %s by policy', (action) =>
    expect(
      evaluateRuntimePolicy(
        { ...controls, rules: [{ action, effect: 'allow' }] },
        { ...binding, action },
      ).reason,
    ).toBe('action_not_registered'),
  );
  it.each([
    null,
    {},
    { ...controls, rules: [{ action: '*', effect: 'allow' }] },
    { ...controls, allowAll: true },
  ])('fails closed on invalid/unmatched controls %j', (value) =>
    expect(evaluateRuntimePolicy(value, binding).effect).toBe('deny'),
  );
  it.each([
    '../secret',
    '/absolute',
    'a/../../secret',
    'a\\secret',
    'C:secret',
    'a//b',
    'a/./b',
    'a\u0000b',
    'a\nb',
    'https://example.test',
    '',
  ])('rejects unsafe path syntax %j', (value) =>
    expect(isRuntimeRelativePath(value)).toBe(false),
  );
  it('allows relative paths without claiming symlink isolation', () =>
    expect(isRuntimeRelativePath('src/中文.ts')).toBe(true));
  it.each([
    'text/html',
    'image/svg+xml',
    'text/markdown',
    'text/javascript',
    'application/pdf',
  ])('requires inert escaped rendering for %s', (mime) =>
    expect(runtimeStaticPreviewPolicy(mime)).toMatchObject({
      mode: 'escaped_text',
      allowScripts: false,
      allowRemoteResources: false,
      allowMainOriginExecution: false,
      requiresCurrentAuthorization: true,
    }),
  );
  it('raster still requires authenticated bytes and no remote resources', () =>
    expect(runtimeStaticPreviewPolicy('image/png')).toMatchObject({
      mode: 'authenticated_raster',
      allowRemoteResources: false,
      requiresCurrentAuthorization: true,
    }));
});

describe('member-controlled confirmation', () => {
  it.each([
    'local.fs.write',
    'local.fs.mkdir',
    'local.fs.changeset',
    'local.process.execute',
    'local.mcp.discover',
    'local.mcp.call',
    'local.browser.act',
    'cloud.process.execute',
    'cloud.mcp.call',
    'cloud.browser.act',
  ])('applies settings to %s without expanding authority', (action) => {
    const policy = { ...controls, rules: [{ action, effect: 'allow' }] };
    expect(
      runtimePolicyActionDecision(policy, action, [], defaultWorkAutomation)
        .effect,
    ).toBe('allow');
    expect(
      runtimePolicyActionDecision(policy, action, [], {
        cloud: false,
        computer: false,
        assistants: true,
      }).effect,
    ).toBe('ask');
    expect(
      runtimePolicyActionDecision(
        { ...policy, rules: [{ action, effect: 'ask' }] },
        action,
        [],
        defaultWorkAutomation,
      ).effect,
    ).toBe('allow');
    expect(
      runtimePolicyActionDecision(
        { ...policy, rules: [{ action, effect: 'deny' }] },
        action,
        [],
        defaultWorkAutomation,
      ).effect,
    ).toBe('deny');
    expect(
      runtimePolicyActionDecision(
        { ...policy, rules: [] },
        action,
        [],
        defaultWorkAutomation,
      ).effect,
    ).toBe('deny');
    expect(
      runtimePolicyActionDecision(
        { ...policy, mode: 'plan_only' },
        action,
        [],
        defaultWorkAutomation,
      ).effect,
    ).toBe('deny');
    expect(
      runtimePolicyActionDecision(
        policy,
        action,
        [action],
        defaultWorkAutomation,
      ).effect,
    ).toBe('deny');
  });
  it('lets members disable assistants without disabling reads', () => {
    const policy = {
      ...controls,
      rules: [
        { action: 'assistant.delegate', effect: 'allow' },
        { action: 'local.fs.read', effect: 'allow' },
      ],
    };
    const off = { cloud: false, computer: false, assistants: false };
    expect(
      runtimePolicyActionDecision(policy, 'assistant.delegate', [], off).reason,
    ).toBe('member_assistants_disabled');
    expect(
      runtimePolicyActionDecision(policy, 'local.fs.read', [], off).effect,
    ).toBe('allow');
    expect(
      runtimePolicyActionDecision(
        { ...policy, rules: [{ action: 'unregistered', effect: 'allow' }] },
        'unregistered',
        [],
        defaultWorkAutomation,
      ).effect,
    ).toBe('deny');
  });
});
