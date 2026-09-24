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
  return {
    redirectUrl: data.redirectUrl,
    clientMetadata: {
      client_name: 'Allrice',
      redirect_uris: [data.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
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
    discoveryState: () => data.discovery as OAuthDiscoveryState | undefined,
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') delete data.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete data.tokens;
      if (scope === 'all' || scope === 'verifier') delete data.verifier;
      if (scope === 'all' || scope === 'discovery') delete data.discovery;
      await session.save(data);
    },
  };
}
