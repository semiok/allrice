/* global Buffer, AbortSignal, fetch, process */
const maximumSearchResponseBytes = 2_000_000;

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

async function boundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumSearchResponseBytes) {
    await response.body?.cancel();
    throw new Error('Codex search response exceeded the 2 MB limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumSearchResponseBytes) {
    throw new Error('Codex search response exceeded the 2 MB limit');
  }
  if (!response.ok) {
    throw new Error(`Codex search failed with HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Codex search returned invalid JSON');
  }
}

export async function searchCodexWeb(models, params, signal) {
  signal.throwIfAborted();
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  if (!query || query.length > 2_000) {
    throw new TypeError('query must contain between 1 and 2000 characters');
  }
  const requestedLimit = Number(params?.maxResults ?? 5);
  const maxResults = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 10)
    : 5;
  const provider = models.getProvider('openai-codex');
  const auth = await models.getAuth('openai-codex');
  signal.throwIfAborted();
  const accessToken = auth?.auth.apiKey;
  if (!provider || !accessToken) {
    throw new Error('Codex subscription authorization is required');
  }
  const accountId = accountIdFromAccessToken(accessToken);
  if (!accountId) {
    throw new Error('Codex subscription account could not be resolved');
  }
  const baseUrl = (
    provider.baseUrl ?? 'https://chatgpt.com/backend-api'
  ).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/codex/alpha/search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      'content-type': 'application/json',
      'user-agent': 'allrice-codex-search/0.1',
    },
    body: JSON.stringify({
      id: `allrice-search-${Date.now()}`,
      model: process.env.DSH_CODEX_MODEL ?? 'gpt-6.1-sol',
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  const body = await boundedJson(response);
  if (!body || typeof body !== 'object' || typeof body.output !== 'string') {
    throw new Error('Codex search returned an invalid response');
  }
  return {
    provider: 'codex-hosted-search',
    query,
    output: body.output,
    truncated: Array.isArray(body.results) && body.results.length > maxResults,
    results: Array.isArray(body.results)
      ? body.results.slice(0, maxResults)
      : [],
  };
}
