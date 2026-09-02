import { describe, expect, it, vi } from 'vitest';

import { HandlerError } from '../../errors.js';
import type { HarnessExecutionInput } from '../adapter.js';
import {
  dshBrokerNativeToolNames,
  dshInboundToolHandler,
  dshToolBridgeInstructions,
  parseDshToolCall,
} from './tool-bridge.js';

function executionInput(input: {
  tools?: HarnessExecutionInput['tools'];
  onToolCall?: HarnessExecutionInput['onToolCall'];
}) {
  return {
    tools: input.tools ?? [],
    onToolCall: input.onToolCall,
  } as HarnessExecutionInput;
}

describe('DSH Tool Bridge', () => {
  it('describes native and envelope tools without changing their boundary', () => {
    expect(dshToolBridgeInstructions(executionInput({}))).toContain(
      'No external tools are available',
    );

    const instructions = dshToolBridgeInstructions(
      executionInput({
        tools: [
          {
            name: [...dshBrokerNativeToolNames][0]!,
            description: 'A native broker tool',
            inputSchema: { type: 'object' },
          },
          {
            name: 'legacy.envelope.tool',
            description: 'A legacy envelope tool',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(instructions).toContain('DSH native tools available for this turn');
    expect(instructions).toContain('legacy.envelope.tool');
    expect(instructions).toContain('<allrice_tool_call>');
  });

  it('parses exactly one valid envelope and rejects ambiguous output', () => {
    expect(
      parseDshToolCall(
        '<allrice_tool_call>{"id":"call-1","name":"legacy.tool","arguments":{"path":"a"}}</allrice_tool_call>',
      ),
    ).toEqual({
      id: 'call-1',
      name: 'legacy.tool',
      arguments: { path: 'a' },
    });
    expect(parseDshToolCall('ordinary answer')).toBeNull();
    expect(() =>
      parseDshToolCall(
        '<allrice_tool_call>{"id":"one","name":"a","arguments":{}}</allrice_tool_call>' +
          '<allrice_tool_call>{"id":"two","name":"b","arguments":{}}</allrice_tool_call>',
      ),
    ).toThrowError(HandlerError);
  });

  it('forwards only granted broker-native calls to the AllRice Tool Broker', async () => {
    const name = [...dshBrokerNativeToolNames][0]!;
    const onToolCall = vi.fn(async () => ({
      modelContent: 'result',
      summary: 'done',
      itemCount: 2,
    }));
    const handler = dshInboundToolHandler(
      executionInput({
        tools: [
          { name, description: 'native', inputSchema: { type: 'object' } },
        ],
        onToolCall,
      }),
    );

    await expect(
      handler('allrice/tool-call', {
        toolCallId: 'call-1',
        name,
        arguments: { query: 'rice' },
      }),
    ).resolves.toEqual({
      modelContent: 'result',
      summary: 'done',
      itemCount: 2,
    });
    expect(onToolCall).toHaveBeenCalledWith({
      id: 'call-1',
      name,
      arguments: { query: 'rice' },
    });

    await expect(handler('unknown/method', {})).rejects.toMatchObject({
      code: 'DSH_INBOUND_REQUEST_DENIED',
    });
  });
});
