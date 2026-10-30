import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { visibleNativeText } from './allrice-native-display.mjs';

const text = (event) =>
  event.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
const publicMessage = (event, turn) =>
  isAppendSurfaceEvent(event) &&
  event.data.turn === turn &&
  !event.data.interrupted &&
  event.data.message?.source?.kind === 'model' &&
  Array.isArray(event.data.message.content) &&
  event.data.message.content.every((block) =>
    ['text', 'reasoning'].includes(block.type),
  );

// Only the private Worker reader supplies control-record references. Neither a
// bind argument nor JSON can restore a token, bindingId, proof or WeakMap entry.
export function verifyRestoredFinalReplyOrigin(session, entry, origin) {
  const unavailable = () => {
    throw Error('assistant_completion_origin_unavailable');
  };
  if (
    !origin ||
    origin.schemaVersion !== 1 ||
    origin.rootRunId !== entry.runId ||
    origin.nativeSessionId !== session.id ||
    session.header.id !== session.id ||
    session.header.isSeeded ||
    session.header.parentSession !== undefined ||
    (session.header.delegationDepth ?? 0) !== 0 ||
    !Array.isArray(origin.starts) ||
    !origin.starts.length ||
    origin.starts.length > 200
  )
    unavailable();
  const events = session.snapshotEvents();
  const turns = new Set(),
    ids = new Set(),
    sequences = new Set();
  const starts = [];
  const prefix = `${session.id}:turn:`;
  let previousControlSequence = -1,
    previousNativeStart = -1;
  for (const record of origin.starts) {
    if (
      !record ||
      typeof record.runEventId !== 'string' ||
      !record.runEventId ||
      ids.has(record.runEventId) ||
      !Number.isSafeInteger(record.runEventSequence) ||
      record.runEventSequence <= previousControlSequence ||
      sequences.has(record.runEventSequence) ||
      typeof record.turnId !== 'string' ||
      !record.turnId.startsWith(prefix)
    )
      unavailable();
    const numeric = record.turnId.slice(prefix.length),
      turn = Number(numeric);
    if (
      !/^[1-9][0-9]*$/.test(numeric) ||
      !Number.isSafeInteger(turn) ||
      turns.has(turn)
    )
      unavailable();
    const found = events.filter(
      (event) => event.type === 'turn/start' && event.data.turn === turn,
    );
    if (
      found.length !== 1 ||
      !Number.isSafeInteger(found[0].seq) ||
      found[0].seq <= previousNativeStart
    )
      unavailable();
    starts.push(found[0].seq);
    turns.add(turn);
    ids.add(record.runEventId);
    sequences.add(record.runEventSequence);
    previousControlSequence = record.runEventSequence;
    previousNativeStart = found[0].seq;
  }
  const lowerBoundary = starts[0];
  // Do not mistake another Run's newer turn for the anchored Run's public reply.
  if (
    events.some(
      (event) =>
        event.type === 'turn/start' &&
        event.seq >= lowerBoundary &&
        !turns.has(event.data.turn),
    )
  )
    unavailable();
  const last = events.findLast((event) => event.type === 'assistant/message');
  const latestTurn = events.findLast((event) => event.type === 'turn/start');
  if (
    !last ||
    !turns.has(last.data.turn) ||
    last.data.turn !== latestTurn?.data.turn ||
    last.seq <= lowerBoundary ||
    !publicMessage(last, last.data.turn)
  )
    unavailable();
  const end = events.findLast(
    (event) => event.type === 'turn/end' && event.data.turn === last.data.turn,
  );
  if (!end || end.seq <= last.seq || end.data.reason?.kind !== 'completed')
    unavailable();
  // Native completed-turn closing keeps the last finalized nonblank body.
  // Later input/empty steps do not erase it; this does not authorize branching.
  let candidate = last;
  for (const event of events.toReversed()) {
    if (event.seq <= latestTurn.seq) break;
    if (event.type !== 'assistant/message') continue;
    const body = text(event);
    if (!body.trim()) continue;
    if (
      publicMessage(event, last.data.turn) &&
      visibleNativeText(body) === body
    )
      candidate = event;
    else if (event === last) unavailable();
    break;
  }
  // Keep the existing empty-candidate inspection/repair behavior when this
  // turn has no provable final body; never borrow a prior turn's answer.
  return Object.freeze({
    lowerBoundary,
    turns: Object.freeze([...turns]),
    event: candidate,
  });
}
