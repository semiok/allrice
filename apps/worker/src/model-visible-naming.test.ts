import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dshHostCapabilityInstructions } from './harness/dsh/tool-bridge.js';
import { riceToolDefinitions } from './tool-broker.js';

// MET-214, user 10-27: the desktop app is 「AllRice 助手」; delegated children
// are 「子智能体」 as in DSH web (设置 → 插件 → 子智能体). The model repeats the
// names it reads, so the text it reads must not carry the old ones.
const oldNames = /Rice Bridge|子助手|(?<![A-Za-z_.$])Bridge(?![A-Za-z_])/;
const dsh = resolve(import.meta.dirname, '../dsh');
const repository = resolve(import.meta.dirname, '../../..');

/** String literals only: identifiers such as `assistantBridge` stay. */
const literals = (source: string) =>
  source.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g) ??
  [];

async function markdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdown(path)));
    else if (entry.name.endsWith('.md'))
      out.push(`${path}\n${await readFile(path, 'utf8')}`);
  }
  return out;
}

const offenders = (texts: string[]) =>
  texts.filter((text) => oldNames.test(text)).map((t) => t.slice(0, 160));

describe('names the model reads (MET-214)', () => {
  it('Broker definitions and host instructions use 「AllRice 助手」 and 「子智能体」', () => {
    expect(
      offenders(riceToolDefinitions.map((tool) => JSON.stringify(tool))),
    ).toEqual([]);
    const host = dshHostCapabilityInstructions([
      { name: 'python.execute' },
      { name: 'workspace.export.create' },
    ]);
    expect(host).toContain('AllRice 助手');
    expect(offenders([host])).toEqual([]);
  });

  it('DSH native tool declarations and system prompt sections carry no old name', async () => {
    const files = (await readdir(dsh)).filter(
      (name) => name.endsWith('.mjs') && !name.includes('.test.'),
    );
    const texts = (
      await Promise.all(
        files.map(async (name) =>
          literals(await readFile(join(dsh, name), 'utf8')).map(
            (literal) => `${name}: ${literal}`,
          ),
        ),
      )
    ).flat();
    expect(texts.length).toBeGreaterThan(100);
    expect(offenders(texts)).toEqual([]);
    const { localFileNativeTools } = await import(
      pathToFileURL(join(dsh, 'allrice-local-file-native-tools.mjs')).href
    );
    expect(JSON.stringify(localFileNativeTools)).toContain('AllRice 助手');
  });

  it('platform Skills carry no old name', async () => {
    const texts = await markdown(join(repository, 'skills'));
    expect(texts.length).toBeGreaterThan(18);
    expect(offenders(texts)).toEqual([]);
  });
});
