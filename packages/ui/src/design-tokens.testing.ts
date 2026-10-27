// Shared by the design token unit and Chrome tests (MET-214).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  customProperties,
  tokensCss,
  type CustomProperties,
  type DesignTokens,
} from './design-tokens.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(here, '../../..');

export const tokens = JSON.parse(
  readFileSync(resolve(here, 'tokens.json'), 'utf8'),
) as DesignTokens;
export const generated = readFileSync(resolve(here, 'tokens.css'), 'utf8');

// The DSH stylesheets the web app actually serves, following their @imports.
function stylesheet(path: string): string {
  return readFileSync(path, 'utf8').replace(
    /@import\s+['"](.+?)['"];/g,
    (_, file: string) => stylesheet(resolve(dirname(path), file)),
  );
}
const upstream = resolve(repository, 'apps/web/app/dsh-upstream');

/** DSH's custom properties plus the given token CSS, as the resolver sees them. */
export function propertiesWith(css: string): CustomProperties {
  return customProperties(
    css,
    [
      stylesheet(resolve(upstream, 'design-platform.css')),
      stylesheet(resolve(upstream, 'base.css')),
    ].reduce((into, sheet) => customProperties(sheet, into), new Map()),
  );
}

/** tokens.json plus a third, light-based theme with its own link colour. */
export function withBrandTheme(source: DesignTokens, link: string) {
  const extended = structuredClone(source);
  extended.themes.push({
    id: 'brand',
    name: '品牌（测试用）',
    attributes: { 'data-ar-theme': 'brand' },
    dsh: 'light',
  });
  for (const color of extended.color)
    if (typeof color.value !== 'string')
      color.value.brand = color.name === 'link' ? link : color.value.light!;
  return { tokens: extended, css: tokensCss(extended) };
}
