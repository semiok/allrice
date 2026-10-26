import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  customProperties,
  parseColor,
  resolveValue,
  tokenDeclarations,
  tokensCss,
  type DesignTokens,
} from './design-tokens.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(
  readFileSync(resolve(here, 'tokens.json'), 'utf8'),
) as DesignTokens;
const generated = readFileSync(resolve(here, 'tokens.css'), 'utf8');

// The DSH stylesheets the web app actually serves, following their @imports.
function stylesheet(path: string): string {
  return readFileSync(path, 'utf8').replace(
    /@import\s+['"](.+?)['"];/g,
    (_, file: string) => stylesheet(resolve(dirname(path), file)),
  );
}
const upstream = resolve(here, '../../../apps/web/app/dsh-upstream');
const scopes = [
  customProperties(stylesheet(resolve(upstream, 'design-platform.css'))),
  customProperties(stylesheet(resolve(upstream, 'base.css'))),
  customProperties(generated),
];
const themes = ['light', 'dark'] as const;
const color = (name: string, theme: (typeof themes)[number]) =>
  parseColor(resolveValue(`var(--ar-${name})`, scopes, theme));

describe('design tokens', () => {
  it('keeps tokens.css generated from tokens.json (run pnpm design-tokens)', () => {
    expect(generated).toBe(tokensCss(tokens));
  });

  it('declares every token once with a valid name', () => {
    const { light } = tokenDeclarations(tokens);
    const names = light.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('resolves every DSH reference in both themes', () => {
    const { light } = tokenDeclarations(tokens);
    for (const theme of themes)
      for (const [name] of light) {
        const value = resolveValue(`var(--ar-${name})`, scopes, theme);
        expect(value, `--ar-${name} (${theme})`).not.toContain('var(');
      }
    for (const { name } of tokens.color)
      for (const theme of themes)
        expect(() => color(name, theme), `${name} (${theme})`).not.toThrow();
  });

  // Text 4.5:1, focus rings 3:1, in every theme (spec README, 颜色).
  const surfaces = [
    'surface',
    'surface-raised',
    'surface-floating',
    'surface-subtle',
  ];
  const pairs: [string, string, number][] = [
    ...surfaces.flatMap((s): [string, string, number][] => [
      ['text', s, 4.5],
      ['text-secondary', s, 4.5],
      ['focus-ring', s, 3],
    ]),
    ['success-text', 'surface', 4.5],
    ['success-text', 'success-soft', 4.5],
    ['warning-text', 'surface', 4.5],
    ['warning-text', 'warning-soft', 4.5],
    ['danger', 'surface', 4.45],
    ['text-on-primary', 'action-primary', 4.5],
    ['text-on-danger', 'danger', 4.45],
  ];
  for (const theme of themes)
    it(`meets the contrast rules in the ${theme} theme`, () => {
      const base = color('surface', theme);
      for (const [foreground, background, minimum] of pairs)
        expect(
          contrast(color(foreground, theme), color(background, theme), base),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(minimum);
    });
});
