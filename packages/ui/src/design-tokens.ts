// AllRice design tokens (MET-214): tokens.json is the only source. A value
// starting with `--` names a DSH variable, `{name}` names another token, and
// anything else is an AllRice literal. Everything is declared on `body`,
// where DSH declares its theme aliases, so each var() resolves per theme and
// descendants inherit the resolved value: override --ar-*, not --dsw-*.

type Named = { name: string; value: string; usage: string };

export interface ThemeDefinition {
  id: string;
  name: string;
  /** Attributes set on <body> to turn the theme on ("" = present). */
  attributes: Record<string, string>;
  /** The DSH mode whose aliases this theme sits on. */
  dsh: 'light' | 'dark';
}

export interface DesignTokens {
  themes: ThemeDefinition[];
  color: {
    name: string;
    value: string | Record<string, string>;
    usage: string;
  }[];
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
  line: Named[];
}

const dshDark = 'data-ds-dark-theme';
const dshSelectors = { light: 'body', dark: `body[${dshDark}]` };

/** The selector a theme's tokens are declared on, from its attributes. */
export function themeSelector({
  attributes,
}: Pick<ThemeDefinition, 'attributes'>) {
  return `body${Object.entries(attributes)
    .map(([name, value]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !/^[\w-]*$/.test(value))
        throw Error(`unsupported theme attribute ${name}="${value}"`);
      return value === '' ? `[${name}]` : `[${name}="${value}"]`;
    })
    .join('')}`;
}

function cssValue(value: string) {
  if (value.startsWith('--')) return `var(${value})`;
  const alias = /^\{([\w-]+)\}$/.exec(value);
  return alias ? `var(--ar-${alias[1]})` : value;
}

/** Declarations per theme selector; the first theme carries every token. */
export function tokenDeclarations(tokens: DesignTokens) {
  const [base, ...others] = tokens.themes;
  if (!base || themeSelector(base) !== 'body')
    throw Error('the first theme must be declared on body');
  // The attributes must also switch DSH's own aliases to the theme's mode.
  for (const theme of tokens.themes) {
    const setsDark = Object.hasOwn(theme.attributes, dshDark);
    if (setsDark !== (theme.dsh === 'dark'))
      throw Error(
        `${theme.id}: ${dshDark} must be set exactly when dsh is dark`,
      );
  }
  const blocks = new Map<string, [string, string][]>(
    tokens.themes.map((theme) => [themeSelector(theme), []]),
  );
  if (blocks.size !== tokens.themes.length)
    throw Error('two themes share a selector');
  const add = (theme: ThemeDefinition, name: string, value: string) =>
    blocks.get(themeSelector(theme))!.push([name, cssValue(value)]);
  for (const { name, value } of tokens.color) {
    if (typeof value === 'string') add(base, name, value);
    else {
      const ids = Object.keys(value).sort().join();
      const expected = tokens.themes
        .map((theme) => theme.id)
        .sort()
        .join();
      if (ids !== expected)
        throw Error(`${name} needs a value for each theme: ${expected}`);
      add(base, name, value[base.id]!);
      for (const theme of others) add(theme, name, value[theme.id]!);
    }
  }
  const { families, weights, styles } = tokens.font;
  for (const [name, value] of Object.entries(families))
    add(base, `font-family-${name}`, value);
  for (const [name, value] of Object.entries(weights))
    add(base, `font-weight-${name}`, String(value));
  for (const s of styles)
    add(
      base,
      `font-${s.name}`,
      `${s.weight} ${s.size}/${s.lineHeight} var(--ar-font-family-${s.family})`,
    );
  for (const group of [
    tokens.space,
    tokens.radius,
    tokens.shadow,
    tokens.motion,
    tokens.line,
  ])
    for (const { name, value } of group) add(base, name, value);
  return blocks;
}

export function tokensCss(tokens: DesignTokens) {
  const blocks = [...tokenDeclarations(tokens)].map(
    ([selector, entries]) =>
      `${selector} {\n${entries.map(([name, value]) => `  --ar-${name}: ${value};\n`).join('')}}\n`,
  );
  return [
    '/* Generated from tokens.json by `pnpm design-tokens`. Do not edit. */\n',
    ...blocks,
  ].join('\n');
}

export type CustomProperties = Map<string, Map<string, string>>;

/** Custom properties per selector, for the simple selectors tokens rely on. */
export function customProperties(
  css: string,
  into: CustomProperties = new Map(),
) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@media|@supports|@layer/.test(source))
    throw Error('conditional rules are not modelled by the token resolver');
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    for (const selector of selectors!.split(',').map((s) => s.trim()))
      for (const declaration of body!.split(';')) {
        const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
        if (!match) continue;
        // Later stylesheets win between equal selectors, as in the cascade.
        if (!into.has(selector)) into.set(selector, new Map());
        into.get(selector)!.set(match[1]!, match[2]!);
      }
  return into;
}

/** Substitutes var() as a browser computes it on <body> for one theme. */
export function resolveValue(
  value: string,
  properties: CustomProperties,
  theme: Pick<ThemeDefinition, 'attributes' | 'dsh'>,
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
  // A body declaration beats one inherited from :root, and the more specific
  // theme selector beats plain body.
  const order = [
    themeSelector(theme),
    dshSelectors[theme.dsh],
    dshSelectors.light,
    ':root',
  ];
  const found = order
    .map((selector) => properties.get(selector)?.get(name))
    .find((v) => v !== undefined);
  const replacement =
    found ?? (comma < 0 ? undefined : inner.slice(comma + 1).trim());
  if (replacement === undefined) throw Error(`${name} is not defined`);
  return resolveValue(
    value.slice(0, start) +
      resolveValue(replacement, properties, theme, depth + 1) +
      value.slice(end),
    properties,
    theme,
    depth + 1,
  );
}

type Rgba = [number, number, number, number];

// A strict subset of CSS Color 4 rgb()/rgba(): commas between all values, or
// spaces with an optional "/ alpha"; the three channels all numbers or all
// percentages; unsigned plain decimals. `none`, exponents, out-of-range values
// and other notations throw rather than guess what a browser would do.
const decimal = String.raw`(?:\d+(?:\.\d+)?|\.\d+)%?`;
const legacyRgb = new RegExp(
  String.raw`^rgba?\(\s*(${decimal})\s*,\s*(${decimal})\s*,\s*(${decimal})\s*(?:,\s*(${decimal})\s*)?\)$`,
);
const modernRgb = new RegExp(
  String.raw`^rgba?\(\s*(${decimal})\s+(${decimal})\s+(${decimal})\s*(?:\/\s*(${decimal})\s*)?\)$`,
);

/** Opaque or translucent sRGB in the notations the tokens use; anything else throws. */
export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits =
      hex[1]!.length === 3
        ? [...hex[1]!].map((c) => c + c)
        : hex[1]!.match(/../g)!;
    return [...digits.map((pair) => parseInt(pair, 16)), 1] as Rgba;
  }
  const parts = (legacyRgb.exec(text) ?? modernRgb.exec(text))?.slice(1);
  if (
    !parts ||
    new Set(parts.slice(0, 3).map((p) => p!.endsWith('%'))).size > 1
  )
    throw Error(`not an sRGB color: ${value}`);
  const number = (part: string, max: number) => {
    const n = part.endsWith('%')
      ? (Number(part.slice(0, -1)) / 100) * max
      : Number(part);
    if (n > max) throw Error(`out of range in ${value}`);
    return n;
  };
  return [
    number(parts[0]!, 255),
    number(parts[1]!, 255),
    number(parts[2]!, 255),
    parts[3] === undefined ? 1 : number(parts[3], 1),
  ];
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

/**
 * WCAG contrast of a foreground on stacked backgrounds, listed from the
 * bottom up: an opaque surface, then any translucent fills on it.
 */
export function contrast(foreground: Rgba, ...backgrounds: Rgba[]) {
  const [base, ...fills] = backgrounds;
  if (!base || base[3] !== 1)
    throw Error('the bottom background must be opaque');
  const ground = fills.reduce((below, fill) => over(fill, below), base);
  const [a, b] = [luminance(over(foreground, ground)), luminance(ground)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
