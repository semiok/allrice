/** Real Chrome: the generated tokens resolve the way the unit-test resolver says. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../apps/worker/node_modules/playwright-core/index.js';
import {
  parseColor,
  resolveValue,
  tokenDeclarations,
  type CustomProperties,
  type DesignTokens,
} from './design-tokens.ts';
import {
  generated,
  propertiesWith,
  tokens,
  withBrandTheme,
} from './design-tokens.testing.ts';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
// esbuild re-serializes quotes; spacing is not significant either.
const compact = (value: string) =>
  value.replace(/\s+/g, '').replaceAll("'", '"');
const close = (a: number[], b: number[]) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= (i === 3 ? 0.01 : 1));

suite('design tokens in Chrome', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/design-tokens-page.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const asset = assets.get(new URL(req.url!, origin).pathname);
      if (asset) {
        res.setHeader(
          'Content-Type',
          req.url!.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        res.end(asset);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/design-tokens-page.css"><body><script type="module" src="/design-tokens-page.js"></script></body>',
        );
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../apps/worker/package.json', import.meta.url),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  for (const width of [1440, 390])
    it(`follows each theme's attributes at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.goto(origin);
        await page.locator('#probe').waitFor();
        await expectThemes(page, tokens, propertiesWith(generated));
      } finally {
        await page.close();
      }
    });

  it('turns on a theme added to tokens.json', async () => {
    const brand = withBrandTheme(tokens, 'rgb(0, 102, 51)');
    const page = await browser.newPage({
      viewport: { width: 1440, height: 800 },
    });
    try {
      await page.goto(origin);
      await page.locator('#probe').waitFor();
      await page.addStyleTag({ content: brand.css });
      await expectThemes(page, brand.tokens, propertiesWith(brand.css));
    } finally {
      await page.close();
    }
  });
});

/** Turns each theme on by its attributes and compares Chrome with the resolver. */
async function expectThemes(
  page: Page,
  set: DesignTokens,
  properties: CustomProperties,
) {
  const names = [...tokenDeclarations(set).get('body')!].map(([n]) => n);
  const switches = [
    ...new Set(set.themes.flatMap((t) => Object.keys(t.attributes))),
  ];
  for (const theme of set.themes) {
    const resolved = (name: string) =>
      resolveValue(`var(--ar-${name})`, properties, theme);
    const colors = Object.fromEntries(
      set.color.map(({ name }) => [name, resolved(name)]),
    );
    const actual = await page.evaluate(
      ({ switches, attributes, names, colors, fonts }) => {
        for (const name of switches) document.body.removeAttribute(name);
        for (const [name, value] of Object.entries(attributes))
          document.body.setAttribute(name, value);
        const body = getComputedStyle(document.body);
        const probe = document.getElementById('probe')!;
        const used = (style: string) => {
          probe.style.cssText = style;
          return getComputedStyle(probe);
        };
        return {
          tokens: Object.fromEntries(
            names.map((name) => [name, body.getPropertyValue(`--ar-${name}`)]),
          ),
          // A value Chrome rejects would fall back to the inherited colour.
          unsupported: Object.entries(colors)
            .filter(([, value]) => !CSS.supports('color', value))
            .map(([name, value]) => `${name}: ${value}`),
          // Each color applied to a real property, as components will.
          colors: Object.fromEntries(
            Object.keys(colors).map((name) => [
              name,
              used(`color: var(--ar-${name})`).color,
            ]),
          ),
          fonts: Object.fromEntries(
            fonts.map((name) => {
              const style = used(`font: var(--ar-font-${name})`);
              return [
                name,
                [style.fontSize, style.lineHeight, style.fontWeight],
              ];
            }),
          ),
          radius: used('border-radius: var(--ar-radius-md)')
            .borderTopLeftRadius,
        };
      },
      {
        switches,
        attributes: theme.attributes,
        names,
        colors,
        fonts: set.font.styles.map((s) => s.name),
      },
    );
    for (const name of names)
      expect(compact(actual.tokens[name]!), `--ar-${name} (${theme.id})`).toBe(
        compact(resolved(name)),
      );
    expect(actual.unsupported, theme.id).toEqual([]);
    for (const [name, value] of Object.entries(colors)) {
      const expected = parseColor(value);
      expect(
        close(parseColor(actual.colors[name]!), expected),
        `${name} (${theme.id}): ${actual.colors[name]} vs ${expected}`,
      ).toBe(true);
    }
    for (const style of set.font.styles)
      expect(actual.fonts[style.name], style.name).toEqual([
        style.size,
        style.lineHeight,
        String(style.weight),
      ]);
    expect(actual.radius).toBe('12px');
  }
}
