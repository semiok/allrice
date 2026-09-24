'use client';

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import type { Message, RunView } from './chatflow-types';
import { TurnNavigator } from './dsh-upstream/turn-navigation/TurnNavigator';
import {
  conversationTurns,
  turnNavigationText,
  type TurnRailItem,
} from './turn-navigation-model';
import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';

export function ConversationTurnNavigator({
  messages,
  runViews,
  scrollRef,
  columnRef,
  onNavigateAway,
}: {
  messages: readonly Message[];
  runViews: Readonly<Record<string, RunView>>;
  scrollRef: RefObject<HTMLDivElement | null>;
  columnRef: RefObject<HTMLDivElement | null>;
  onNavigateAway: () => void;
}) {
  const items = useMemo(
    () => conversationTurns(messages, runViews),
    [messages, runViews],
  );
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  // Streaming preview changes do not rebuild observers or read every row again.
  const anchors = items
    .map((item) => (item.anchor.kind === 'loaded' ? item.anchor.key : ''))
    .join('\0');
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const column = columnRef.current;
    if (!scroll || !column || !anchors) return;
    const composer = scroll.querySelector<HTMLElement>('[data-composer-seat]');
    let frame = 0;
    let positions: { turn: number; top: number }[] = [];
    const update = () => {
      frame = 0;
      if (!positions.length) return;
      if (isConversationAtBottom(scroll)) {
        setActiveTurn(positions.at(-1)!.turn);
        return;
      }
      const top = scroll.scrollTop + 24;
      let left = 0,
        right = positions.length - 1;
      while (left < right) {
        const middle = Math.ceil((left + right) / 2);
        if (positions[middle]!.top <= top) left = middle;
        else right = middle - 1;
      }
      setActiveTurn(positions[left]!.turn);
    };
    const measure = () => {
      scroll.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroll.clientHeight}px`,
      );
      scroll.style.setProperty(
        '--dsh-composer-height',
        `${composer?.offsetHeight ?? 0}px`,
      );
      const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
      positions = anchors.split('\0').flatMap((key, index) => {
        const node = document.getElementById(`message-${key}`);
        return node && column.contains(node)
          ? [
              {
                turn: index + 1,
                top: node.getBoundingClientRect().top - origin,
              },
            ]
          : [];
      });
      update();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    observer.observe(column);
    if (composer) observer.observe(composer);
    scroll.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      scroll.style.removeProperty('--dsh-conversation-viewport-height');
      scroll.style.removeProperty('--dsh-composer-height');
    };
  }, [anchors, scrollRef, columnRef]);

  const navigate = useCallback(
    (item: TurnRailItem) => {
      const scroll = scrollRef.current;
      if (!scroll || item.anchor.kind !== 'loaded') return;
      const target = document.getElementById(`message-${item.anchor.key}`);
      if (!target || !scroll.contains(target)) return;
      onNavigateAway();
      // One immediate transcript jump also prevents an in-flight scroll from
      // restoring automatic following while the reader returns to an old turn.
      scroll.scrollTo({
        top:
          scroll.scrollTop +
          target.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          16,
        behavior: 'instant',
      });
      setActiveTurn(item.turn);
    },
    [scrollRef, onNavigateAway],
  );

  return (
    <TurnNavigator
      items={items}
      activeTurn={activeTurn}
      busyTurn={null}
      onNavigate={navigate}
      t={turnNavigationText}
    />
  );
}
