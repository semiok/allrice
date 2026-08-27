/* global AbortSignal, Buffer, fetch */

import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { WebError } from '@deepseek-ai/dsh-web';
import z from '@deepseek-ai/schemastery';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export const name = 'web-search-codex';
export const inject = ['web', 'credentials'];
export const CODEX_SEARCH_PROVIDER_ID = 'codex-subscription';

export const Config = z.object({
  model: z.string().default('gpt-5.6-luna'),
  timeoutMs: z.number().step(1).min(1_000).default(60_000),
  maximumResponseBytes: z.number().step(1).min(1_024).default(2_000_000),
});

const codexCredentialKey = credentialKey('llm-pi-ai', 'openai-codex');

function toPiCredential(record) {
  if (record === undefined) return undefined;
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    };
  }
  return record.payload;
}

function toCredentialRecord(credential) {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    };
  }
  return { kind: 'grant', payload: credential };
}

function credentialStore(ctx) {
  return {
    async read(providerId) {
      if (providerId !== 'openai-codex') return undefined;
      return toPiCredential(
        await ctx.credentials.readRecord(codexCredentialKey),
      );
    },
    async list() {
      const status = await ctx.credentials.describeRecord(codexCredentialKey);
      return status.configured
        ? [
            {
              providerId: 'openai-codex',
              type: status.kind === 'grant' ? 'oauth' : 'api_key',
            },
          ]
        : [];
    },
    async modify(providerId, mutate) {
      if (providerId !== 'openai-codex') {
        throw new Error(`Unsupported credential provider ${providerId}`);
      }
      return toPiCredential(
        await ctx.credentials.modifyRecord(
          codexCredentialKey,
          async (record) => {
            const next = await mutate(toPiCredential(record));
            return next === undefined ? undefined : toCredentialRecord(next);
          },
        ),
      );
    },
    async delete(providerId) {
      if (providerId === 'openai-codex') {
        await ctx.credentials.deleteRecord(codexCredentialKey);
      }
    },
  };
}

function accountIdFromAccessToken(accessToken) {
  const encodedPayload = accessToken.split('.')[1];
  if (!encodedPayload) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
    const auth = payload?.['https://api.openai.com/auth'];
    return typeof auth?.chatgpt_account_id === 'string' &&
      auth.chatgpt_account_id.length > 0
      ? auth.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

async function boundedJson(response, maximumResponseBytes) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumResponseBytes) {
    throw new WebError(
      'Codex search response exceeded the size limit',
      'WEB_PROVIDER_ERROR',
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumResponseBytes) {
    throw new WebError(
      'Codex search response exceeded the size limit',
      'WEB_PROVIDER_ERROR',
    );
  }
  if (!response.ok) {
    throw new WebError(
      `Codex search failed with HTTP ${response.status}`,
      'WEB_PROVIDER_ERROR',
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WebError(
      'Codex search returned invalid JSON',
      'WEB_PROVIDER_ERROR',
      {
        cause: error,
      },
    );
  }
}

function normalizeSource(result) {
  if (!result || typeof result !== 'object') return undefined;
  const url = result.url ?? result.link;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  const title = result.title ?? result.name;
  const snippet = result.snippet ?? result.text ?? result.description;
  return {
    url,
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    ...(typeof snippet === 'string' && snippet.length > 0 ? { snippet } : {}),
  };
}

class CodexSearchProvider {
  id = CODEX_SEARCH_PROVIDER_ID;

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.models = createModels({ credentials: credentialStore(ctx) });
    this.models.setProvider(openaiCodexProvider());
  }

  available() {
    return true;
  }

  async search(request, signal) {
    const query = request.query.trim();
    if (!query || query.length > 2_000) {
      throw new WebError(
        'Codex search query must contain between 1 and 2000 characters',
        'WEB_PROVIDER_ERROR',
      );
    }
    const maxResults = Number.isInteger(request.maxResults)
      ? Math.min(Math.max(request.maxResults, 1), 10)
      : 5;
    const provider = this.models.getProvider('openai-codex');
    const auth = await this.models.getAuth('openai-codex');
    const accessToken = auth?.auth.apiKey;
    if (!provider || !accessToken) {
      throw new WebError(
        'Codex subscription authorization is required; connect openai-codex on the Models page',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }
    const accountId = accountIdFromAccessToken(accessToken);
    if (!accountId) {
      throw new WebError(
        'Codex subscription account could not be resolved',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      );
    }
    const baseUrl = (
      provider.baseUrl ?? 'https://chatgpt.com/backend-api'
    ).replace(/\/$/, '');
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    let response;
    try {
      response = await fetch(`${baseUrl}/codex/alpha/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          'content-type': 'application/json',
          'user-agent': 'allrice-dsh-codex-search/0.1',
        },
        body: JSON.stringify({
          id: `allrice-dsh-search-${Date.now()}`,
          model: this.config.model ?? 'gpt-5.6-luna',
          commands: {
            search_query: [{ q: query }],
            response_length: maxResults <= 3 ? 'short' : 'medium',
          },
          settings: {
            search_context_size: maxResults <= 3 ? 'low' : 'medium',
            allowed_callers: ['direct'],
            external_web_access: true,
          },
          max_output_tokens: 4_000,
        }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (combinedSignal.aborted) {
        throw new WebError('Codex search aborted', 'WEB_ABORTED', {
          cause: error,
        });
      }
      throw new WebError('Codex search request failed', 'WEB_PROVIDER_ERROR', {
        cause: error,
      });
    }
    const body = await boundedJson(
      response,
      this.config.maximumResponseBytes ?? 2_000_000,
    );
    const sources = Array.isArray(body.results)
      ? body.results.map(normalizeSource).filter(Boolean)
      : [];
    return {
      ...(typeof body.output === 'string' && body.output.length > 0
        ? { content: body.output }
        : {}),
      sources,
      truncated:
        Array.isArray(body.results) && body.results.length > sources.length,
    };
  }
}

export function apply(ctx, config) {
  ctx.web.registerSearchProvider(new CodexSearchProvider(ctx, config));
}
