import {
  RuntimeLocalCommandProfileSchema,
  localCommandToolchainImageV1,
  type BridgeDevice,
  type RuntimeLocalCommand,
} from '@allrice/contracts';

import { getDatabase } from './core/client.ts';
import { RuntimePolicyError, runtimePolicyDigest } from './runtime-policy.ts';

export const localCommandEnabled = () =>
  process.env.ALLRICE_LOCAL_COMMAND_ENABLED === '1';

/** Device reports availability, not authorization or third-party attestation. */
export async function reportLocalCommandProfile(
  device: BridgeDevice,
  input: unknown,
  database = getDatabase(),
) {
  if (!localCommandEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const profile = RuntimeLocalCommandProfileSchema.parse(input);
  // Release allowlist follows actual platform evidence, not a client boolean.
  if (
    device.platform !== 'macos-x64' ||
    profile.architecture !== 'amd64' ||
    device.revokedAt ||
    profile.imageDigest !== localCommandToolchainImageV1
  )
    throw new RuntimePolicyError('target_unavailable');
  await database`insert into allrice_bridge_runtime_profiles(device_id,organization_id,workspace_id,profile)
    values(${device.id},${device.organizationId},${device.workspaceId},${database.json(profile)})
    on conflict(device_id) do update set profile=excluded.profile,reported_at=clock_timestamp()
    where allrice_bridge_runtime_profiles.organization_id=excluded.organization_id
      and allrice_bridge_runtime_profiles.workspace_id=excluded.workspace_id`;
  return profile;
}

/** Immutable effective execution specification; secrets are not part of this environment. */
export function localCommandBinding(payload: RuntimeLocalCommand) {
  const args = payload.arguments;
  return {
    executableDigest: runtimePolicyDigest({
      executable: args.executable,
      imageDigest: args.imageDigest,
    }),
    argumentsDigest: runtimePolicyDigest(args.args),
    workingDirectoryDigest: runtimePolicyDigest({
      path: args.path,
      files: args.files,
      kind: 'local_copy',
    }),
    effectiveEnvironmentDigest: runtimePolicyDigest({
      version: 'local-vm-container-v1',
      credentials: 'none',
    }),
    networkPolicyDigest: runtimePolicyDigest({
      network: args.network,
      ...(args.dependencies ? { dependencyDownloads: args.dependencies } : {}),
    }),
    toolchainDigest: runtimePolicyDigest({
      imageDigest: args.imageDigest,
      backend: args.isolation,
    }),
    budgetDigest: runtimePolicyDigest(
      args.background
        ? { limits: args.limits, background: args.background }
        : args.limits,
    ),
  };
}
