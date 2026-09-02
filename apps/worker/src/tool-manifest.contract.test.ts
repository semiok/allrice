import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { allRiceToolManifest } from '@allrice/contracts';
import { describe, expect, it } from 'vitest';

import {
  dshBrokerNativeToolNames,
  dshNativeToolNames,
  dshNativeWireNames,
} from './harness/dsh-adapter.js';
import {
  riceToolCapability,
  riceToolDefinitions,
  riceToolRisk,
} from './tool-broker.js';

describe('AllRice worker tool manifest contract', () => {
  it('keeps Tool Broker definitions and policy metadata aligned', () => {
    expect(riceToolDefinitions.map((tool) => tool.name)).toEqual(
      allRiceToolManifest.map((tool) => tool.canonicalName),
    );

    for (const tool of allRiceToolManifest) {
      expect(riceToolCapability(tool.canonicalName)).toBe(tool.capability);
      expect(riceToolRisk(tool.canonicalName)).toBe(tool.risk);
    }
  });

  it('derives the complete DSH native boundary and wire map', () => {
    const expectedNativeTools = allRiceToolManifest.filter(
      (tool) => tool.transport !== 'envelope',
    );
    const expectedBrokerNativeTools = allRiceToolManifest.filter(
      (tool) => tool.transport === 'dsh_broker_native',
    );
    const expectedWireMap = Object.fromEntries(
      expectedNativeTools.map((tool) => [tool.dshWireName, tool.canonicalName]),
    );

    expect([...dshNativeToolNames]).toEqual(
      expectedNativeTools.map((tool) => tool.canonicalName),
    );
    expect([...dshBrokerNativeToolNames]).toEqual(
      expectedBrokerNativeTools.map((tool) => tool.canonicalName),
    );
    expect(dshNativeWireNames).toEqual(expectedWireMap);
  });

  it('keeps the DSH runtime broker-native registrations aligned', async () => {
    const runtimeSource = await readFile(
      resolve(import.meta.dirname, '../dsh/allrice-jsonrpc-runtime.mjs'),
      'utf8',
    );
    const brokerNativeBlock = runtimeSource.slice(
      runtimeSource.indexOf('const brokerNativeTools = ['),
      runtimeSource.indexOf(
        '\n];',
        runtimeSource.indexOf('const brokerNativeTools = ['),
      ) + 3,
    );
    const runtimePairs = [
      ...brokerNativeBlock.matchAll(
        /canonicalName: '([^']+)',\s+wireName: '([^']+)'/g,
      ),
    ].map((match) => ({ canonicalName: match[1]!, wireName: match[2]! }));
    const expectedPairs = allRiceToolManifest
      .filter((tool) => tool.transport === 'dsh_broker_native')
      .map((tool) => ({
        canonicalName: tool.canonicalName,
        wireName: tool.dshWireName,
      }));

    expect(runtimePairs).toHaveLength(18);
    expect(
      runtimePairs.toSorted((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName),
      ),
    ).toEqual(
      expectedPairs.toSorted((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName),
      ),
    );
  });
});
