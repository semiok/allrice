import { describe, expect, it } from 'vitest';
import { normalizeDraftPlatformPolicy } from './identity.ts';

const legacy = 'You are Rice, the default AI employee in AllRice.';
const previousPlatform =
  'You are an AI employee in AllRice. Your name and role are defined by IDENTITY.md.';

describe('employee draft identity policy', () => {
  it.each([legacy, previousPlatform])(
    'normalizes only the shipped introduction while retaining its complete suffix: %s',
    (introduction) => {
      const suffix =
        '\nUse only authorized data. Never claim an action succeeded without a receipt.';
      const normalized = normalizeDraftPlatformPolicy(introduction + suffix);
      expect(normalized).not.toContain('You are Rice');
      expect(normalized).toContain(
        'Your name and role are defined by PERSONA.md.',
      );
      expect(normalized.endsWith(suffix)).toBe(true);
      expect(normalizeDraftPlatformPolicy(normalized)).toBe(normalized);
    },
  );

  it.each([legacy, previousPlatform])(
    'handles the standalone shipped introduction: %s',
    (introduction) => {
      expect(normalizeDraftPlatformPolicy(introduction)).toContain(
        'PERSONA.md',
      );
    },
  );

  it.each([
    'You are an Office assistant. Follow the tenant policy.',
    `Document example: ${legacy}`,
    `${legacy}Custom non-template text`,
    `Document example: ${previousPlatform}`,
    `${previousPlatform}Custom non-template text`,
    `  ${previousPlatform}`,
    'Your name and role are defined by IDENTITY.md.',
  ])('preserves custom policy verbatim: %s', (policy) => {
    expect(normalizeDraftPlatformPolicy(policy)).toBe(policy);
  });
});
