import { describe, expect, it, vi } from 'vitest';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpOAuthSession } from '@allrice/database';
import { managedMcpOAuthProvider } from './oauth.js';

describe('official preset OAuth via MCP SDK', () => {
  it('uses GitHub PKCE with a static client, pins token exchange and preserves refresh support', async () => {
    const data: McpOAuthSession = {
      state: 'synthetic-state',
      redirectUrl: 'https://allrice.test/api/v1/connections/github/callback',
      preset: 'github',
      clientInformation: {
        client_id: 'synthetic-client',
        client_secret: 'synthetic-client-secret',
      },
    };
    const provider = managedMcpOAuthProvider({ data, save: vi.fn() });
    const requests: { url: string; params: URLSearchParams }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        params: new URLSearchParams(String(init?.body)),
      });
      return Response.json({
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    };
    expect(
      await auth(provider, {
        serverUrl: 'https://api.githubcopilot.com/mcp/',
        fetchFn,
      }),
    ).toBe('REDIRECT');
    expect(requests).toEqual([]);
    const url = new URL(data.authorizationUrl!);
    expect(url.origin + url.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(url.searchParams.get('state')).toBe(data.state);
    expect(url.searchParams.get('scope')).toBe('repo read:org');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_secret')).toBeNull();
    expect(data.verifier).toBeTruthy();
    expect(
      await auth(provider, {
        serverUrl: 'https://api.githubcopilot.com/mcp/',
        authorizationCode: 'synthetic-code',
        fetchFn,
      }),
    ).toBe('AUTHORIZED');
    expect(requests[0]!.url).toBe(
      'https://github.com/login/oauth/access_token',
    );
    expect(requests[0]!.params.get('client_secret')).toBe(
      'synthetic-client-secret',
    );
    expect(requests[0]!.params.get('code_verifier')).toBe(data.verifier);
    expect(
      await auth(provider, {
        serverUrl: 'https://api.githubcopilot.com/mcp/',
        fetchFn,
      }),
    ).toBe('AUTHORIZED');
    expect(requests[1]!.params.get('grant_type')).toBe('refresh_token');
    await expect(
      provider.addClientAuthentication!(
        new Headers(),
        new URLSearchParams(),
        'https://attacker.test/token',
      ),
    ).rejects.toThrow('MCP_OAUTH_URL_DENIED');
    await provider.invalidateCredentials!('all');
    expect(data.clientInformation?.client_id).toBe('synthetic-client');
  });
  it('uses dynamic registration for Linear instead of any platform GitHub credentials', async () => {
    const data: McpOAuthSession = {
      state: 'linear-state',
      redirectUrl: 'https://tenant.test/api/v1/connections/callback',
    };
    const provider = managedMcpOAuthProvider({ data, save: vi.fn() });
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('oauth-protected-resource'))
        return Response.json({
          resource: 'https://mcp.linear.app/mcp',
          authorization_servers: ['https://mcp.linear.app'],
          scopes_supported: ['read', 'write'],
        });
      if (target.includes('oauth-authorization-server'))
        return Response.json({
          issuer: 'https://mcp.linear.app',
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      if (target.endsWith('/register')) {
        expect(JSON.parse(String(init?.body)).redirect_uris).toEqual([
          data.redirectUrl,
        ]);
        return Response.json({
          client_id: 'linear-dynamic-client',
          redirect_uris: [data.redirectUrl],
        });
      }
      throw Error('Unexpected OAuth request');
    };
    expect(
      await auth(provider, {
        serverUrl: 'https://mcp.linear.app/mcp',
        fetchFn,
      }),
    ).toBe('REDIRECT');
    expect(calls).toContain('https://mcp.linear.app/register');
    expect(new URL(data.authorizationUrl!).origin).toBe(
      'https://mcp.linear.app',
    );
    expect(data.clientInformation).toEqual({
      client_id: 'linear-dynamic-client',
      redirect_uris: [data.redirectUrl],
    });
  });
});
