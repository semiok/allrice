import { describe, expect, it, vi } from 'vitest';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';

// Scoped authorization checks only; actual question/answer and cancellation
// remain native DSH behavior and are verified through ordinary-employee QA.
function fixture(nativeSkillsAvailable = true) {
  const agents = new Map();
  const listeners = new Map();
  let guard;
  const runtime = createGovernedAssistantNativeRuntime(
    {
      on: (event, listener) => listeners.set(event, listener),
      agents: { get: (id) => agents.get(id) },
      sessions: { flush: async () => {} },
      tools: {
        guard: (handler) => {
          guard = handler;
        },
        register: vi.fn(),
      },
    },
    vi.fn(),
    { nativeSkillsAvailable },
  );
  const agent = (id) => {
    const value = {
      id,
      session: { header: {}, events: [], snapshotEvents: () => [] },
      ctx: { tools: { restrict: vi.fn(), register: vi.fn(() => vi.fn()) } },
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
    };
    agents.set(id, value);
    return value;
  };
  return {
    runtime,
    agent,
    listeners,
    authorize: (agent, name) => guard({ agent, name }),
  };
}

describe('governed root native user questions', () => {
  it('allows a root to ask the user while retaining the frozen work-tool boundary', () => {
    const f = fixture();
    const root = f.agent('root');
    const wireTools = Object.freeze(['workspace_document_read']);
    f.runtime.bind({ nativeSessionId: root.id, wireTools });
    expect(root.ctx.tools.restrict).toHaveBeenCalledWith({
      allow: ['workspace_document_read', 'ask_user_question', 'skill'],
    });
    expect(f.authorize(root, 'ask_user_question')).toBeUndefined();
    expect(f.authorize(root, 'skill')).toBeUndefined();
    expect(f.authorize(root, 'workspace_document_read')).toBeUndefined();
    expect(f.authorize(root, 'local_process_execute')).toBe(
      'assistant_tool_not_allowed',
    );
    expect(f.authorize(root, 'automation_create')).toBe(
      'assistant_tool_not_allowed',
    );
    expect(wireTools).toEqual(['workspace_document_read']);
  });

  it('does not implicitly grant user questions or other root tools to a child', () => {
    const f = fixture();
    const root = f.agent('root');
    const child = f.agent('child');
    f.runtime.bind({ nativeSessionId: root.id, wireTools: [] });
    f.runtime.bind({
      nativeSessionId: child.id,
      parentNativeSessionId: root.id,
      wireTools: ['assistant_report'],
    });
    expect(child.ctx.tools.restrict).toHaveBeenCalledWith({
      allow: ['assistant_report'],
    });
    expect(f.authorize(child, 'assistant_report')).toBeUndefined();
    expect(f.authorize(child, 'ask_user_question')).toBe(
      'assistant_tool_not_allowed',
    );
    expect(f.authorize(child, 'skill')).toBe('assistant_tool_not_allowed');
    expect(f.authorize(child, 'workspace_document_read')).toBe(
      'assistant_tool_not_allowed',
    );
  });

  it('preserves the same root question scope when the native agent is recreated after binding', () => {
    const f = fixture();
    f.runtime.bind({
      nativeSessionId: 'root',
      wireTools: ['workspace_document_read'],
    });
    const root = f.agent('root');
    f.listeners.get('agent/created')({ agent: root });
    expect(root.ctx.tools.restrict).toHaveBeenCalledWith({
      allow: ['workspace_document_read', 'ask_user_question', 'skill'],
    });
    expect(f.authorize(root, 'ask_user_question')).toBeUndefined();
    expect(f.authorize(root, 'skill')).toBeUndefined();
    expect(f.authorize(root, 'workspace_document_read')).toBeUndefined();
    expect(f.authorize(root, 'local_process_execute')).toBe(
      'assistant_tool_not_allowed',
    );
  });

  it('does not duplicate native tools already in the root scope', () => {
    const f = fixture();
    const root = f.agent('root');
    f.runtime.bind({
      nativeSessionId: root.id,
      wireTools: ['ask_user_question', 'skill'],
    });
    expect(root.ctx.tools.restrict).toHaveBeenCalledWith({
      allow: ['ask_user_question', 'skill'],
    });
  });

  it('does not enable a missing catalog from a binding request', () => {
    const f = fixture(false);
    const root = f.agent('root');
    f.runtime.bind({
      nativeSessionId: root.id,
      wireTools: [],
      nativeSkillsAvailable: true,
    });
    expect(root.ctx.tools.restrict).toHaveBeenCalledWith({
      allow: ['ask_user_question'],
    });
    expect(f.authorize(root, 'skill')).toBe('assistant_tool_not_allowed');
  });
});
