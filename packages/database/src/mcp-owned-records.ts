import { z } from 'zod';
import type {
  McpExecutionPayload,
  RuntimeActionBinding,
} from '@allrice/contracts';
import {
  runtimePolicyDigest,
  RuntimePolicyError,
} from './runtime-policy-digest.ts';
import { ownedRecordsServiceIdentity } from './mcp-owned-records-service.ts';

const append = z.object({ value: z.string().max(100) }).strict();

/** Only this fixed owned service is enrolled; unrelated legacy connectors are
 * outside this slice. A mismatch within the owned service never falls back. */
export function isOwnedRecordAppend(
  endpoint: string,
  payload: McpExecutionPayload,
) {
  const identity = ownedRecordsServiceIdentity();
  if (!identity || endpoint !== identity.endpoint) return false;
  if (
    payload.tool.name !== 'records.append' ||
    payload.tool.digest !== identity.toolDigest ||
    payload.tool.risk !== 'write' ||
    !append.safeParse(payload.arguments).success
  )
    throw new RuntimePolicyError('native_action_effect_unavailable');
  return true;
}

/** Enrollment uses the original frozen endpoint, not today's connection UI. */
export function isOwnedRecordAppendBinding(
  binding: RuntimeActionBinding,
  payload: McpExecutionPayload,
) {
  const identity = ownedRecordsServiceIdentity();
  if (
    !identity ||
    binding.command?.networkPolicyDigest !==
      runtimePolicyDigest({ endpoint: identity.endpoint, redirects: false })
  )
    return false;
  return isOwnedRecordAppend(identity.endpoint, payload);
}

export function assertNativeActionDisplay(
  original: unknown,
  displayed: unknown,
) {
  if (runtimePolicyDigest(original) !== runtimePolicyDigest(displayed))
    throw new RuntimePolicyError('native_action_display_unavailable');
}
