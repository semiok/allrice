import { allRiceToolManifest } from '@allrice/contracts';

import { HandlerError } from '../../errors.js';
import type { HarnessExecutionInput, HarnessToolCall } from '../adapter.js';
import { record, shortText } from './event-projector.js';

export const dshToolEnvelopePrefix = '<allrice_tool_call>';
const toolEnvelopePattern =
  /<allrice_tool_call>\s*([\s\S]*?)\s*<\/allrice_tool_call>/;

export const maximumDshToolCallsPerTurn = 8;

export const dshNativeToolNames: ReadonlySet<string> = new Set(
  allRiceToolManifest
    .filter((tool) => tool.transport !== 'envelope')
    .map((tool) => tool.canonicalName),
);

export const dshBrokerNativeToolNames: ReadonlySet<string> = new Set(
  allRiceToolManifest
    .filter((tool) => tool.transport === 'dsh_broker_native')
    .map((tool) => tool.canonicalName),
);

export const dshNativeWireNames: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      allRiceToolManifest.flatMap((tool) =>
        'dshWireName' in tool
          ? [[tool.dshWireName, tool.canonicalName] as const]
          : [],
      ),
    ),
  );

/**
 * DSH may prefix browser-local attachment links with `sandbox:`. AllRice
 * managed exports are authenticated HTTP routes, so keep their canonical
 * tenant URL when returning the answer to ChatFlow. Do not rewrite any other
 * DSH sandbox link.
 */
export function normalizeAllRiceManagedFileLinks(answer: string) {
  return answer.replaceAll('sandbox:/api/v1/files/', '/api/v1/files/');
}

export function isDshNativeTool(name: string) {
  return dshNativeToolNames.has(name);
}

export function isDshSearchTool(name: string) {
  return name === 'web.search' || name === 'wechat.article.search';
}

export function dshToolBridgeInstructions(input: HarnessExecutionInput) {
  const nativeTools = input.tools.filter((tool) => isDshNativeTool(tool.name));
  const bridgedTools = input.tools.filter(
    (tool) => !isDshNativeTool(tool.name),
  );
  if (bridgedTools.length === 0) {
    if (nativeTools.length > 0) {
      return 'Use the native DSH tools supplied for this turn. Do not emit AllRice XML tool envelopes. Never claim a tool result unless the native call succeeds.';
    }
    return 'No external tools are available. Never claim that a tool was called.';
  }
  const definitions = bridgedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return [
    'All host capabilities are disabled. Use only the tenant-scoped tools supplied by AllRice for this turn.',
    ...(nativeTools.length
      ? [
          `DSH native tools available for this turn: ${nativeTools
            .map((tool) => tool.name)
            .join(
              ', ',
            )}. Call these through their native DSH function definitions; do not use an AllRice XML envelope for them.`,
        ]
      : []),
    'The following additional non-native AllRice tools are available through the Tool Broker envelope:',
    JSON.stringify(definitions),
    'To call exactly one tool, return only <allrice_tool_call>{"id":"unique-id","name":"tool.name","arguments":{}}</allrice_tool_call>.',
    'Do not wrap that envelope in Markdown. Wait for an <allrice_tool_result> response before continuing.',
  ].join('\n');
}

export function parseDshToolCall(text: string): HarnessToolCall | null {
  const candidate = text.trim();
  const match = toolEnvelopePattern.exec(candidate);
  if (!match?.[1]) return null;
  const prefix = candidate.slice(0, match.index);
  const suffix = candidate.slice(match.index + match[0].length);
  if (
    prefix.includes(dshToolEnvelopePrefix) ||
    suffix.includes(dshToolEnvelopePrefix)
  ) {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned more than one AllRice tool envelope',
      false,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned an invalid AllRice tool envelope',
      false,
    );
  }
  const input = record(value);
  const args = record(input?.arguments);
  if (
    typeof input?.id !== 'string' ||
    !input.id ||
    typeof input.name !== 'string' ||
    !input.name ||
    !args
  ) {
    throw new HandlerError(
      'DSH_TOOL_ENVELOPE_INVALID',
      'DSH returned an invalid AllRice tool envelope',
      false,
    );
  }
  return { id: input.id, name: input.name, arguments: args };
}

export function dshInboundToolHandler(input: HarnessExecutionInput) {
  return async (method: string, params: Record<string, unknown>) => {
    if (method !== 'allrice/tool-call') {
      throw new HandlerError(
        'DSH_INBOUND_REQUEST_DENIED',
        `DSH requested an unsupported Worker method: ${method}`,
        false,
      );
    }
    const id = shortText(params.toolCallId, 240);
    const name = shortText(params.name, 160);
    const args = record(params.arguments);
    if (!id || !name || !args || !dshBrokerNativeToolNames.has(name)) {
      throw new HandlerError(
        'DSH_NATIVE_TOOL_INVALID',
        'DSH requested an invalid AllRice native tool call',
        false,
      );
    }
    if (!input.tools.some((tool) => tool.name === name)) {
      throw new HandlerError(
        'TOOL_NOT_ALLOWED',
        `DSH requested an unavailable tool: ${name}`,
        false,
      );
    }
    if (!input.onToolCall) {
      throw new HandlerError(
        'TOOL_NOT_ALLOWED',
        'No AllRice Tool Broker is available for this execution',
        false,
      );
    }
    const result = await input.onToolCall({ id, name, arguments: args });
    return {
      modelContent: result.modelContent,
      summary: result.summary,
      ...(result.itemCount === undefined
        ? {}
        : { itemCount: result.itemCount }),
    };
  };
}
