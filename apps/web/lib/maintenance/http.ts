import {
  MaintenanceConflict,
  type MaintenanceInstallationIdentity,
} from '@allrice/database';
import { executionErrorResponse } from '../execution/responses';
export const maintenanceHttpHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export function maintenanceInstallation(
  request: Request,
): MaintenanceInstallationIdentity {
  const authorization = request.headers.get('authorization');
  return {
    deploymentId: request.headers.get('x-allrice-deployment-id') ?? '',
    installationKey: authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '',
  };
}
export function maintenanceErrorResponse(error: unknown) {
  if (error instanceof MaintenanceConflict)
    return Response.json(
      { error: 'maintenance_report_conflict' },
      { status: 409, headers: maintenanceHttpHeaders },
    );
  return executionErrorResponse(error);
}
