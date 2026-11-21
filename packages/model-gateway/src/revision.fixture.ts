/** Real loopback HTTP and public native APIs; all credentials are synthetic. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import type { Credential } from '@earendil-works/pi-ai';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local';
import type { GatewayProvider } from './contract.ts';
import { withGatewayAuthTransaction } from './transport.ts';
import {
  closeServer,
  deferred,
  listen,
  modelBinding,
  nativeProviderFixture,
  upstreamFixture,
} from './gateway.fixture.ts';

export async function nativeRefreshFixture() {
  const arrived = deferred();
  const releaseResponse = deferred();
  const readyToSave = deferred();
  const allowSave = deferred();
  let rotated = false;
  let requestCount = 0;
  let refreshSignal: AbortSignal | undefined;
  const server = createServer((_request, response) => {
    requestCount++;
    rotated = true; // The old refresh token is now invalid at the fake issuer.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"access":"synthetic-rotated-access",');
    arrived.resolve();
    void releaseResponse.promise.then(() => {
      response.end(
        '"refresh":"synthetic-rotated-refresh","expires":4102444800000}',
      );
    });
  });
  const refreshUrl = await listen(server);
  const upstream = await upstreamFixture();
  const native = await nativeProviderFixture(upstream.url);
  const id = 'synthetic-oauth';
  const key = recordKeyFor(id);
  const initial: Credential = {
    type: 'oauth',
    access: 'synthetic-expired-access',
    refresh: 'synthetic-expired-refresh',
    expires: 0,
  };
  await native.ctx.credentials.modifyRecord(key, async () => ({
    kind: 'grant',
    payload: initial,
  }));
  const models = createModels({
    authContext: {
      async env() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    },
    credentials: {
      async read() {
        const record = await native.ctx.credentials.readRecord(key);
        return record?.kind === 'grant'
          ? (record.payload as unknown as Credential)
          : undefined;
      },
      async list() {
        return [{ providerId: id, type: 'oauth' }];
      },
      async modify(_id, mutate) {
        return withGatewayAuthTransaction(async () => {
          const result = await native.ctx.credentials.modifyRecord(
            key,
            async (record) => {
              const current =
                record?.kind === 'grant'
                  ? (record.payload as unknown as Credential)
                  : undefined;
              const next = await mutate(current);
              readyToSave.resolve();
              await allowSave.promise; // Still inside the native credential writer lock.
              return next ? { kind: 'grant', payload: next } : undefined;
            },
          );
          return result?.kind === 'grant'
            ? (result.payload as unknown as Credential)
            : undefined;
        });
      },
      async delete() {
        await native.ctx.credentials.deleteRecord(key);
      },
    },
  });
  const faux = fauxProvider({ provider: id });
  models.setProvider({
    ...faux.provider,
    auth: {
      oauth: {
        name: 'Synthetic OAuth',
        async login() {
          return initial as Extract<Credential, { type: 'oauth' }>;
        },
        async refresh(_current, signal) {
          refreshSignal = signal;
          const response = await fetch(refreshUrl + '/refresh', {
            method: 'POST',
            signal,
          });
          const value = (await response.json()) as {
            access: string;
            refresh: string;
            expires: number;
          };
          return { type: 'oauth', ...value };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  });
  const provider: GatewayProvider = {
    classify(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === refreshUrl
        ? { kind: 'auth-refresh', protocol: 'opaque' }
        : native.provider.classify(input, init);
    },
    async *stream(binding, input, signal) {
      // Public createModels.getAuth executes the real pi-ai OAuth resolution,
      // lock recheck, independent timeout and cancellation race.
      await models.getAuth(id, { signal });
      yield* native.provider.stream(binding, input, signal);
    },
  };
  return {
    provider,
    upstream,
    arrived: arrived.promise,
    readyToSave: readyToSave.promise,
    get rotated() {
      return rotated;
    },
    get requestCount() {
      return requestCount;
    },
    get refreshSignal() {
      return refreshSignal;
    },
    releaseResponse() {
      releaseResponse.resolve();
    },
    allowSave() {
      allowSave.resolve();
    },
    async persisted() {
      const document = parseCredentialsDocument(
        await readFile(native.credentialPath, 'utf8'),
        native.credentialPath,
      );
      return document.records.get(key);
    },
    async close() {
      releaseResponse.resolve();
      allowSave.resolve();
      await native.close();
      await upstream.close();
      await closeServer(server);
    },
  };
}

export async function responsesFixture(
  options: {
    codex?: boolean;
    terminal?:
      | 'completed'
      | 'max_output_tokens'
      | 'content_filter'
      | 'failed'
      | 'missing';
    tools?: boolean;
    holdFailedBody?: boolean;
    failuresBeforeSuccess?: number;
  } = {},
) {
  const requests: string[] = [];
  const closed = new Map<number, ReturnType<typeof deferred<void>>>();
  let active = 0;
  let closedCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      for await (const part of request) void part;
      requests.push(request.url!);
      active++;
      response.once('close', () => {
        active--;
        closed.get(++closedCount)?.resolve();
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, value: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
        );
      const message = {
        id: 'msg-fixture',
        type: 'message',
        role: 'assistant',
        content: [],
      };
      event('response.created', {
        response: { id: 'resp-fixture', status: 'in_progress' },
      });
      event('response.output_item.added', { output_index: 0, item: message });
      event('response.content_part.added', {
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      event('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'Synthetic response',
      });
      const completedMessage = {
        ...message,
        content: [
          { type: 'output_text', text: 'Synthetic response', annotations: [] },
        ],
      };
      event('response.output_item.done', {
        output_index: 0,
        item: completedMessage,
      });
      const output: object[] = [completedMessage];
      if (options.tools) {
        const item = {
          type: 'function_call',
          id: 'fc-fixture',
          call_id: 'call-fixture',
          name: 'lookup',
          arguments: '',
        };
        event('response.output_item.added', { output_index: 1, item });
        event('response.function_call_arguments.delta', {
          output_index: 1,
          delta: '{"q":"rice"}',
        });
        const complete = { ...item, arguments: '{"q":"rice"}' };
        event('response.output_item.done', { output_index: 1, item: complete });
        output.push(complete);
      }
      const terminal =
        options.failuresBeforeSuccess === undefined
          ? options.terminal
          : requests.length <= options.failuresBeforeSuccess
            ? 'failed'
            : 'completed';
      if (terminal !== 'missing') {
        const reason = terminal ?? 'completed';
        const status =
          reason === 'completed'
            ? 'completed'
            : reason === 'failed'
              ? 'failed'
              : 'incomplete';
        const type = options.codex ? 'response.done' : `response.${status}`;
        event(type, {
          response: {
            id: 'resp-fixture',
            status,
            output,
            ...(status === 'incomplete'
              ? { incomplete_details: { reason } }
              : {}),
            ...(status === 'failed'
              ? { error: { code: 'synthetic', message: 'synthetic refusal' } }
              : {}),
            usage: {
              input_tokens: 12,
              output_tokens: 3,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        });
      }
      if (!(terminal === 'failed' && options.holdFailedBody)) response.end();
    })().catch((error) => response.destroy(error as Error));
  });
  const url = await listen(server);
  const native = await nativeProviderFixture(url, {
    api: options.codex ? 'openai-codex-responses' : 'openai-responses',
  });
  return {
    provider: native.provider,
    binding: { ...modelBinding(), ...native.route },
    requests,
    get active() {
      return active;
    },
    whenClosed(count: number) {
      if (closedCount >= count) return Promise.resolve();
      const done = deferred();
      closed.set(count, done);
      return done.promise;
    },
    async close() {
      await native.close();
      await closeServer(server);
    },
  };
}
