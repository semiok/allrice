#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderDistributionFacts } from './dsh-distribution-facts.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.length > 1)
  throw Error('DSH_DISTRIBUTION_GENERATOR_ARGUMENT');
const distribution = JSON.parse(
  await readFile(resolve(root, 'apps/worker/dsh/distribution.json'), 'utf8'),
);
const output = resolve(
  root,
  'packages/contracts/src/dsh-distribution.generated.ts',
);
// Use the same formatter as format:check so the generated file is committed verbatim.
const { format } = await import('prettier');
const text = await format(renderDistributionFacts(distribution), {
  filepath: output,
  singleQuote: true,
});
if (args.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== text)
    throw Error('DSH_DISTRIBUTION_FACTS_STALE');
} else await writeFile(output, text);
