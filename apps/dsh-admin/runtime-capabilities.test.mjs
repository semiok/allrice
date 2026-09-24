/* global Response, URL */
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeCapabilityObserver,
  readAllriceCapabilities,
} from './runtime-capabilities.mjs';
import { nativeComponentFacts } from './native-auth-bridge.mjs';

describe('DSH live capability boundary', () => {
  it('uses actual loader states, skips groups and does not export local paths/configs/errors', () => {
    const entries = [
      {
        id: 'active',
        options: { name: '@dsh/plugin', config: { secret: 'private' } },
        fiber: { state: 2 },
      },
      {
        id: 'disabled',
        options: { name: '@dsh/plugin' },
        disabled: true,
        fiber: { state: 2 },
      },
      { id: 'pending', options: { name: '@dsh/plugin' }, fiber: { state: 0 } },
      {
        id: 'failed',
        options: { id: 'local', name: '/private/path.mjs' },
        fiber: { state: 3, error: 'private' },
      },
      { id: 'future', options: { name: '@dsh/plugin' }, fiber: { state: 999 } },
      { id: 'group', options: { name: 'group', group: true } },
    ];
    const facts = nativeComponentFacts(entries);
    expect(facts.map((c) => c.state)).toEqual([
      'active',
      'disabled',
      'pending',
      'failed',
      'unknown',
    ]);
    expect(facts[3].name).toBe('local:local');
    expect(JSON.stringify(facts)).not.toContain('private');
  });

  it('expires missing native heartbeats and invalidates malformed reports', () => {
    let now = 0;
    const observer = createNativeCapabilityObserver({
      version: 'test',
      releaseSha: null,
      now: () => now,
    });
    expect(observer.read()).toBeNull();
    const message = {
      type: 'allrice/admin-native-capabilities',
      components: [{ id: 'p', name: '@dsh/p', state: 'active' }],
    };
    observer.accept(message);
    now = 19999;
    expect(observer.read().components).toHaveLength(1);
    now = 20000;
    expect(observer.read()).toBeNull();
    observer.accept(message);
    expect(observer.read()).not.toBeNull();
    expect(observer.accept({ type: 'unrelated' })).toBe(false);
    observer.accept({ ...message, credentials: 'private' });
    expect(observer.read()).toBeNull();
  });

  it('fails independently on missing config, upstream errors, invalid or excessive payloads', async () => {
    const fetchImpl = vi.fn();
    expect(
      await readAllriceCapabilities({ baseUrl: '', token: '', fetchImpl }),
    ).toEqual({ status: 'unconfigured', data: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    const options = {
      baseUrl: 'http://127.0.0.1:3000',
      token: 'synthetic-readonly-token-at-least-32-bytes',
      fetchImpl,
    };
    for (const response of [
      new Response('private', { status: 503 }),
      new Response('{}'),
      new Response('x'.repeat(65537)),
    ]) {
      fetchImpl.mockResolvedValueOnce(response);
      expect(await readAllriceCapabilities(options)).toEqual({
        status: 'unavailable',
        data: null,
      });
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/api/v1/internal/runtime-capabilities'),
      expect.objectContaining({ redirect: 'error', cache: 'no-store' }),
    );
  });
});
