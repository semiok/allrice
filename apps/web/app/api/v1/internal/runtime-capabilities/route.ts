import { timingSafeEqual } from 'node:crypto';
import {
  readRuntimeCapabilityResponse,
  summarizeRuntimeCapabilities,
} from '../../../../../lib/runtime-capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const token = process.env.ALLRICE_CAPABILITY_SYNC_TOKEN ?? '';
  const supplied = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  if (
    token.length < 32 ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  try {
    return Response.json(
      summarizeRuntimeCapabilities(await readRuntimeCapabilityResponse()),
      { headers },
    );
  } catch {
    return Response.json(
      { error: 'Capability status unavailable' },
      { status: 503, headers },
    );
  }
}
