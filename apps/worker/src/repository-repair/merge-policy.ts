import { repositoryRequiredChecks } from '@allrice/database/technical-contracts';
import { technicalDigest } from '@allrice/database';
export function strictRepositoryMergePolicy(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('REPOSITORY_BASE_PROTECTION_REQUIRED');
  const p = raw as {
    required_status_checks?: {
      strict?: unknown;
      checks?: Array<{ context?: unknown; app_id?: unknown }>;
    };
    enforce_admins?: { enabled?: unknown };
    allow_force_pushes?: { enabled?: unknown };
    allow_deletions?: { enabled?: unknown };
  };
  const checks = p.required_status_checks?.checks;
  // The merge API compares head only. Strict up-to-date checks enforced for
  // administrators reject a concurrent base advance. Never bypass protections,
  // force-update main, install rules, or treat an unavailable rule as permission.
  if (
    p.required_status_checks?.strict !== true ||
    p.enforce_admins?.enabled !== true ||
    p.allow_force_pushes?.enabled !== false ||
    p.allow_deletions?.enabled !== false ||
    !Array.isArray(checks) ||
    repositoryRequiredChecks.some(
      (name) => !checks.some((c) => c.context === name && c.app_id === 15368),
    )
  )
    throw Error('REPOSITORY_BASE_PROTECTION_REQUIRED');
  return {
    version: 1 as const,
    kind: 'strict_protected_main' as const,
    digest: technicalDigest(raw),
  };
}
