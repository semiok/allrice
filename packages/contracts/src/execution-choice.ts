import { z } from 'zod';

/** Discovery facts only. Dispatch still requires the existing Run, grant and lease. */
export const BridgeReadinessCapabilitySchema = z.enum([
  'local.fs.list',
  'local.fs.search',
  'local.fs.read',
  'local.fs.write',
  'local.fs.mkdir',
  'local.git.status',
  'local.git.diff',
  'local.browser',
  'local.process',
  'local.preview',
  'local.development',
  'local.mcp',
  'local.office',
]);
export type BridgeReadinessCapability = z.infer<
  typeof BridgeReadinessCapabilitySchema
>;
export const BridgeReadinessStateSchema = z.enum([
  'unsupported',
  'preparing',
  'ready',
  'busy',
  'paused',
  'offline',
]);
export type BridgeReadinessState = z.infer<typeof BridgeReadinessStateSchema>;
const code = z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/);
export const BridgeCapabilityReadinessSchema = z
  .object({
    capability: BridgeReadinessCapabilitySchema,
    state: BridgeReadinessStateSchema,
    reason: code,
    missing: z.array(code).max(8),
    versions: z
      .record(code, z.string().min(1).max(160))
      .refine((value) => Object.keys(value).length <= 8),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type BridgeCapabilityReadiness = z.infer<
  typeof BridgeCapabilityReadinessSchema
>;
export const BridgeCapabilityReadinessListSchema = z
  .array(BridgeCapabilityReadinessSchema)
  .max(16)
  .refine(
    (items) =>
      new Set(items.map((item) => item.capability)).size === items.length,
    'each capability has one readiness report',
  );

export const ExecutionLocationSchema = z.enum(['auto', 'local', 'cloud']);
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;
export const ExecutionChoiceSchema = z
  .object({
    location: z.enum(['local', 'cloud', 'none']),
    status: z.enum(['execute', 'wait', 'unavailable', 'reconcile']),
    reason: z.enum([
      'local_ready',
      'local_busy',
      'local_preparing',
      'local_paused',
      'local_offline',
      'local_unsupported',
      'local_missing',
      'explicit_local',
      'explicit_cloud',
      'local_inputs_required',
      'cloud_unavailable',
      'bound_execution',
      'outcome_unknown',
    ]),
  })
  .strict();
export type ExecutionChoice = z.infer<typeof ExecutionChoiceSchema>;

/** Pure policy shared by discovery and actual admission. A temporary local
 * wait never consumes a cloud slot; an existing execution never changes end. */
export function resolveExecutionChoice(input: {
  location?: ExecutionLocation;
  local: BridgeReadinessState | null;
  cloudAvailable: boolean;
  localInputs?: boolean;
  boundLocation?: 'local' | 'cloud';
  outcomeUnknown?: boolean;
}): ExecutionChoice {
  if (input.outcomeUnknown)
    return {
      location: input.boundLocation ?? 'none',
      status: 'reconcile',
      reason: 'outcome_unknown',
    };
  const requested = input.boundLocation ?? input.location ?? 'auto';
  if (requested === 'cloud') {
    if (input.localInputs)
      return {
        location: 'none',
        status: 'unavailable',
        reason: 'local_inputs_required',
      };
    return {
      location: 'cloud',
      status: input.cloudAvailable ? 'execute' : 'unavailable',
      reason: input.cloudAvailable
        ? input.boundLocation
          ? 'bound_execution'
          : 'explicit_cloud'
        : 'cloud_unavailable',
    };
  }
  const required = requested === 'local' || input.localInputs;
  if (input.local === 'ready')
    return {
      location: 'local',
      status: 'execute',
      reason: input.boundLocation
        ? 'bound_execution'
        : requested === 'local'
          ? 'explicit_local'
          : 'local_ready',
    };
  if (input.local === 'busy' || input.local === 'preparing')
    return {
      location: 'local',
      status: 'wait',
      reason: input.local === 'busy' ? 'local_busy' : 'local_preparing',
    };
  const reason =
    input.local === 'paused'
      ? 'local_paused'
      : input.local === 'offline'
        ? 'local_offline'
        : input.local === 'unsupported'
          ? 'local_unsupported'
          : 'local_missing';
  if (required)
    return {
      location: 'local',
      status: 'unavailable',
      reason: input.localInputs ? 'local_inputs_required' : reason,
    };
  return {
    location: input.cloudAvailable ? 'cloud' : 'none',
    status: input.cloudAvailable ? 'execute' : 'unavailable',
    reason: input.cloudAvailable ? reason : 'cloud_unavailable',
  };
}
