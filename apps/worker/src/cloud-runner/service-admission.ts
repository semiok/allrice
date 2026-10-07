import type { CloudExecutionPayload } from '@allrice/contracts';

/** Dependency preparation precedes readiness. Keep the ordinary wait unchanged;
 * only the explicit web profile can use its longer frozen preparation budget. */
export function cloudServiceAdmissionTimeout(
  payload: CloudExecutionPayload,
  deadlineAt: string,
  now = Date.now(),
) {
  const remaining = Date.parse(deadlineAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 1;
  const preparation =
    'kind' in payload &&
    payload.arguments.projectPreparation?.manager === 'pnpm' &&
    payload.arguments.projectPreparation?.resourceProfile === 'web-development'
      ? Math.min(
          660_000,
          Math.min(payload.arguments.limits.timeoutMs, 600_000) +
            (payload.arguments.background?.projectService?.readinessTimeoutMs ??
              30_000) +
            30_000,
        )
      : 120_000;
  return Math.max(1, Math.min(Math.max(120_000, preparation), remaining));
}
