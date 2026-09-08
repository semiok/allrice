import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { allRiceToolManifest } from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dshBrokerNativeToolNames,
  dshNativeToolNames,
  dshNativeWireNames,
} from './harness/dsh-adapter.js';
import {
  riceToolCapability,
  riceToolDefinitions,
  riceToolRisk,
  riceToolDefinitionsForCapabilities,
} from './tool-broker.js';

describe('AllRice worker tool manifest contract', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('never exposes the new command through broad storage access or default flags', () => {
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:write'],
        ['local.process.execute'],
      ),
    ).toEqual([]);
    for (const flag of [
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    expect(
      riceToolDefinitionsForCapabilities(['storage:write']).some(
        (tool) => tool.name === 'local.process.execute',
      ),
    ).toBe(false);
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:write'],
        ['local.process.execute'],
      ).map((tool) => tool.name),
    ).toEqual(['local.process.execute']);
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:read'],
        ['local.process.execute'],
      ),
    ).toEqual([]);
  });
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

    expect(runtimePairs).toHaveLength(expectedPairs.length);
    const localProcessBlock = brokerNativeBlock.slice(
      brokerNativeBlock.indexOf("canonicalName: 'local.process.execute'"),
      brokerNativeBlock.indexOf("canonicalName: 'local.process.status'"),
    );
    for (const field of ['diagnostics', 'dependencies', 'background'])
      expect(localProcessBlock).toContain(`${field}:`);
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
