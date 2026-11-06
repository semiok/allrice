import { AsyncLocalStorage } from 'node:async_hooks';
import {
  applyWebSearchTool,
  applyWebFetchTool,
  DEFAULT_WEB_TOOL_TIMEOUT_MS,
  WEB_SEARCH_MAX_QUERIES,
  WEB_SEARCH_MAX_RESULTS,
} from '@deepseek-ai/dsh-tool-web';

// Identity comes from DSH's public execution hook, never from model/provider
// arguments. All authorization and network work still run in the Tool Broker.
export function installNativeWeb(ctx, broker) {
  const calls = new AsyncLocalStorage();
  const registered = new Set();
  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== 'web_search' && exec.name !== 'web_fetch') return next();
    if (!exec.agent?.id) throw Error('WEB_CALL_AGENT_REQUIRED');
    return calls.run(
      { sessionId: exec.agent.id, callId: exec.callId, index: 0 },
      next,
    );
  });
  async function invoke(name, args, signal) {
    const call = calls.getStore();
    if (!call) throw Error('WEB_CALL_SCOPE_REQUIRED');
    const result = await broker(
      {
        nativeSessionId: call.sessionId,
        toolCallId:
          name === 'web.search'
            ? `${call.callId}:${call.index++}`
            : call.callId,
        name,
        arguments: args,
      },
      signal,
    );
    // modelContent is the existing Broker RPC data field, not a model-facing
    // wrapper. Only upstream tool-web renders this native provider value.
    return JSON.parse(result.modelContent);
  }
  ctx.web.registerSearchProvider({
    id: 'allrice',
    available: () => true,
    search: (request, signal) => invoke('web.search', request, signal),
  });
  ctx.web.registerFetchProvider({
    id: 'allrice',
    available: () => true,
    fetch: (request, signal) => invoke('web.fetch', request, signal),
  });
  return (tools) => {
    if (tools.has('web.search') && !registered.has('web.search')) {
      applyWebSearchTool(
        ctx,
        WEB_SEARCH_MAX_RESULTS,
        WEB_SEARCH_MAX_QUERIES,
        DEFAULT_WEB_TOOL_TIMEOUT_MS,
        tools.has('web.fetch'),
      );
      registered.add('web.search');
    }
    if (tools.has('web.fetch') && !registered.has('web.fetch')) {
      applyWebFetchTool(ctx, DEFAULT_WEB_TOOL_TIMEOUT_MS, 12_000);
      registered.add('web.fetch');
    }
  };
}
