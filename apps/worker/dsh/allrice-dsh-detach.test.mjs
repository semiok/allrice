import { describe, expect, it, vi } from 'vitest';
import { replyNativeQuestion } from './allrice-dsh-detach.mjs';

const params = {
  sessionId: 'stored-root',
  callId: 'continued-call',
  answers: [{ id: 'go', selected: ['继续'] }],
};
function fixture(state = 'continued') {
  const record = { agent: { session: { seq: 7 } } };
  const view = {
    questions: {
      active: [
        {
          callId: params.callId,
          state,
          questions: [
            { id: 'go', question: '继续吗？', options: [{ label: '继续' }] },
          ],
        },
      ],
    },
  };
  const stateOf = vi.fn(() => view);
  // Only the public projection and answer interfaces exist in this fixture.
  const answer = vi.fn(() => true);
  const server = {
    roots: new Map([[params.sessionId, record]]),
    ensureRoot: vi.fn(async () => record),
    assertRoot: vi.fn(),
    ctx: {
      get: (name) => (name === 'sessionProjections' ? { stateOf } : undefined),
      userQuestions: { answer },
    },
  };
  return { server, record, stateOf, answer };
}

describe('continued reply uses only public DSH interfaces', () => {
  it('reads the projection before answering the exact restored root', async () => {
    const h = fixture();
    expect(await replyNativeQuestion(h.server, params)).toEqual({
      queued: true,
    });
    expect(h.server.ensureRoot).toHaveBeenCalledWith(params.sessionId, {
      resumeOnly: true,
    });
    expect(h.stateOf).toHaveBeenCalledWith(
      h.record.agent.session,
      'userQuestions',
    );
    expect(h.answer).toHaveBeenCalledWith(h.record.agent, params.callId, {
      answers: params.answers,
    });
  });
  it('does not answer an open question as a continued one', async () => {
    const h = fixture('open');
    expect(await replyNativeQuestion(h.server, params)).toEqual({
      queued: false,
    });
    expect(h.answer).not.toHaveBeenCalled();
  });
  it.each(['REPLY_QUEUED', 'BAD_ANSWER'])(
    'preserves the native %s code for RPC routing',
    async (code) => {
      const h = fixture();
      h.answer.mockImplementation(() => {
        throw Object.assign(Error('native explanation'), { code });
      });
      await expect(replyNativeQuestion(h.server, params)).rejects.toThrow(
        new Error(code),
      );
    },
  );
});
