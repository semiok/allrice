import {
  LocalBrowserCaptureSchema,
  LocalBrowserClaimSchema,
  LocalBrowserHeartbeatSchema,
  LocalBrowserHttpRequestSchema,
  LocalBrowserNextSchema,
  LocalBrowserRequestApprovalSchema,
  LocalBrowserStartSchema,
  UuidSchema,
  localBrowserCaptureMaximumBytes,
  type LocalBrowserCapture,
  type LocalBrowserClaim,
  type LocalBrowserHttpRequest,
  type LocalBrowserOperation,
} from '@allrice/contracts';

export const localBrowserEndpoint = '/api/v1/bridge/browser-workspaces';
export class LocalBrowserTransportError extends Error {
  constructor(readonly status: number) {
    super('LOCAL_BROWSER_AUTHORITY_UNAVAILABLE');
  }
}
type RequestOf<K extends LocalBrowserHttpRequest['kind']> = Extract<
  LocalBrowserHttpRequest,
  { kind: K }
>;
export interface LocalBrowserAuthority {
  claim: (
    controllerId: string,
    acceptWork: boolean,
    acceptPreview?: boolean,
    signal?: AbortSignal,
  ) => Promise<LocalBrowserClaim>;
  heartbeat: (
    request: RequestOf<'heartbeat'>,
  ) => Promise<ReturnType<typeof LocalBrowserHeartbeatSchema.parse>>;
  next: (
    request: RequestOf<'next'>,
    signal?: AbortSignal,
  ) => Promise<LocalBrowserOperation | null>;
  start: (
    request: RequestOf<'start'>,
  ) => Promise<ReturnType<typeof LocalBrowserStartSchema.parse>>;
  acknowledge: (
    request: RequestOf<
      | 'receipt'
      | 'observation'
      | 'control_ack'
      | 'stopped'
      | 'revoke_ack'
      | 'request_complete'
    >,
    signal?: AbortSignal,
  ) => Promise<void>;
  requestPermission: (
    request: RequestOf<'request_approval' | 'request_status'>,
  ) => Promise<ReturnType<typeof LocalBrowserRequestApprovalSchema.parse>>;
  takeInput: (
    request: RequestOf<'take_input'>,
    maximumBytes: number,
  ) => Promise<Buffer>;
  capture: (metadata: LocalBrowserCapture, bytes: Buffer) => Promise<string>;
}
async function bounded(response: Response, maximum: number) {
  const reader = response.body?.getReader();
  const parts: Buffer[] = [];
  let bytes = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        void reader.cancel().catch(() => undefined);
        throw Error();
      }
      parts.push(Buffer.from(next.value));
    }
    return Buffer.concat(parts);
  } finally {
    reader?.releaseLock();
  }
}
/** Private device-authenticated port, with no redirects or unbounded responses.
 * Browser site requests never share this fetch/token or the SaaS authority URL. */
export class LocalBrowserHttpAuthority implements LocalBrowserAuthority {
  private previewUnsupported = false;
  constructor(private readonly input: { server: string; token: string }) {
    const url = new URL(input.server);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
      )
    )
      throw new LocalBrowserTransportError(0);
  }
  private async exchange(
    path: string,
    body: string | Buffer,
    headers: Record<string, string>,
    maximum: number,
    signal?: AbortSignal,
  ) {
    let status = 0;
    const abort = new AbortController();
    let rejectAborted!: () => void;
    const canceled = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(new LocalBrowserTransportError(status));
    });
    const stop = () => {
      abort.abort();
      rejectAborted();
    };
    // Bound the complete exchange, including body reads/cancellation. A fetch
    // stream that fails to settle after abort must not hold Bridge shutdown.
    const deadline = setTimeout(stop, 2500);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted();
      return await Promise.race([
        (async () => {
          const response = await fetch(new URL(path, this.input.server), {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${this.input.token}`,
              ...headers,
            },
            body: typeof body === 'string' ? body : new Uint8Array(body),
            signal: abort.signal,
          });
          status = response.status;
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw Error();
          }
          return bounded(response, maximum);
        })(),
        canceled,
      ]);
    } catch {
      throw new LocalBrowserTransportError(status);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', stop);
      abort.abort();
    }
  }
  private async json(request: LocalBrowserHttpRequest, signal?: AbortSignal) {
    try {
      const validated = LocalBrowserHttpRequestSchema.parse(request);
      const wire =
        validated.kind === 'claim' && !validated.acceptPreview
          ? {
              kind: validated.kind,
              controllerId: validated.controllerId,
              acceptWork: validated.acceptWork,
            }
          : validated;
      const response = await this.exchange(
        localBrowserEndpoint,
        JSON.stringify(wire),
        { 'content-type': 'application/json' },
        256 * 1024,
        signal,
      );
      return JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(response),
      ) as unknown;
    } catch (error) {
      if (error instanceof LocalBrowserTransportError) throw error;
      throw new LocalBrowserTransportError(0);
    }
  }
  async claim(
    controllerId: string,
    acceptWork: boolean,
    acceptPreview = false,
    signal?: AbortSignal,
  ) {
    const preview = acceptPreview && !this.previewUnsupported;
    try {
      return LocalBrowserClaimSchema.parse(
        await this.json(
          { kind: 'claim', controllerId, acceptWork, acceptPreview: preview },
          signal,
        ),
      );
    } catch (error) {
      // Strict P22 servers reject the new optional capability before admission.
      // Fall back only to an ordinary claim; never execute a preview elsewhere.
      if (
        signal?.aborted ||
        !preview ||
        !(error instanceof LocalBrowserTransportError) ||
        error.status !== 400
      )
        throw error;
      this.previewUnsupported = true;
      return LocalBrowserClaimSchema.parse(
        await this.json(
          { kind: 'claim', controllerId, acceptWork, acceptPreview: false },
          signal,
        ),
      );
    }
  }
  async heartbeat(request: RequestOf<'heartbeat'>) {
    return LocalBrowserHeartbeatSchema.parse(await this.json(request));
  }
  async next(request: RequestOf<'next'>, signal?: AbortSignal) {
    return LocalBrowserNextSchema.parse(await this.json(request, signal))
      .operation;
  }
  async start(request: RequestOf<'start'>) {
    return LocalBrowserStartSchema.parse(await this.json(request));
  }
  async requestPermission(
    request: RequestOf<'request_approval' | 'request_status'>,
  ) {
    return LocalBrowserRequestApprovalSchema.parse(await this.json(request));
  }
  async acknowledge(
    request: RequestOf<
      | 'receipt'
      | 'observation'
      | 'control_ack'
      | 'stopped'
      | 'revoke_ack'
      | 'request_complete'
    >,
    signal?: AbortSignal,
  ) {
    const value = await this.json(request, signal);
    if (
      !value ||
      typeof value !== 'object' ||
      !('ok' in value) ||
      value.ok !== true
    )
      throw new LocalBrowserTransportError(0);
  }
  async takeInput(request: RequestOf<'take_input'>, maximumBytes: number) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 2_000_000
    )
      throw new LocalBrowserTransportError(0);
    return this.exchange(
      localBrowserEndpoint,
      JSON.stringify(LocalBrowserHttpRequestSchema.parse(request)),
      { 'content-type': 'application/json' },
      maximumBytes,
    );
  }
  async capture(metadata: LocalBrowserCapture, bytes: Buffer) {
    if (bytes.length > localBrowserCaptureMaximumBytes)
      throw new LocalBrowserTransportError(0);
    const value = await this.exchange(
      `${localBrowserEndpoint}/capture`,
      bytes,
      {
        'content-type': 'application/octet-stream',
        'x-allrice-browser-capture': Buffer.from(
          JSON.stringify(LocalBrowserCaptureSchema.parse(metadata)),
        ).toString('base64url'),
      },
      4096,
    );
    try {
      return UuidSchema.parse(JSON.parse(value.toString('utf8')).objectId);
    } catch {
      throw new LocalBrowserTransportError(0);
    }
  }
}
