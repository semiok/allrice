import { describe, expect, it } from 'vitest';

import { allRiceToolManifest } from './tool-manifest.ts';

describe('AllRice tool manifest', () => {
  it('registers native reconciliation, frozen resources, MCP and cloud execution', () => {
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

    expect(canonicalNames).toHaveLength(29);
    expect(new Set(canonicalNames).size).toBe(29);
    expect(nativeTools).toHaveLength(26);
    expect(brokerNativeTools).toHaveLength(25);
    expect(
      brokerNativeTools
        .filter((tool) =>
          ['local.process.status', 'local.process.stop'].includes(
            tool.canonicalName,
          ),
        )
        .map((tool) => ({
          name: tool.canonicalName,
          wireName: tool.dshWireName,
          capability: tool.capability,
          risk: tool.risk,
        })),
    ).toEqual([
      {
        name: 'local.process.status',
        wireName: 'local_process_status',
        capability: 'storage:write',
        risk: 'read_only',
      },
      {
        name: 'local.process.stop',
        wireName: 'local_process_stop',
        capability: 'storage:write',
        risk: 'managed_write',
      },
    ]);
    expect(envelopeTools.map((tool) => tool.canonicalName)).toEqual([
      'workspace.file.list',
      'workspace.file.read',
      'web.fetch',
    ]);
    expect(searchTools.map((tool) => tool.canonicalName)).toEqual([
      'web.search',
    ]);
    expect(wireNames.every(Boolean)).toBe(true);
    expect(new Set(wireNames).size).toBe(26);
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
