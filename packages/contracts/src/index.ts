export type ServiceName = 'web' | 'worker';
export type HealthStatus = 'live' | 'ready' | 'not_ready';

export interface HealthResponse {
  service: ServiceName;
  status: HealthStatus;
  version: '0.1.0';
  timestamp: string;
  detail?: string;
}

export function makeHealthResponse(
  service: ServiceName,
  status: HealthStatus,
  detail?: string,
): HealthResponse {
  return {
    service,
    status,
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
}

export * from './api.ts';
export * from './task-native-wait.ts';
export * from './automation.ts';
export * from './authorization.ts';
export * from './tenant-administration.ts';
export * from './employee-tool-catalog.ts';
export * from './bridge.ts';
export * from './capabilities.ts';
export * from './chatflow.ts';
export * from './common.ts';
export * from './employees.ts';
export * from './experience.ts';
export * from './employee-model-settings.ts';
export * from './framework.ts';
export * from './governance.ts';
export * from './harness.ts';
export * from './identity.ts';
export * from './queue.ts';
export * from './runs.ts';
export * from './runtime-v2/index.ts';
export * from './routing.ts';
export * from './saas.ts';
export * from './knowledge.ts';
export * from './models.ts';
export * from './operations.ts';
export * from './provider-auth.ts';
export * from './platform-employees.ts';
export * from './quality.ts';
export * from './secrets.ts';
export * from './skills.ts';
export * from './skill-bundle.ts';
export * from './mcp.ts';
export * from './mcp-schema.ts';
export * from './local-mcp.ts';
export * from './sse.ts';
export * from './storage.ts';
export * from './tool-manifest.ts';
export * from './user-questions.ts';
export * from './workspace.ts';
export * from './workflows.ts';
export * from './assistant.ts';
export * from './development-cooperation.ts';
export * from './assistant-pricing.ts';
export * from './codex-subscription-quota.ts';
export * from './assistant-subscription.ts';
export type { RuntimeRunUsage } from './runtime-run-usage.js';
export type { TaskRuntimeTiming } from './task-runtime-timing.js';
export * from './workspace-readiness.ts';
export * from './user-monthly-quota.ts';
export * from './tenant-quotas.ts';
export * from './tenant-validation.ts';
export * from './tenant-environments.ts';
