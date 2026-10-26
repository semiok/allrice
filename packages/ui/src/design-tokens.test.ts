import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const repository = resolve(here, '../../..');
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
const upstream = resolve(repository, 'apps/web/app/dsh-upstream');
const properties = customProperties(
  generated,
  [
    stylesheet(resolve(upstream, 'design-platform.css')),
    stylesheet(resolve(upstream, 'base.css')),
  ].reduce((into, css) => customProperties(css, into), new Map()),
);
const themes = tokens.themes;
const names = [...tokenDeclarations(tokens).get('body')!].map(([n]) => n);
const color = (name: string, theme: (typeof themes)[number]) =>
  parseColor(resolveValue(`var(--ar-${name})`, properties, theme));

describe('design tokens', () => {
  it('keeps tokens.css generated from tokens.json (run pnpm design-tokens)', () => {
    expect(generated).toBe(tokensCss(tokens));
  });

  it('declares every token once with a valid name and an allowed weight', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    const weights = Object.values(tokens.font.weights);
    for (const style of tokens.font.styles)
      expect(weights, style.name).toContain(style.weight);
  });

  it('rejects a color without a value for every theme', () => {
    const broken = structuredClone(tokens);
    broken.color[0]!.value = { light: '#ffffff' };
    expect(() => tokenDeclarations(broken)).toThrow(/needs a value/);
  });

  it('is the only stylesheet that declares a token', () => {
    const declared = new Set(names.map((name) => `--ar-${name}`));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.next', 'dsh-upstream'].includes(entry.name))
            walk(path);
        } else if (
          entry.name.endsWith('.css') &&
          path !== resolve(here, 'tokens.css')
        )
          for (const [, name] of readFileSync(path, 'utf8').matchAll(
            /(--ar-[\w-]+)\s*:/g,
          ))
            if (declared.has(name!)) offenders.push(`${path}: ${name}`);
      }
    };
    walk(resolve(repository, 'apps/web'));
    walk(resolve(repository, 'packages/ui/src'));
    expect(offenders).toEqual([]);
  });

  it('resolves every token to a concrete value in every theme', () => {
    for (const theme of themes)
      for (const name of names)
        expect(
          resolveValue(`var(--ar-${name})`, properties, theme),
          `--ar-${name} (${theme.id})`,
        ).not.toContain('var(');
    for (const { name } of tokens.color)
      for (const theme of themes)
        expect(() => color(name, theme), `${name} (${theme.id})`).not.toThrow();
  });

  it('parses only well-formed sRGB colors', () => {
    expect(parseColor('rgb(236 19 19 / 8%)')).toEqual([236, 19, 19, 0.08]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    for (const bad of ['rgb(garbage)', 'rgba(0, 0, 0, -1)', 'rgb(1, 2)', 'red'])
      expect(() => parseColor(bad), bad).toThrow();
  });

  // Text 4.5:1; focus rings and icons 3:1; in every theme (spec README, 颜色).
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
      ['link', s, 4.5],
      ['focus-ring', s, 3],
      ['text-tertiary', s, 3],
    ]),
    ['success-text', 'surface', 4.5],
    ['success-text', 'surface-raised', 4.5],
    ['success-text', 'success-soft', 4.5],
    ['warning-text', 'surface', 4.5],
    ['warning-text', 'surface-raised', 4.5],
    ['warning-text', 'warning-soft', 4.5],
    ['danger-text', 'surface', 4.5],
    ['danger-text', 'surface-raised', 4.5],
    ['danger-text', 'danger-soft', 4.5],
    ['danger', 'surface', 3],
    ['text', 'info-soft', 4.5],
    ['text-on-primary', 'action-primary', 4.5],
    ['text-on-danger', 'action-danger', 4.5],
  ];
  for (const theme of themes)
    it(`meets the contrast rules in the ${theme.id} theme`, () => {
      const base = color('surface', theme);
      for (const [foreground, background, minimum] of pairs)
        expect(
          contrast(color(foreground, theme), color(background, theme), base),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(minimum);
    });
});
