import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpConnectionInput } from './transport.js';

/** Authentication discovery, registration, PKCE, code exchange and refresh
 * belong to the official MCP SDK used by DSH. This adapter only persists its
 * state inside the member-owned encrypted connection. */
export function managedMcpOAuthProvider(
  session: NonNullable<McpConnectionInput['oauth']>,
): OAuthClientProvider {
  const data = session.data;
  // GitHub does not support DCR or publish a complete OAuth discovery document.
  // Its documented endpoints are pinned; never send the platform secret to a
  // token endpoint supplied by an MCP challenge or discovery response.
  const githubDiscovery: OAuthDiscoveryState = {
    authorizationServerUrl: 'https://github.com',
    authorizationServerMetadata: {
      issuer: 'https://github.com',
      authorization_endpoint: 'https://github.com/login/oauth/authorize',
      token_endpoint: 'https://github.com/login/oauth/access_token',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    },
    resourceMetadata: {
      resource: 'https://api.githubcopilot.com/mcp/',
      authorization_servers: ['https://github.com'],
      scopes_supported: ['repo', 'read:org'],
    },
  };
  return {
    redirectUrl: data.redirectUrl,
    clientMetadata: {
      client_name: 'Allrice',
      redirect_uris: [data.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method:
        data.preset === 'github' ? 'client_secret_post' : 'none',
    },
    ...(data.preset === 'github'
      ? {
          async addClientAuthentication(
            headers: Headers,
            params: URLSearchParams,
            url: string | URL,
          ) {
            if (String(url) !== 'https://github.com/login/oauth/access_token')
              throw Error('MCP_OAUTH_URL_DENIED');
            const client = OAuthClientInformationSchema.parse(
              data.clientInformation,
            );
            if (!client.client_secret) throw Error('MCP_OAUTH_CLIENT_MISSING');
            params.set('client_id', client.client_id);
            params.set('client_secret', client.client_secret);
            headers.set('Accept', 'application/json');
          },
        }
      : {}),
    state: () => data.state,
    clientInformation: () =>
      data.clientInformation
        ? OAuthClientInformationSchema.parse(data.clientInformation)
        : undefined,
    async saveClientInformation(value) {
      data.clientInformation = value;
      await session.save(data);
    },
    tokens: () =>
      data.tokens ? OAuthTokensSchema.parse(data.tokens) : undefined,
    async saveTokens(value) {
      data.tokens = value;
      delete data.authorizationCode;
      delete data.authorizationUrl;
      await session.save(data, 'connected');
    },
    async redirectToAuthorization(url) {
      if (url.protocol !== 'https:' || url.username || url.password)
        throw Error('MCP_OAUTH_URL_DENIED');
      if (
        data.preset === 'github' &&
        `${url.origin}${url.pathname}` !==
          'https://github.com/login/oauth/authorize'
      )
        throw Error('MCP_OAUTH_URL_DENIED');
      data.authorizationUrl = url.href;
      await session.save(data, 'redirect');
    },
    async saveCodeVerifier(value) {
      data.verifier = value;
      await session.save(data);
    },
    codeVerifier() {
      if (!data.verifier) throw Error('MCP_OAUTH_VERIFIER_MISSING');
      return data.verifier;
    },
    async saveDiscoveryState(value) {
      data.discovery = { ...value };
      await session.save(data);
    },
    discoveryState: () =>
      data.preset === 'github'
        ? githubDiscovery
        : (data.discovery as OAuthDiscoveryState | undefined),
    async invalidateCredentials(scope) {
      if ((scope === 'all' || scope === 'client') && data.preset !== 'github')
        delete data.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete data.tokens;
      if (scope === 'all' || scope === 'verifier') delete data.verifier;
      if (scope === 'all' || scope === 'discovery') delete data.discovery;
      await session.save(data);
    },
  };
}
