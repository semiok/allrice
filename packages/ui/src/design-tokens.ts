// AllRice design tokens (MET-214): tokens.json is the only source. A value
// starting with `--` names a DSH variable, `{name}` names another token, and
// anything else is an AllRice literal. Everything is declared on `body`,
// where DSH declares its theme aliases, so each var() resolves per theme.

type ThemeValue = string | { light: string; dark: string };
type Named = { name: string; value: string; usage: string };

export interface DesignTokens {
  color: { name: string; value: ThemeValue; usage: string }[];
  font: {
    families: Record<string, string>;
    weights: Record<string, number>;
    styles: {
      name: string;
      family: string;
      size: string;
      lineHeight: string;
      weight: number;
      usage: string;
    }[];
  };
  space: Named[];
  radius: Named[];
  shadow: Named[];
  motion: Named[];
}

export const darkSelector = 'body[data-ds-dark-theme]';

function cssValue(value: string) {
  if (value.startsWith('--')) return `var(${value})`;
  const alias = /^\{([\w-]+)\}$/.exec(value);
  return alias ? `var(--ar-${alias[1]})` : value;
}

export function tokenDeclarations(tokens: DesignTokens) {
  const light: [string, string][] = [];
  const dark: [string, string][] = [];
  for (const { name, value } of tokens.color) {
    if (typeof value === 'string') light.push([name, cssValue(value)]);
    else {
      light.push([name, cssValue(value.light)]);
      dark.push([name, cssValue(value.dark)]);
    }
  }
  const { families, weights, styles } = tokens.font;
  for (const [name, value] of Object.entries(families))
    light.push([`font-family-${name}`, cssValue(value)]);
  for (const [name, value] of Object.entries(weights))
    light.push([`font-weight-${name}`, String(value)]);
  for (const s of styles)
    light.push([
      `font-${s.name}`,
      `${s.weight} ${s.size}/${s.lineHeight} var(--ar-font-family-${s.family})`,
    ]);
  for (const group of [
    tokens.space,
    tokens.radius,
    tokens.shadow,
    tokens.motion,
  ])
    for (const { name, value } of group) light.push([name, cssValue(value)]);
  return { light, dark };
}

export function tokensCss(tokens: DesignTokens) {
  const { light, dark } = tokenDeclarations(tokens);
  const block = (selector: string, entries: [string, string][]) =>
    `${selector} {\n${entries.map(([name, value]) => `  --ar-${name}: ${value};\n`).join('')}}\n`;
  return [
    '/* Generated from tokens.json by `pnpm design-tokens`. Do not edit. */\n',
    block('body', light),
    block(darkSelector, dark),
  ].join('\n');
}

/** Custom properties a stylesheet declares on :root, body and dark body. */
export function customProperties(css: string) {
  const scopes = {
    root: new Map<string, string>(),
    light: new Map<string, string>(),
    dark: new Map<string, string>(),
  };
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const targets = selectors!
      .split(',')
      .map((selector) => selector.trim())
      .map((selector) =>
        selector === ':root'
          ? scopes.root
          : selector === 'body'
            ? scopes.light
            : selector === darkSelector
              ? scopes.dark
              : null,
      );
    for (const declaration of body!.split(';')) {
      const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
      if (match)
        for (const target of targets) target?.set(match[1]!, match[2]!);
    }
  }
  return scopes;
}

/** Substitutes var() the way a browser does on body for one theme. */
export function resolveValue(
  value: string,
  scopes: ReturnType<typeof customProperties>[],
  theme: 'light' | 'dark',
  depth = 0,
): string {
  const start = value.indexOf('var(');
  if (start < 0) return value;
  if (depth > 20) throw Error(`var() cycle in ${value}`);
  let end = start + 4;
  for (let open = 1; open > 0; end += 1) {
    if (end >= value.length) throw Error(`unbalanced var() in ${value}`);
    if (value[end] === '(') open += 1;
    if (value[end] === ')') open -= 1;
  }
  const inner = value.slice(start + 4, end - 1);
  const comma = inner.indexOf(',');
  const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
  const lookup = (scope: ReturnType<typeof customProperties>) =>
    (theme === 'dark' ? scope.dark.get(name) : undefined) ??
    scope.light.get(name) ??
    scope.root.get(name);
  const found = scopes.map(lookup).findLast((v) => v !== undefined);
  const replacement =
    found ?? (comma < 0 ? undefined : inner.slice(comma + 1).trim());
  if (replacement === undefined) throw Error(`${name} is not defined`);
  return resolveValue(
    value.slice(0, start) +
      resolveValue(replacement, scopes, theme, depth + 1) +
      value.slice(end),
    scopes,
    theme,
    depth + 1,
  );
}

type Rgba = [number, number, number, number];

export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex)
    return [0, 2, 4]
      .map((i) => parseInt(hex[1]!.slice(i, i + 2), 16))
      .concat(1) as Rgba;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!rgb) throw Error(`not an sRGB color: ${value}`);
  const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean);
  const alpha = parts[3]
    ? parts[3].endsWith('%')
      ? parseFloat(parts[3]) / 100
      : parseFloat(parts[3])
    : 1;
  return [...parts.slice(0, 3).map(Number), alpha] as Rgba;
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba) {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast of a foreground on a background laid over an opaque base. */
export function contrast(foreground: Rgba, background: Rgba, base: Rgba) {
  const ground = over(background, base);
  const [a, b] = [luminance(over(foreground, ground)), luminance(ground)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
