import { describe, expect, it } from 'vitest';

import {
  conversationDistanceFromBottom,
  isConversationAtBottom,
} from './conversation-scroll';

describe('conversation scroll following', () => {
  it('treats the exact bottom as following', () => {
    expect(
      isConversationAtBottom({
        scrollHeight: 1_000,
        scrollTop: 600,
        clientHeight: 400,
      }),
    ).toBe(true);
  });

  it('keeps following within the DSH 25px tolerance', () => {
    expect(
      isConversationAtBottom({
        scrollHeight: 1_000,
        scrollTop: 575,
        clientHeight: 400,
      }),
    ).toBe(true);
  });

  it('stops following after the reader scrolls away', () => {
    expect(
      isConversationAtBottom({
        scrollHeight: 1_000,
        scrollTop: 574,
        clientHeight: 400,
      }),
    ).toBe(false);
  });

  it('does not return a negative distance when content is shorter than the viewport', () => {
    expect(
      conversationDistanceFromBottom({
        scrollHeight: 300,
        scrollTop: 0,
        clientHeight: 400,
      }),
    ).toBe(0);
  });
});
