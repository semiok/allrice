import type { RequestContext } from '@allrice/contracts';
import { ApprovalError } from './contract.js';
import type { ApprovalGateway } from './gateway.js';
import { ZodError } from 'zod';

/** Bound only to trusted AllRice BFF. No guest/MCP route exposes this handler. */
export function createApprovalBrowserHandler(options: {
  gateway: ApprovalGateway;
  trustedOrigin: string;
  guestOrigins: readonly string[];
  maxRequestBytes: number;
  authenticate(request: Request): Promise<RequestContext>;
  assertCsrf(request: Request, context: RequestContext): Promise<void>;
}) {
  const trusted = new URL(options.trustedOrigin);
  if (
    trusted.origin !== options.trustedOrigin ||
    !['https:', 'http:'].includes(trusted.protocol) ||
    options.guestOrigins.some(
      (origin) => new URL(origin).hostname === trusted.hostname,
    ) ||
    !Number.isSafeInteger(options.maxRequestBytes) ||
    options.maxRequestBytes < 1
  )
    throw new ApprovalError('INVALID_INPUT');
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  };
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (
        url.origin !== trusted.origin ||
        (request.headers.has('host') &&
          request.headers.get('host') !== trusted.host)
      )
        throw new ApprovalError('DENIED');
      if (
        request.method !== 'POST' ||
        ![
          '/approvals/view',
          '/approvals/decide',
          '/approvals/revoke',
          '/approvals/reconcile',
          '/approvals/attachment',
        ].includes(url.pathname) ||
        url.search ||
        url.hash
      )
        return new Response(null, { status: 404, headers });
      if (
        request.headers.get('origin') !== trusted.origin ||
        request.headers.get('sec-fetch-site') !== 'same-origin'
      )
        throw new ApprovalError('DENIED');
      if (
        request.headers.get('content-type')?.split(';')[0] !==
        'application/json'
      )
        throw new ApprovalError('INVALID_INPUT');
      const context = await options.authenticate(request);
      await options.assertCsrf(request, context);
      const reader = request.body?.getReader();
      if (!reader) throw new ApprovalError('INVALID_INPUT');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > options.maxRequestBytes) {
            await reader.cancel();
            throw new ApprovalError('LIMIT_EXCEEDED');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/approvals/attachment') {
        const file = await options.gateway.attachment(
          context,
          input,
          request.signal,
        );
        const filename = encodeURIComponent(file.filename).replace(
          /['()*]/g,
          (c) => '%' + c.charCodeAt(0).toString(16),
        );
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            ...headers,
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${filename}`,
            'content-security-policy':
              "sandbox; default-src 'none'; frame-ancestors 'none'",
          },
        });
      }
      const method = url.pathname.slice('/approvals/'.length) as
        'view' | 'decide' | 'revoke' | 'reconcile';
      return Response.json(
        await options.gateway[method](context, input, request.signal),
        { headers },
      );
    } catch (error) {
      const code =
        error instanceof ApprovalError
          ? error.code
          : error instanceof ZodError || error instanceof SyntaxError
            ? 'INVALID_INPUT'
            : 'UNAVAILABLE';
      return Response.json(
        { code },
        {
          status:
            code === 'UNAVAILABLE'
              ? 503
              : code === 'LIMIT_EXCEEDED'
                ? 413
                : code === 'INVALID_INPUT'
                  ? 400
                  : code === 'CONFLICT'
                    ? 409
                    : 403,
          headers,
        },
      );
    }
  };
}
