import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  readServiceBuildIdentity,
  type ServiceBuildRole,
} from './service-build-identity.ts';

/** Application-owned policy v1. No tenant/employee writer or separate module
 * release: all four builtins ship and are enabled with the AllRice build. */
export const builtinModules = Object.freeze({
  deliverables: true,
  'enterprise-materials': true,
  'employee-memory': true,
  capabilities: true,
} as const);
export type BuiltinModuleId = keyof typeof builtinModules;

/** Host-only substitution boundary for a future authorized policy source.
 * This checks module availability, never identity or resource access for callers.
 * The current caller supplies its independently authenticated current scope. */
export interface BuiltinModuleAuthority {
  require(
    input: Readonly<{
      moduleId: BuiltinModuleId;
      context: RequestContext;
      identity: DEntryIdentity;
    }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export async function readApplicationBuiltinModules(service: ServiceBuildRole) {
  const build = await readServiceBuildIdentity(service);
  return Object.freeze({
    schemaVersion: 1 as const,
    policy: 'all-enabled' as const,
    // Existing build verification returns null for unsealed/dev entrypoints.
    // Keep provenance unknown; never infer a release from env, RC or a request.
    applicationBuild: build
      ? Object.freeze({
          sourceSha: build.sourceSha,
          sourceTree: build.sourceTree,
          manifestDigest: build.manifestDigest,
          webBuildId: build.webBuildId,
        })
      : null,
    builtinModules,
  });
}

export function createApplicationBuiltinModuleAuthority(
  service: ServiceBuildRole,
): BuiltinModuleAuthority {
  const authority: BuiltinModuleAuthority = {
    async require({ moduleId }, signal) {
      signal.throwIfAborted();
      const policy = await readApplicationBuiltinModules(service);
      signal.throwIfAborted();
      if (policy.builtinModules[moduleId] !== true)
        throw new DataAccessError('authorization_denied');
    },
  };
  return Object.freeze(authority);
}
