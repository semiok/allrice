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
    const assistantTools = allRiceToolManifest.filter(
      (tool) => tool.transport === 'dsh_assistant_native',
    );
    expect(assistantTools.map((tool) => tool.canonicalName)).toEqual([
      'assistant.delegate',
      'assistant.message',
      'assistant.report',
      'assistant.stop',
      'assistant.development',
    ]);
    const wireNames = nativeTools.map((tool) =>
      'dshWireName' in tool ? tool.dshWireName : undefined,
    );

    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);
    expect(nativeTools.length).toBeGreaterThan(0);
    expect(brokerNativeTools).toHaveLength(
      nativeTools.length - searchTools.length - assistantTools.length,
    );
    expect(
      brokerNativeTools
        .filter((t) => t.canonicalName.startsWith('local.mcp.'))
        .map((t) => ({
          name: t.canonicalName,
          risk: t.risk,
          capability: t.capability,
        })),
    ).toEqual([
      {
        name: 'local.mcp.discover',
        risk: 'side_effect',
        capability: 'secret:use',
      },
      { name: 'local.mcp.call', risk: 'side_effect', capability: 'secret:use' },
    ]);
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
      'workspace.file.read',
      'web.fetch',
    ]);
    expect(searchTools.map((tool) => tool.canonicalName)).toEqual([
      'web.search',
    ]);
    expect(wireNames.every(Boolean)).toBe(true);
    expect(new Set(wireNames).size).toBe(wireNames.length);
    expect(
      brokerNativeTools.find(
        (tool) => tool.canonicalName === 'browser.workspace',
      ),
    ).toMatchObject({
      dshWireName: 'browser_workspace',
      capability: 'network:outbound',
      risk: 'side_effect',
    });
    expect(
      brokerNativeTools.find(
        (tool) => tool.canonicalName === 'local.browser.workspace',
      ),
    ).toMatchObject({
      capability: 'network:outbound',
      risk: 'side_effect',
      dshWireName: 'local_browser_workspace',
    });
  });

  it('defines capability and risk metadata for every canonical tool', () => {
    expect(
      allRiceToolManifest.find((t) => t.canonicalName === 'local.preview.open'),
    ).toMatchObject({
      capability: 'network:outbound',
      transport: 'dsh_broker_native',
      dshWireName: 'local_preview_open',
    });
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
