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
