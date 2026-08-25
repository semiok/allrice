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
export * from './automation.ts';
export * from './authorization.ts';
export * from './capabilities.ts';
export * from './common.ts';
export * from './employees.ts';
export * from './framework.ts';
export * from './harness.ts';
export * from './identity.ts';
export * from './queue.ts';
export * from './runs.ts';
export * from './routing.ts';
export * from './knowledge.ts';
export * from './secrets.ts';
export * from './skills.ts';
export * from './sse.ts';
export * from './storage.ts';
export * from './workspace.ts';
export * from './workflows.ts';
