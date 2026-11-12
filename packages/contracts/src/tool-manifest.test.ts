import { describe, expect, it } from 'vitest';

import {
  allRiceToolManifest,
  employeeCustomizationToolsForInstance,
  withEmployeeCustomizationTools,
} from './tool-manifest.ts';

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
    expect(
      canonicalNames.filter((name) => name.startsWith('assistant.')),
    ).toEqual([]);
    const wireNames = nativeTools.map((tool) =>
      'dshWireName' in tool ? tool.dshWireName : undefined,
    );

    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);
    expect(nativeTools.length).toBeGreaterThan(0);
    expect(brokerNativeTools).toHaveLength(
      nativeTools.length - searchTools.length,
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
    expect(envelopeTools.map((tool) => tool.canonicalName)).toEqual([]);
    expect(
      allRiceToolManifest.find(
        (tool) => tool.canonicalName === 'workspace.file.read',
      ),
    ).toMatchObject({
      transport: 'dsh_broker_native',
      dshWireName: 'workspace_file_read',
      risk: 'read_only',
      capability: 'storage:read',
    });
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

it('ignores published intrinsic grants and gives general instances only private style/install tools', () => {
  const declared = [
    'workspace.file.read',
    'workspace.employee.method.activate',
    'workspace.employee.profile.update',
  ];
  expect(
    withEmployeeCustomizationTools(
      declared,
      ['storage:read', 'storage:write'],
      'general',
    ),
  ).toEqual([
    'workspace.file.read',
    'workspace.personal_skill.install',
    'workspace.personal_skill.version',
    'workspace.employee.profile.update',
  ]);
  expect(
    withEmployeeCustomizationTools(declared, ['storage:read'], 'general'),
  ).toEqual(['workspace.file.read']);
  expect(
    withEmployeeCustomizationTools(declared, ['storage:read', 'storage:write']),
  ).toEqual(['workspace.file.read']);
  const custom = withEmployeeCustomizationTools(
    declared,
    ['storage:read', 'storage:write'],
    'custom',
  );
  expect(custom).toContain('workspace.brand_content.read');
  for (const stage of [
    'inspect',
    'save_candidate',
    'restore_candidate',
    'test',
    'test_status',
    'prepare_activation',
    'activate',
  ])
    expect(custom).not.toContain(`workspace.employee.method.${stage}`);
});

it('keeps retired text methods out of verified Rice grants without mutating declarations', () => {
  const original = withEmployeeCustomizationTools(
    [],
    ['storage:read', 'storage:write'],
    'general',
  );
  const rice = withEmployeeCustomizationTools(
    ['workspace.brand_content.read', 'workspace.employee.method.activate'],
    ['storage:read', 'storage:write'],
    'general',
    true,
  );
  expect(rice).toEqual(original);
  expect(
    withEmployeeCustomizationTools([], ['storage:read'], 'general', true),
  ).toEqual([]);
  expect(rice).not.toContain('workspace.brand_content.read');
  for (const suffix of [
    'inspect',
    'save_candidate',
    'restore_candidate',
    'test',
    'test_status',
    'prepare_activation',
    'activate',
  ])
    expect(rice).not.toContain(`workspace.employee.method.${suffix}`);
});

it.each([
  ['custom', false],
  ['general', false],
  ['general', true],
  [undefined, false],
] as const)(
  'does not admit retired declared tools for %s (Rice=%s)',
  (kind, rice) => {
    const retired = ['inspect', 'save_candidate', 'restore_candidate'].map(
      (action) => `workspace.employee.method.${action}`,
    );
    const declared = ['workspace.file.read', ...retired];
    const before = [...declared];
    const names = withEmployeeCustomizationTools(
      declared,
      ['storage:read', 'storage:write'],
      kind,
      rice,
    );
    expect(names).toContain('workspace.file.read');
    for (const name of retired) expect(names).not.toContain(name);
    expect(declared).toEqual(before);
  },
);

it('retains canonical wire metadata and old instance eligibility for frozen grants', () => {
  for (const action of ['inspect', 'save_candidate', 'restore_candidate']) {
    const name = `workspace.employee.method.${action}`;
    expect(
      allRiceToolManifest.find((tool) => tool.canonicalName === name),
    ).toMatchObject({
      dshWireName: `workspace_employee_method_${action}`,
      transport: 'dsh_broker_native',
    });
    for (const kind of ['custom', 'general'] as const)
      expect(
        employeeCustomizationToolsForInstance(kind, true).map(
          (tool) => tool.name,
        ),
      ).toContain(name);
  }
});
