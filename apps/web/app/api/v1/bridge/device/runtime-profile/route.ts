import {
  RuntimeLocalPythonProfileSchema,
  RuntimeLocalPdfProfileSchema,
} from '@allrice/contracts';
import {
  bridgeDeviceStatus,
  localCommandEnabled,
  reportLocalCommandProfile,
  reportLocalPythonProfile,
  reportLocalPdfProfile,
} from '@allrice/database';
import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const token = getBridgeDeviceToken(request);
    if (!token) return new Response(null, { status: 401, headers });
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, { status: 415, headers });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
    let text = '';
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        text += decoder.decode(next.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const { device } = await bridgeDeviceStatus(token);
    const value = JSON.parse(text + decoder.decode());
    const python = RuntimeLocalPythonProfileSchema.safeParse(value);
    const pdf = RuntimeLocalPdfProfileSchema.safeParse(value);
    if (!python.success && !pdf.success && !localCommandEnabled())
      return new Response(null, { status: 404, headers });
    return Response.json(
      {
        profile: pdf.success
          ? await reportLocalPdfProfile(device, pdf.data)
          : python.success
            ? await reportLocalPythonProfile(device, python.data)
            : await reportLocalCommandProfile(device, value),
      },
      { headers },
    );
  } catch {
    return Response.json(
      { code: 'PROFILE_UNAVAILABLE' },
      { status: 403, headers },
    );
  }
}
