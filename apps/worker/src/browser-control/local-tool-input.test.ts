import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBrowserToolInputSchema } from './local-tool-input.js';
import { riceToolDefinitionsForCapabilities as toolDefinitionsForCapabilities } from '../tool-broker/definitions.js';
const base = { workspaceId: randomUUID(), profileId: randomUUID(), fence: 1 };
describe('P22 explicit local browser tool', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('requires a grant for open and preserves separate observe/act/close commands', () => {
    expect(
      LocalBrowserToolInputSchema.safeParse({
        command: 'open',
        url: 'https://example.com',
      }).success,
    ).toBe(false);
    expect(
      LocalBrowserToolInputSchema.safeParse({
        command: 'open',
        grantId: randomUUID(),
        url: 'https://example.com',
      }).success,
    ).toBe(true);
    expect(
      LocalBrowserToolInputSchema.safeParse({ command: 'observe', ...base })
        .success,
    ).toBe(true);
    expect(
      LocalBrowserToolInputSchema.safeParse({
        command: 'act',
        ...base,
        observationId: null,
        action: { type: 'observe' },
      }).success,
    ).toBe(true);
    expect(
      LocalBrowserToolInputSchema.safeParse({
        command: 'close',
        workspaceId: base.workspaceId,
        fence: 1,
      }).success,
    ).toBe(true);
  });
  it('forbids model credentials, arbitrary scripts/selectors and intercepted request fabrication', () => {
    for (const action of [
      { type: 'sensitive_fill', elementId: 'e1', inputId: randomUUID() },
      { type: 'evaluate', script: 'fetch(secret)' },
      { type: 'click', selector: 'button' },
      {
        type: 'request',
        parentOperationId: randomUUID(),
        url: 'https://example.com',
        method: 'POST',
        urlDigest: `sha256:${'a'.repeat(64)}`,
        bodyDigest: `sha256:${'b'.repeat(64)}`,
        bodyBytes: 1,
      },
    ])
      expect(
        LocalBrowserToolInputSchema.safeParse({
          command: 'act',
          ...base,
          observationId: randomUUID(),
          action,
        }).success,
      ).toBe(false);
  });
  it('is hidden without all three flags, exact frozen tool and network capability', () => {
    for (const key of [
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
    ])
      vi.stubEnv(key, '1');
    const names = () =>
      toolDefinitionsForCapabilities(
        ['network:outbound'],
        ['local.browser.workspace'],
      ).map((t) => t.name);
    expect(names()).toContain('local.browser.workspace');
    expect(
      toolDefinitionsForCapabilities(['network:outbound']).map((t) => t.name),
    ).not.toContain('local.browser.workspace');
    expect(
      toolDefinitionsForCapabilities([], ['local.browser.workspace']).map(
        (t) => t.name,
      ),
    ).not.toContain('local.browser.workspace');
    vi.stubEnv('ALLRICE_LOCAL_BROWSER_ENABLED', '0');
    expect(names()).not.toContain('local.browser.workspace');
  });
});
