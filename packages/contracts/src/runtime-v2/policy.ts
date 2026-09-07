import { z } from 'zod';

import { RuntimeActionBindingSchema } from './identity.ts';

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

// B1 registers only existing tools. Adding a rule cannot register a new Runner.
export const runtimeGovernedActions = [
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
] as const;

const readActions = new Set<string>([
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.git.status',
  'local.git.diff',
]);

/** Pure policy calculation only. DB identity, revocation and approval checks follow. */
export function evaluateRuntimePolicy(
  controlsInput: unknown,
  bindingInput: unknown,
  platformDeniedActions: readonly string[] = [],
): RuntimePolicyDecision {
  const controls = RuntimePolicyControlsSchema.safeParse(controlsInput);
  const binding = RuntimeActionBindingSchema.safeParse(bindingInput);
  if (!controls.success || !binding.success)
    return { effect: 'deny', reason: 'invalid_policy_or_binding' };
  const action = binding.data.action;
  if (!controls.data.enabled)
    return { effect: 'deny', reason: 'runtime_policy_disabled' };
  if (!(runtimeGovernedActions as readonly string[]).includes(action))
    return { effect: 'deny', reason: 'action_not_registered' };
  if (platformDeniedActions.includes(action))
    return { effect: 'deny', reason: 'platform_deny' };
  if (controls.data.mode === 'plan_only' && !readActions.has(action))
    return { effect: 'deny', reason: 'plan_only' };
  const matches = controls.data.rules.filter((rule) => rule.action === action);
  // A narrower/later Allow can never erase an applicable hard Deny or Ask.
  if (matches.some((rule) => rule.effect === 'deny'))
    return { effect: 'deny', reason: 'tenant_deny' };
  if (matches.some((rule) => rule.effect === 'ask'))
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
