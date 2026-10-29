import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { allRiceToolManifest, employeeToolCatalog } from '@allrice/contracts';
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
  it.each(['0', '1'])(
    'never exposes retired assistant tools with the former flag at %s',
    (value) => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', value);
      expect(
        riceToolDefinitionsForCapabilities(['model:invoke']).some((tool) =>
          tool.name.startsWith('assistant.'),
        ),
      ).toBe(false);
      expect(
        riceToolDefinitionsForCapabilities(
          ['model:invoke'],
          ['assistant.delegate', 'assistant.report'],
        ),
      ).toEqual([]);
    },
  );
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
    expect(
      employeeToolCatalog.map((tool) => ({
        canonicalName: tool.canonicalName,
        capability: tool.capability,
        risk: tool.risk,
        transport: tool.transport,
      })),
    ).toEqual(
      allRiceToolManifest.map((tool) => ({
        canonicalName: tool.canonicalName,
        capability: tool.capability,
        risk: tool.risk,
        transport: tool.transport,
      })),
    );
    expect(riceToolDefinitions.map((tool) => tool.name)).toEqual(
      allRiceToolManifest.map((tool) => tool.canonicalName),
    );

    for (const tool of allRiceToolManifest) {
      expect(riceToolCapability(tool.canonicalName)).toBe(tool.capability);
      expect(riceToolRisk(tool.canonicalName)).toBe(tool.risk);
    }
  });

  it('exposes Changeset proposals to the native model with the Broker enums and no execution authority', async () => {
    const { workbenchNativeTools } = await import(
      pathToFileURL(
        resolve(
          import.meta.dirname,
          '../dsh/allrice-workbench-native-tools.mjs',
        ),
      ).href
    );
    const native = workbenchNativeTools.find(
      (tool: { canonicalName: string }) =>
        tool.canonicalName === 'workspace.export.create',
    );
    const broker = riceToolDefinitions.find(
      (tool) => tool.name === native.canonicalName,
    )!;
    expect(native.wireName).toBe('workspace_export_create');
    const { properties } = broker.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    for (const field of ['artifactKind', 'format'])
      expect(native.parameters[field].enum).toEqual(properties[field]!.enum);
    expect(native.parameters.artifactKind.enum).toContain('changeset');
    expect(native.parameters.artifactKind.description).toContain('format=json');
    expect(native.parameters.artifactKind.description).toContain('"before"');
    expect(native.parameters.artifactKind.description).toContain('"after"');
    expect(native.parameters.artifactKind.description).toContain(
      'Publishing never executes changes',
    );
    expect(native.parameters.artifactKind.description).toContain(
      'approve the exact action',
    );
    for (const field of ['deviceId', 'grantId', 'approvalId', 'execution'])
      expect(native.parameters).not.toHaveProperty(field);
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
      resolve(import.meta.dirname, '../dsh/allrice-jsonrpc-implementation.mjs'),
      'utf8',
    );
    const declaration = '  const brokerNativeTools = [\n';
    const start = runtimeSource.indexOf(declaration);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(runtimeSource.indexOf(declaration, start + declaration.length)).toBe(
      -1,
    );
    const terminator = '\n  ];';
    const end = runtimeSource.indexOf(terminator, start);
    expect(end).toBeGreaterThan(start);
    const brokerNativeBlock = runtimeSource.slice(
      start,
      end + terminator.length,
    );
    const runtimePairs = [
      ...brokerNativeBlock.matchAll(
        /canonicalName: '([^']+)',\s+wireName: '([^']+)'/g,
      ),
    ].map((match) => ({ canonicalName: match[1]!, wireName: match[2]! }));
    // Native registrations may live in audited modules. Inspect the actual
    // exports only when the runtime imports AND spreads them into its registry.
    const moduleImports = [
      ...runtimeSource.matchAll(
        /import\s+\{([^}]+)\}\s+from '(\.\/allrice-[a-z-]+-native-tools\.mjs)';/g,
      ),
    ].flatMap(([, bindings, modulePath]) =>
      bindings!
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.endsWith('NativeTools'))
        .map((name) => [name, modulePath!] as const),
    );
    const spreads = [...brokerNativeBlock.matchAll(/\.\.\.(\w+),/g)];
    expect(spreads.map((match) => match[1]).toSorted()).toEqual(
      moduleImports.map(([name]) => name).toSorted(),
    );
    for (const [exported, modulePath] of moduleImports) {
      const module = await import(
        pathToFileURL(resolve(import.meta.dirname, '../dsh', modulePath!)).href
      );
      const registrations = module[exported!] as {
        canonicalName: string;
        wireName: string;
      }[];
      expect(Array.isArray(registrations)).toBe(true);
      runtimePairs.push(
        ...registrations.map(({ canonicalName, wireName }) => ({
          canonicalName,
          wireName,
        })),
      );
    }
    const expectedPairs: { canonicalName: string; wireName: string }[] =
      allRiceToolManifest
        .filter((tool) => tool.transport === 'dsh_broker_native')
        .map((tool) => ({
          canonicalName: tool.canonicalName,
          wireName: tool.dshWireName,
        }));

    const privatePairs = [
      {
        canonicalName: 'platform.technical.diagnostics',
        wireName: 'platform_technical_diagnostics',
      },
      {
        canonicalName: 'platform.repository.repair',
        wireName: 'platform_repository_repair',
      },
      {
        canonicalName: 'platform.repository.review',
        wireName: 'platform_repository_review',
      },
      {
        canonicalName: 'platform.employee.method.step',
        wireName: 'platform_employee_method_step',
      },
    ];
    expectedPairs.push(...privatePairs);
    for (const { canonicalName } of privatePairs) {
      expect(
        allRiceToolManifest.some((t) => t.canonicalName === canonicalName),
      ).toBe(false);
      expect(riceToolDefinitions.some((t) => t.name === canonicalName)).toBe(
        false,
      );
      expect(
        riceToolDefinitionsForCapabilities([
          'model:invoke',
          'storage:read',
          'storage:write',
          'network:outbound',
          'secret:use',
          'automation:write',
        ]).some((t) => t.name === canonicalName),
      ).toBe(false);
    }
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
