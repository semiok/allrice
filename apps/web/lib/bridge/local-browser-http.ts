import {
  LocalBrowserHttpRequestSchema,
  LocalBrowserCaptureSchema,
  localBrowserStateMaximumBytes,
  localBrowserCaptureMaximumBytes,
  type BridgeDevice,
  type LocalBrowserHttpRequest,
  type LocalBrowserCapture,
} from '@allrice/contracts';
import { getBridgeDeviceToken } from './request.ts';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
class LocalBrowserHttpError extends Error {
  constructor(readonly status: number) {
    super('LOCAL_BROWSER_REQUEST_DENIED');
  }
}
export async function readLocalBrowserBody(
  request: Request,
  limit: number,
  mediaType: string,
) {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== mediaType)
    throw new LocalBrowserHttpError(415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new LocalBrowserHttpError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new LocalBrowserHttpError(400);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new LocalBrowserHttpError(413);
      }
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Small transport port. Every admission and receipt decision remains in the
 * shared PostgreSQL browser authority/Runtime ledger, not in an HTTP session. */
export function createLocalBrowserHttpHandler(port: {
  authenticate(token: string): Promise<{ device: BridgeDevice }>;
  execute(
    device: BridgeDevice,
    input: LocalBrowserHttpRequest,
  ): Promise<unknown | Buffer>;
  capture(
    device: BridgeDevice,
    metadata: LocalBrowserCapture,
    bytes: Buffer,
  ): Promise<{ objectId: string }>;
}) {
  return async (request: Request, capture = false): Promise<Response> => {
    let bytes: Buffer | undefined;
    try {
      const token = getBridgeDeviceToken(request);
      if (!token || token.length > 4096) throw new LocalBrowserHttpError(401);
      const { device } = await port.authenticate(token);
      if (device.revokedAt || device.status === 'revoked')
        throw new LocalBrowserHttpError(401);
      if (capture) {
        const header = request.headers.get('x-allrice-browser-capture');
        if (!header || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header))
          throw new LocalBrowserHttpError(400);
        const metadata = LocalBrowserCaptureSchema.parse(
          JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
        );
        bytes = await readLocalBrowserBody(
          request,
          localBrowserCaptureMaximumBytes,
          'application/octet-stream',
        );
        return Response.json(await port.capture(device, metadata, bytes), {
          headers,
        });
      }
      bytes = await readLocalBrowserBody(
        request,
        localBrowserStateMaximumBytes,
        'application/json',
      );
      const input = LocalBrowserHttpRequestSchema.parse(
        JSON.parse(bytes.toString('utf8')),
      );
      const result = await port.execute(device, input);
      if (input.kind === 'take_input') {
        if (
          !Buffer.isBuffer(result) ||
          result.length > localBrowserCaptureMaximumBytes
        )
          throw new LocalBrowserHttpError(503);
        try {
          return new Response(Uint8Array.from(result), {
            headers: {
              ...headers,
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment',
            },
          });
        } finally {
          result.fill(0);
        }
      }
      return Response.json(result, { headers });
    } catch (error) {
      const status =
        error instanceof LocalBrowserHttpError
          ? error.status
          : error instanceof SyntaxError ||
              (error instanceof Error && error.name === 'ZodError')
            ? 400
            : error instanceof Error &&
                ['RuntimePolicyError', 'DataAccessError'].includes(
                  error.constructor.name,
                )
              ? 403
              : 503;
      return Response.json(
        {
          error: {
            code:
              status >= 500
                ? 'LOCAL_BROWSER_UNAVAILABLE'
                : 'LOCAL_BROWSER_POLICY_DENIED',
            message: '本地浏览器操作未确认，请检查设备连接、授权和当前控制权。',
          },
        },
        { status, headers },
      );
    } finally {
      bytes?.fill(0);
    }
  };
}
