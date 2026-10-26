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
const names = tokenDeclarations(tokens).light.map(([name]) => name);
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
  customProperties(readFileSync(resolve(here, 'tokens.css'), 'utf8')),
];
// esbuild re-serializes quotes; spacing is not significant either.
const compact = (value: string) =>
  value.replace(/\s+/g, '').replaceAll("'", '"');

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
        for (const theme of ['light', 'dark'] as const) {
          const actual = await page.evaluate(
            ({ dark, names }) => {
              document.body.toggleAttribute('data-ds-dark-theme', dark);
              const body = getComputedStyle(document.body);
              const probe = getComputedStyle(document.getElementById('probe')!);
              return {
                tokens: Object.fromEntries(
                  names.map((name) => [
                    name,
                    body.getPropertyValue(`--ar-${name}`),
                  ]),
                ),
                probe: {
                  background: probe.backgroundColor,
                  color: probe.color,
                  fontSize: probe.fontSize,
                  radius: probe.borderTopLeftRadius,
                },
              };
            },
            { dark: theme === 'dark', names },
          );
          for (const name of names)
            expect(
              compact(actual.tokens[name]!),
              `--ar-${name} (${theme})`,
            ).toBe(compact(resolveValue(`var(--ar-${name})`, scopes, theme)));
          expect(actual.probe).toEqual(
            theme === 'dark'
              ? {
                  background: 'rgb(35, 35, 36)',
                  color: 'rgb(249, 250, 251)',
                  fontSize: '14px',
                  radius: '12px',
                }
              : {
                  background: 'rgb(255, 255, 255)',
                  color: 'rgb(15, 17, 21)',
                  fontSize: '14px',
                  radius: '12px',
                },
          );
        }
      } finally {
        await page.close();
      }
    });
});
