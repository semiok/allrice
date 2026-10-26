/** Real Chrome: the generated tokens resolve the way the unit-test resolver says. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../apps/worker/node_modules/playwright-core/index.js';
import {
  customProperties,
  parseColor,
  resolveValue,
  tokenDeclarations,
  type DesignTokens,
} from './design-tokens.ts';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(
  readFileSync(resolve(here, 'tokens.json'), 'utf8'),
) as DesignTokens;
const names = [...tokenDeclarations(tokens).get('body')!].map(([n]) => n);
function stylesheet(path: string): string {
  return readFileSync(path, 'utf8').replace(
    /@import\s+['"](.+?)['"];/g,
    (_, file: string) => stylesheet(resolve(dirname(path), file)),
  );
}
const upstream = resolve(here, '../../../apps/web/app/dsh-upstream');
const properties = customProperties(
  readFileSync(resolve(here, 'tokens.css'), 'utf8'),
  [
    stylesheet(resolve(upstream, 'design-platform.css')),
    stylesheet(resolve(upstream, 'base.css')),
  ].reduce((into, css) => customProperties(css, into), new Map()),
);
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
    it(`follows the DSH theme switch at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.goto(origin);
        await page.locator('#probe').waitFor();
        for (const theme of tokens.themes) {
          const actual = await page.evaluate(
            ({ dark, names, colors, fonts }) => {
              document.body.toggleAttribute('data-ds-dark-theme', dark);
              const body = getComputedStyle(document.body);
              const probe = document.getElementById('probe')!;
              const used = (style: string) => {
                probe.style.cssText = style;
                return getComputedStyle(probe);
              };
              return {
                tokens: Object.fromEntries(
                  names.map((name) => [
                    name,
                    body.getPropertyValue(`--ar-${name}`),
                  ]),
                ),
                // Each color applied to a real property, as components will.
                colors: Object.fromEntries(
                  colors.map((name) => [
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
              dark: theme.dsh === 'dark',
              names,
              colors: tokens.color.map((t) => t.name),
              fonts: tokens.font.styles.map((s) => s.name),
            },
          );
          for (const name of names)
            expect(
              compact(actual.tokens[name]!),
              `--ar-${name} (${theme.id})`,
            ).toBe(
              compact(resolveValue(`var(--ar-${name})`, properties, theme)),
            );
          for (const { name } of tokens.color) {
            const expected = parseColor(
              resolveValue(`var(--ar-${name})`, properties, theme),
            );
            expect(
              close(parseColor(actual.colors[name]!), expected),
              `${name} (${theme.id}): ${actual.colors[name]} vs ${expected}`,
            ).toBe(true);
          }
          for (const style of tokens.font.styles)
            expect(actual.fonts[style.name], style.name).toEqual([
              style.size,
              style.lineHeight,
              String(style.weight),
            ]);
          expect(actual.radius).toBe('12px');
        }
      } finally {
        await page.close();
      }
    });
});
