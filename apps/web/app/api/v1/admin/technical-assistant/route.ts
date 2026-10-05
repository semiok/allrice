import {
  listPlatformTechnicalIssues,
  readPlatformTechnicalDiagnostics,
  capturePlatformTechnicalIssue,
} from '@allrice/database';
import { TechnicalAssistantResponseSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { platformTechnicalHealth } from '../../../../../lib/execution/platform-technical-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    const [health, workerHealth] = await Promise.all([
      platformTechnicalHealth('web'),
      platformTechnicalHealth('worker'),
    ]);
    const [diagnostics, issues] = await Promise.all([
      readPlatformTechnicalDiagnostics(context, { health, workerHealth }),
      listPlatformTechnicalIssues(context),
    ]);
    return Response.json(
      TechnicalAssistantResponseSchema.parse({ diagnostics, issues }),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403 });
    const context = await requirePlatformAdminContext(request);
    const text = await request.text();
    if (text.length > 2000) return new Response(null, { status: 413 });
    return Response.json(
      await capturePlatformTechnicalIssue(context, JSON.parse(text)),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
