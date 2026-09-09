import { expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

it.each([
  'postgres://a123@127.0.0.1:5432/allrice_b2',
  'postgres://allrice:synthetic@127.0.0.1:54329/allrice',
  'postgresql://allrice:synthetic@127.0.0.1:54329/allrice',
])('allows the exact dedicated fixture %s', (value) => {
  expect(() => assertRuntimeFixtureDatabase(new URL(value))).not.toThrow();
});
it.each([
  'postgres://a123@127.0.0.1:5432/allrice_dev',
  'postgres://a123@127.0.0.1:5432/allrice',
  'postgres://allrice@127.0.0.1:5432/allrice',
  'postgres://a123@127.0.0.1:54329/allrice_b2',
  'postgres://a123@foreign.example:5432/allrice_b2',
  'postgres://a123@127.0.0.1:5432/allrice_b2?options=-csearch_path=public',
  'postgres://a123@127.0.0.1:5432/allrice_b2#other',
  'https://a123@127.0.0.1:5432/allrice_b2',
])('denies a production, mismatched or overridden target %s', (value) => {
  expect(() => assertRuntimeFixtureDatabase(new URL(value))).toThrow(
    'Dedicated local/CI fixture database required',
  );
});
