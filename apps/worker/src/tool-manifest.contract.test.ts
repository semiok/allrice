import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { allRiceToolManifest, employeeToolCatalog } from '@allrice/contracts';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Web from '@deepseek-ai/dsh-web';
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

function nativeWireName(tool: (typeof allRiceToolManifest)[number]) {
  if (!('dshWireName' in tool))
    throw new Error('Expected a native tool wire name');
  return tool.dshWireName;
}

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
      expectedNativeTools.map((tool) => [
        nativeWireName(tool),
        tool.canonicalName,
      ]),
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
    // This registry also projects a source descriptor with .map. Evaluate the
    // actual imported projection and actual registration method, then read the
    // public DSH registry; copying manifest pairs here would only self-confirm.
    const source = ts.createSourceFile(
      'runtime.mjs',
      runtimeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const registries: ts.ArrayLiteralExpression[] = [],
      methods: ts.MethodDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'brokerNativeTools' &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      )
        registries.push(node.initializer);
      if (
        ts.isMethodDeclaration(node) &&
        node.name.getText(source) === 'registerNativeTools'
      )
        methods.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(registries).toHaveLength(1);
    expect(methods).toHaveLength(1);
    expect(runtimeSource).toContain('this.registerNativeTools();');
    const projections = registries[0]!.elements.flatMap((node) => {
      if (!ts.isSpreadElement(node) || !ts.isCallExpression(node.expression))
        return [];
      const call = node.expression;
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.name.text !== 'map'
      )
        return [];
      return [{ binding: call.expression.expression.getText(source), call }];
    });
    expect(projections.map((projection) => projection.binding)).toEqual([
      'brandMediaTools',
    ]);
    const imported = source.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !==
          '@allrice/contracts/native-runtime' ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      )
        return [];
      return statement.importClause.namedBindings.elements.map((specifier) => ({
        imported: (specifier.propertyName ?? specifier.name).text,
        local: specifier.name.text,
      }));
    });
    for (const binding of ['brandMediaTools', 'brandMediaNativeParameters'])
      expect(imported).toContainEqual({ imported: binding, local: binding });
    expect(runtimeSource).toContain(
      "import { defineTool } from '@deepseek-ai/dsh-tools';",
    );
    const nativeContract = await import('@allrice/contracts/native-runtime');
    const mappedRegistrations = runInNewContext(
      projections[0]!.call.getText(source),
      {
        brandMediaTools: nativeContract.brandMediaTools,
        brandMediaNativeParameters: nativeContract.brandMediaNativeParameters,
      },
    ) as { canonicalName: string; wireName: string }[];
    expect(Array.isArray(mappedRegistrations)).toBe(true);
    const mappedContext = new Context();
    try {
      await mappedContext.plugin(SystemPrompt);
      await mappedContext.plugin(Tools);
      const host = {
        ctx: mappedContext,
        nativeTools: new Set(
          mappedRegistrations.map((tool) => tool.canonicalName),
        ),
        nativeToolsRegistered: new Set<string>(),
      };
      const register = runInNewContext(
        `({ ${methods[0]!.getText(source)} }).registerNativeTools`,
        {
          brokerNativeTools: mappedRegistrations,
          defineTool,
          isBoundedReferenceToolName: nativeContract.isBoundedReferenceToolName,
        },
      ) as (this: typeof host) => void;
      register.call(host);
      expect([...host.nativeToolsRegistered]).toEqual(
        mappedRegistrations.map((tool) => tool.canonicalName),
      );
      runtimePairs.push(
        ...mappedRegistrations.map((tool) => {
          const registered = mappedContext.tools.get(tool.wireName);
          expect(registered).toBeDefined();
          return {
            canonicalName: tool.canonicalName,
            wireName: registered!.name,
          };
        }),
      );
    } finally {
      await mappedContext.fiber.dispose();
    }
    // Native tool-web registers fetch through its public factory, not the
    // declaration array. Exercise that registration and its Broker dispatch.
    expect(runtimeSource).toContain(
      "import { installNativeWeb } from './allrice-native-web.mjs';",
    );
    expect(runtimeSource).toContain(
      'this.registerWeb ??= installNativeWeb(this.ctx, (params, signal) =>',
    );
    expect(runtimeSource).toContain('this.registerWeb(this.nativeTools);');
    const { installNativeWeb } = await import(
      pathToFileURL(
        resolve(import.meta.dirname, '../dsh/allrice-native-web.mjs'),
      ).href
    );
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(Tools);
      await ctx.plugin(Web, {});
      const calls: { name: string }[] = [];
      installNativeWeb(ctx, async (params: { name: string }) => {
        calls.push(params);
        return {
          modelContent: JSON.stringify({
            url: 'https://example.com/',
            statusCode: 200,
            body: { kind: 'text', content: 'contract fixture' },
            truncated: false,
          }),
        };
      })(new Set(['web.fetch']));
      const nativeFetch = ctx.tools.get('web_fetch');
      expect(nativeFetch).toBeDefined();
      expect(ctx.tools.get('web_search')).toBeUndefined();
      const result = await ctx.tools.execute({
        name: nativeFetch!.name,
        arguments: { url: 'https://example.com/' },
        callId: ToolCallId('manifest-fetch'),
        // This fixture exercises the tool pipeline's identity projection only.
        agent: { id: 'manifest-root' } as NonNullable<
          Parameters<typeof ctx.tools.execute>[0]['agent']
        >,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(false);
      expect(calls).toEqual([
        {
          nativeSessionId: 'manifest-root',
          toolCallId: 'manifest-fetch',
          name: 'web.fetch',
          arguments: { url: 'https://example.com/' },
        },
      ]);
      runtimePairs.push({
        canonicalName: calls[0]!.name,
        wireName: nativeFetch!.name,
      });
    } finally {
      await ctx.fiber.dispose();
    }
    const expectedPairs: { canonicalName: string; wireName: string }[] =
      allRiceToolManifest
        .filter((tool) => tool.transport === 'dsh_broker_native')
        .map((tool) => ({
          canonicalName: tool.canonicalName,
          wireName: nativeWireName(tool),
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
