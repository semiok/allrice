import { describe, expect, it } from 'vitest';

import { allRiceToolManifest } from './tool-manifest.ts';

describe('AllRice tool manifest', () => {
  it('adds one explicitly gated command to the governed 23/20/19 transport inventory', () => {
    const canonicalNames = allRiceToolManifest.map(
      (tool) => tool.canonicalName,
    );
    const nativeTools = allRiceToolManifest.filter(
      (tool) => tool.transport !== 'envelope',
    );
    const brokerNativeTools = allRiceToolManifest.filter(
      (tool) => tool.transport === 'dsh_broker_native',
    );
    const envelopeTools = allRiceToolManifest.filter(
      (tool) => tool.transport === 'envelope',
    );
    const searchTools = allRiceToolManifest.filter(
      (tool) => tool.transport === 'dsh_search',
    );
    const wireNames = nativeTools.map((tool) =>
      'dshWireName' in tool ? tool.dshWireName : undefined,
    );

    expect(canonicalNames).toHaveLength(23);
    expect(new Set(canonicalNames).size).toBe(23);
    expect(nativeTools).toHaveLength(20);
    expect(brokerNativeTools).toHaveLength(19);
    expect(envelopeTools.map((tool) => tool.canonicalName)).toEqual([
      'workspace.file.list',
      'workspace.file.read',
      'web.fetch',
    ]);
    expect(searchTools.map((tool) => tool.canonicalName)).toEqual([
      'web.search',
    ]);
    expect(wireNames.every(Boolean)).toBe(true);
    expect(new Set(wireNames).size).toBe(20);
  });

  it('defines capability and risk metadata for every canonical tool', () => {
    for (const tool of allRiceToolManifest) {
      expect(tool.capability).toBeTruthy();
      expect(tool.risk).toBeTruthy();
      if (tool.transport === 'envelope') {
        expect('dshWireName' in tool).toBe(false);
      } else {
        expect('dshWireName' in tool).toBe(true);
      }
    }
  });
});
