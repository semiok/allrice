import { brandString } from '@deepseek-ai/dsh-brand';
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type {
  NodeKey,
  TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { ProcessState } from '../../app/chatflow/dsh-upstream/process/process-groups';
import type { WorkProgressPart } from './work-progress';

/** Feed public Allrice rows into the official DSH grouping definition.
 * No raw tool arguments or private reasoning enter the tenant presentation.
 */
export function nativeProcessGroups(
  rows: WorkProgressPart[],
  running: boolean,
): WorkProgressPart[] {
  const turn: TurnLocation = {
    turn: 0,
    start: undefined,
    end: undefined,
    status: running ? 'open' : 'closed',
    steps: [],
    data: {
      get: () => undefined,
      source: () => ({
        getSnapshot: () => undefined,
        subscribe: () => () => {},
      }),
    },
  };
  const order = rows.map((row) => brandString<NodeKey>(row.id));
  const source = new Map(rows.map((row) => [row.id, row]));
  const nodes = new Map<string, ChatConversationViewNode>(
    rows.map((row) => [
      row.id,
      {
        key: row.id,
        id: row.id,
        target: 'chat',
        visibility: 'visible',
        anchorSeq: row.sequence,
        location: { kind: 'turn', turn },
        kind:
          row.kind === 'reply' ? 'assistant-step' : 'allrice-public-activity',
        data:
          row.kind === 'reply'
            ? {
                status: running ? 'running' : 'settled',
                blocks: [{ kind: 'text', text: row.text }],
              }
            : row.items,
      },
    ]),
  );
  const positions = new Map(
    order.map((key, index) => [
      key,
      { turn: 0, previous: order[index - 1], next: order[index + 1] },
    ]),
  );
  const state = new ProcessState();
  state.accept({
    kind: 'replace',
    order,
    readNode: (key) => nodes.get(key),
    readTurn: () => order,
    readPosition: (key) => positions.get(key),
    timeline: { turnOrder: [0], turns: new Map([[0, turn]]) },
  });
  const result = state.output()!;
  if (result.groups.kind !== 'replace')
    throw Error('Expected native grouping snapshot');
  const groups = new Map(
    result.groups.snapshots.map((group) => [group.key, group]),
  );
  return (result.entries ?? []).map((entry) => {
    if (entry.kind === 'node') return source.get(entry.key)!;
    const group = groups.get(entry.key)!;
    return {
      kind: 'steps',
      id: group.key,
      sequence: source.get(group.members[0]!.key)!.sequence,
      closed: group.data.closed,
      items: group.members.flatMap((member) => {
        const row = source.get(member.key)!;
        return row.kind === 'steps' ? row.items : [];
      }),
    };
  });
}
