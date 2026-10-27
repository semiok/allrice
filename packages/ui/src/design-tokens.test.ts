import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  parseColor,
  resolveValue,
  themeSelector,
  tokenDeclarations,
  tokensCss,
} from './design-tokens.ts';
import {
  generated,
  propertiesWith,
  repository,
  tokens,
  withBrandTheme,
} from './design-tokens.testing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const properties = propertiesWith(generated);
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
    expect(parseColor('rgba(37, 99, 235, 0.5)')).toEqual([37, 99, 235, 0.5]);
    expect(parseColor('rgb(100%, 0%, 50%)')).toEqual([255, 0, 127.5, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    for (const bad of [
      'rgb(garbage)',
      'rgba(0, 0, 0, -1)',
      'rgb(1, 2)',
      'red',
      // Chrome rejects these; the parser must not read them as colours.
      'rgb(21, 32 24)',
      'rgb(21 32, 24)',
      'rgb(0..1% 0 0)',
      'rgb(1.2.3 0 0)',
      'rgb(10%, 20, 30)',
      'rgb(1, 2, 3,)',
      'rgb(1 2 3 4)',
      'rgb(1 2 3 / 0.5 / 1)',
      'rgb(256 0 0)',
      'rgb(none 0 0)',
      'rgb(1e2 0 0)',
    ])
      expect(() => parseColor(bad), bad).toThrow();
  });

  it('turns a theme on by the attributes it declares', () => {
    expect(themes.map(themeSelector)).toEqual([
      'body',
      'body[data-ds-dark-theme]',
    ]);
    const broken = structuredClone(tokens);
    broken.themes[1]!.attributes = { 'data-ar-theme': 'night' };
    expect(() => tokenDeclarations(broken)).toThrow(/data-ds-dark-theme/);
    broken.themes[1]!.attributes = { 'data-ds-dark-theme': '"] body {' };
    expect(() => tokenDeclarations(broken)).toThrow(/unsupported/);
  });

  it('declares and resolves a theme added to tokens.json', () => {
    const brand = withBrandTheme(tokens, 'rgb(0, 102, 51)');
    const resolved = propertiesWith(brand.css);
    const theme = brand.tokens.themes[2]!;
    expect(brand.css).toContain('body[data-ar-theme="brand"] {');
    expect(resolveValue('var(--ar-link)', resolved, theme)).toBe(
      'rgb(0, 102, 51)',
    );
    // The existing themes resolve exactly as before.
    for (const existing of themes)
      for (const name of names)
        expect(resolveValue(`var(--ar-${name})`, resolved, existing)).toBe(
          resolveValue(`var(--ar-${name})`, properties, existing),
        );
  });

  // Text 4.5:1; icons and focus rings 3:1; in every theme (spec README, 颜色),
  // wherever tokens.json says a colour goes. Backgrounds are listed from the
  // bottom up: an opaque surface, then the fills and hover/active overlays on
  // it, so translucent ones are measured over every surface they can sit on.
  const surfaces = [
    'surface',
    'surface-raised',
    'surface-floating',
    'surface-subtle',
  ];
  const on = (...fills: string[]) => surfaces.map((s) => [s, ...fills]);
  const anyState = [...on(), ...on('surface-hover'), ...on('surface-active')];
  const reading = ['text', 'text-secondary', 'link'];
  const rules: [string[], string[][], number][] = [
    [
      [...reading, 'success-text', 'warning-text', 'danger-text'],
      anyState,
      4.5,
    ],
    [['text-tertiary', 'danger'], anyState, 3],
    // The ring is drawn outside the element, on the surface around it.
    [['focus-ring'], on(), 3],
    ...['success-soft', 'warning-soft', 'danger-soft', 'info-soft'].map(
      (soft): [string[], string[][], number] => [reading, on(soft), 4.5],
    ),
    [['success-text'], on('success-soft'), 4.5],
    [['warning-text'], on('warning-soft'), 4.5],
    [['danger-text'], on('danger-soft'), 4.5],
    [['danger'], on('danger-soft'), 3],
    [
      ['text-on-primary'],
      [
        ['surface', 'action-primary'],
        ['surface', 'action-primary-hover'],
      ],
      4.5,
    ],
    [['text-on-danger'], [['surface', 'action-danger']], 4.5],
    [['text'], [['surface', 'action-secondary']], 4.5],
  ];
  for (const theme of themes)
    it(`meets the contrast rules in the ${theme.id} theme`, () => {
      const failures: string[] = [];
      for (const [foregrounds, grounds, minimum] of rules)
        for (const foreground of foregrounds)
          for (const layers of grounds) {
            const ratio = contrast(
              color(foreground, theme),
              ...layers.map((layer) => color(layer, theme)),
            );
            if (ratio < minimum)
              failures.push(
                `${foreground} on ${layers.join(' + ')}: ${ratio.toFixed(2)}`,
              );
          }
      expect(failures).toEqual([]);
    });

  it('measures translucent fills over the surface under them', () => {
    const white = parseColor('#ffffff');
    const black = parseColor('#000000');
    const half = parseColor('rgb(0 0 0 / 50%)');
    expect(contrast(black, white)).toBeCloseTo(21);
    expect(contrast(black, white, half)).toBeLessThan(contrast(black, white));
    expect(() => contrast(black, half)).toThrow(/opaque/);
  });
});
