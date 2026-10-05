import { resolve } from 'node:path';
import { readQualityEvidenceBundle } from '@allrice/database';
import { RegressionEvidenceSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    // Recheck current platform authority on every request, before any archive IO.
    await requirePlatformAdminContext(request);
    const directory =
      process.env.ALLRICE_QUALITY_EVIDENCE_DIR ??
      resolve(process.cwd(), '.local/quality-evidence');
    return Response.json(
      RegressionEvidenceSchema.parse(
        readQualityEvidenceBundle(directory, process.env.ALLRICE_RELEASE_SHA),
      ),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
