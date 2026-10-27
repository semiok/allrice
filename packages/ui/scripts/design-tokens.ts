// Regenerates packages/ui/src/tokens.css from tokens.json (MET-214).
// The unit test packages/ui/src/design-tokens.test.ts fails when it is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensCss, type DesignTokens } from '../src/design-tokens.ts';

const source = fileURLToPath(new URL('../src/tokens.json', import.meta.url));
const target = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
const tokens = JSON.parse(readFileSync(source, 'utf8')) as DesignTokens;
writeFileSync(target, tokensCss(tokens));
console.log(`wrote ${target}`);
