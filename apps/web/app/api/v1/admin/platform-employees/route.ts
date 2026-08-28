import {
  listPlatformEmployees,
  listPlatformEmployeeWorkspaces,
  listPlatformNativeSkills,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    const [employees, skills, workspaces] = await Promise.all([
      listPlatformEmployees(),
      listPlatformNativeSkills(),
      listPlatformEmployeeWorkspaces(),
    ]);
    return Response.json({ employees, skills, workspaces });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
