import { z } from 'zod';

import { RuntimeActionBindingSchema } from './identity.ts';
import {
  workAutomationGroup,
  type WorkAutomation,
} from '../work-automation.ts';

/** Exact identifiers only: no glob, regex, script or prompt-based permissions. */
export const RuntimePolicyControlsSchema = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean(),
    mode: z.enum(['execute', 'plan_only']),
    rules: z
      .array(
        z
          .object({
            action: z.string().min(1).max(160),
            effect: z.enum(['deny', 'ask', 'allow']),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export type RuntimePolicyControls = z.infer<typeof RuntimePolicyControlsSchema>;

export type RuntimePolicyDecision = {
  effect: 'deny' | 'ask' | 'allow';
  reason: string;
};

// Exact governed actions. Adding a rule cannot register a Runner or bypass its release gate.
export const runtimeGovernedActions = [
  // Delegation already has its own root/employee/budget authority checker.
  // Listing its existing rule here exposes configuration, not a new Runner.
  'assistant.delegate',
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.file.inspect',
  'local.file.import',
  'local.file.save',
  'local.file.open',
  'local.file.reveal',
  'local.process.execute',
  'local.python.execute',
  'local.pdf.read',
  'local.fs.changeset',
  'cloud.process.execute',
  'cloud.mcp.call',
  'local.mcp.discover',
  'local.mcp.call',
  'cloud.browser.act',
  'cloud.browser.observe',
  'local.browser.act',
  'local.browser.observe',
] as const;

const readActions = new Set<string>([
  'local.pdf.read',
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.file.inspect',
  'cloud.browser.observe',
  'local.browser.observe',
]);

/** Pure policy calculation only. DB identity, revocation and approval checks follow. */
export function evaluateRuntimePolicy(
  controlsInput: unknown,
  bindingInput: unknown,
  platformDeniedActions: readonly string[] = [],
  automation?: WorkAutomation,
): RuntimePolicyDecision {
  const controls = RuntimePolicyControlsSchema.safeParse(controlsInput);
  const binding = RuntimeActionBindingSchema.safeParse(bindingInput);
  if (!controls.success || !binding.success)
    return { effect: 'deny', reason: 'invalid_policy_or_binding' };
  const action = binding.data.action;
  return runtimePolicyActionDecision(
    controls.data,
    action,
    platformDeniedActions,
    automation,
  );
}

/** Shared explanatory projection; never substitutes for binding/identity checks. */
export function runtimePolicyActionDecision(
  controlsInput: unknown,
  action: string,
  platformDeniedActions: readonly string[] = [],
  automation?: WorkAutomation,
): RuntimePolicyDecision {
  const controls = RuntimePolicyControlsSchema.safeParse(controlsInput);
  if (!controls.success)
    return { effect: 'deny', reason: 'invalid_policy_or_binding' };
  if (!controls.data.enabled)
    return { effect: 'deny', reason: 'runtime_policy_disabled' };
  if (!(runtimeGovernedActions as readonly string[]).includes(action))
    return { effect: 'deny', reason: 'action_not_registered' };
  if (platformDeniedActions.includes(action))
    return { effect: 'deny', reason: 'platform_deny' };
  if (controls.data.mode === 'plan_only' && !readActions.has(action))
    return { effect: 'deny', reason: 'plan_only' };
  const matches = controls.data.rules.filter((rule) => rule.action === action);
  // An explicit Deny remains authoritative. Confirmation follows the member setting.
  if (matches.some((rule) => rule.effect === 'deny'))
    return { effect: 'deny', reason: 'tenant_deny' };
  // PDF is an internal backend of the already-published document read, not
  // another tool permission to ask users to configure. The production
  // authority resolver still requires that exact frozen read delegation,
  // publication, authorized source, verified profile and current job lease.
  // Do not change legacy controls or let this default override an explicit Deny.
  if (action === 'local.pdf.read' && matches.length === 0)
    return { effect: 'allow', reason: 'published_document_read' };
  // Current member preferences choose confirmation within an already allowed
  // action. They never register a tool, lift a Deny, or widen a resource grant.
  const group = workAutomationGroup(action);
  if (
    automation &&
    group &&
    matches.some(
      (rule) =>
        rule.effect === 'allow' ||
        (group !== 'assistants' && rule.effect === 'ask'),
    )
  ) {
    if (group === 'assistants' && !automation.assistants)
      return { effect: 'deny', reason: 'member_assistants_disabled' };
    if (group !== 'assistants')
      return automation[group]
        ? { effect: 'allow', reason: 'member_scope_automation' }
        : { effect: 'ask', reason: 'member_confirmation_required' };
  }
  // The existing assistant authority requires explicit Allow and rejects Ask;
  // there is no per-delegation approval/resume path to advertise.
  if (
    action === 'assistant.delegate' &&
    matches.some((r) => r.effect === 'ask')
  )
    return { effect: 'deny', reason: 'delegation_requires_explicit_allow' };
  if (matches.some((rule) => rule.effect === 'ask'))
    return { effect: 'ask', reason: 'exact_approval_required' };
  // Legacy operations without a captured member setting retain their original
  // exact-approval semantics; upgrading cannot approve an existing operation.
  if (
    [
      'local.process.execute',
      'local.python.execute',
      'local.fs.changeset',
      'cloud.process.execute',
      'cloud.mcp.call',
      'local.mcp.discover',
      'local.mcp.call',
      'cloud.browser.act',
      'local.browser.act',
    ].includes(action) &&
    matches.some((rule) => rule.effect === 'allow')
  )
    return { effect: 'ask', reason: 'exact_approval_required' };
  if (matches.some((rule) => rule.effect === 'allow'))
    return { effect: 'allow', reason: 'explicit_policy_allow' };
  return { effect: 'deny', reason: 'no_matching_policy' };
}

/** Syntax precondition, NOT a filesystem/TOCTOU or symlink sandbox. */
export function isRuntimeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith('/') &&
    !/[\\:]/u.test(value) &&
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Shared raw-byte bound for server reads and browser base64 admission. */
export const runtimeRasterPreviewMaxBytes = 8_000_000;

/** Presentation requirements; a renderer must enforce them before displaying bytes. */
export function runtimeStaticPreviewPolicy(mimeType: string) {
  const raster = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType);
  return {
    mode: raster
      ? ('authenticated_raster' as const)
      : ('escaped_text' as const),
    allowScripts: false as const,
    allowRemoteResources: false as const,
    allowMainOriginExecution: false as const,
    requiresCurrentAuthorization: true as const,
    responseHeaders: {
      'Content-Security-Policy':
        "default-src 'none'; sandbox; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  };
}
