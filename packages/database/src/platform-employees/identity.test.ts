import { describe, expect, it } from 'vitest';
import { normalizeDraftPlatformPolicy } from './identity.ts';

const legacy = 'You are Rice, the default AI employee in AllRice.';

describe('employee draft identity policy', () => {
  it('removes the shipped Rice identity while retaining the complete policy suffix', () => {
    const suffix =
      '\nUse only authorized data. Never claim an action succeeded without a receipt.';
    const normalized = normalizeDraftPlatformPolicy(legacy + suffix);
    expect(normalized).not.toContain('You are Rice');
    expect(normalized).toContain(
      'Your name and role are defined by IDENTITY.md.',
    );
    expect(normalized.endsWith(suffix)).toBe(true);
    expect(normalizeDraftPlatformPolicy(normalized)).toBe(normalized);
  });

  it('handles the standalone shipped introduction', () => {
    expect(normalizeDraftPlatformPolicy(legacy)).toContain('IDENTITY.md');
  });

  it.each([
    'You are an Office assistant. Follow the tenant policy.',
    `Document example: ${legacy}`,
    `${legacy}Custom non-template text`,
  ])('preserves custom policy verbatim: %s', (policy) => {
    expect(normalizeDraftPlatformPolicy(policy)).toBe(policy);
  });
});
