import { randomUUID } from 'node:crypto';
import {
  AssistantStreamAccumulator,
  assembleAssistantStream,
} from '@deepseek-ai/dsh-llm';
import {
  nativeChildViewLimits as limits,
  readDshToolResult,
  toolActivityDetail,
  visibleModelText,
} from '@allrice/contracts/native-runtime';

const textBlocks = (blocks) =>
  (blocks ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
const bounded = (text) => ({
  text: text.slice(0, limits.text),
  truncated: text.length > limits.text,
});
const visible = (text) => {
  const value = visibleModelText(text).text;
  const envelope = '<allrice_tool_call>';
  return envelope.startsWith(value.trimStart()) || value.includes(envelope)
    ? ''
    : value;
};

/** A bounded display window over the exact own suffix, never a transcript owner. */
export function projectNativeChildCut(cut) {
  const own = cut.events.slice(cut.inheritedEventCount),
    window = own.slice(-limits.events);
  const task = own.find(
    (e) => e.type === 'user/message' && e.data.source.kind === 'user',
  );
  const rows = [],
    tools = new Map();
  let omittedRows = 0;
  for (const event of window) {
    const { data, seq, type } = event;
    if (event.surfaceOp === 'replace' || event.surfaceOp?.op === 'replace')
      continue;
    if (type === 'assistant/message') {
      const text = visible(textBlocks(data.message.content));
      if (text)
        rows.push({
          kind: 'assistant',
          seq,
          turn: data.turn,
          step: data.step,
          ...bounded(text),
        });
    } else if (type === 'tool/call' || type === 'tool/result') {
      const result =
        type === 'tool/result' ? readDshToolResult(data.message) : null;
      const callId = result?.toolCallId ?? data.callId;
      if (typeof callId !== 'string' || callId.length > 512) {
        omittedRows++;
        continue;
      }
      const key = `${data.turn}:${data.step}:${callId}`;
      let row = tools.get(key);
      if (!row) {
        row = {
          kind: 'tool',
          seq,
          turn: data.turn,
          step: data.step,
          callId,
          name: (data.name ?? 'tool').slice(0, 160),
          truncated: (data.name?.length ?? 0) > 160,
        };
        tools.set(key, row);
        rows.push(row);
      }
      if (type === 'tool/call') {
        row.truncated ||= data.arguments.length > limits.text;
        if (!row.truncated) {
          try {
            row.activityDetail = toolActivityDetail(
              data.name,
              JSON.parse(data.arguments),
              () => {
                row.truncated = true;
              },
            );
          } catch {
            /* No safe target. */
          }
        }
      } else {
        const failed = result?.isError === true || Boolean(data.error);
        row.result = {
          seq,
          failed,
          summary: failed ? '工具执行失败' : '工具执行完成',
        };
      }
    }
  }
  return {
    inheritedEventCount: cut.inheritedEventCount,
    window: {
      fromSeq: window[0]?.seq ?? null,
      omittedEvents: own.length - window.length,
      omittedRows,
    },
    task:
      task?.data.content[0]?.type === 'text'
        ? { seq: task.seq, ...bounded(task.data.content[0].text) }
        : null,
    rows,
  };
}

/** Only current attempts. Weak keys bind the actual emitting public Agent. */
export class NativeChildDisplay {
  agents = new WeakMap();
  state(agent) {
    if (!this.agents.has(agent))
      this.agents.set(agent, {
        instanceId: randomUUID(),
        revision: 0,
        complete: true,
        active: null,
      });
    return this.agents.get(agent);
  }
  accept(agent, frame) {
    if (frame.type === 'start' && frame.revision === 1)
      this.agents.delete(agent);
    const state = this.state(agent);
    if (frame.revision !== state.revision + 1) {
      state.active = null;
      state.complete = false;
    } else if (frame.type === 'start') {
      state.complete = true;
      state.active = {
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        startedAfterSeq: agent.session.seq - 1,
        nextIndex: 0,
        stream: new AssistantStreamAccumulator(),
        characters: 0,
        chunks: 0,
        truncated: false,
      };
    } else if (frame.type === 'end') state.active = null;
    else if (state.active) {
      const active = state.active;
      if (
        active.attemptId !== frame.attemptId ||
        active.nextIndex !== frame.index
      ) {
        state.active = null;
        state.complete = false;
      } else {
        active.nextIndex++;
        const chunk = frame.chunk;
        // Whitelist text fields before retaining: no reasoning, raw tool args or provider metadata.
        const safe =
          chunk.type === 'text-delta'
            ? { type: chunk.type, index: chunk.index, text: chunk.text }
            : chunk.type === 'block-start' && chunk.blockType === 'text'
              ? { type: chunk.type, index: chunk.index, blockType: 'text' }
              : chunk.type === 'block-end' && chunk.block.type === 'text'
                ? {
                    type: chunk.type,
                    index: chunk.index,
                    block: { type: 'text', text: chunk.block.text },
                  }
                : null;
        if (safe && !active.truncated) {
          active.characters +=
            safe.text?.length ?? safe.block?.text.length ?? 0;
          if (
            ++active.chunks > limits.chunks ||
            active.characters > limits.streamCharacters
          )
            active.truncated = true;
          else active.stream.push({ time: frame.time, chunk: safe });
        }
      }
    }
    state.revision = frame.revision;
    return state.instanceId;
  }
  commit(agent, event) {
    const state = this.agents.get(agent),
      active = state?.active;
    if (
      active &&
      ['assistant/message', 'assistant/attempt'].includes(event.type) &&
      event.seq > active.startedAfterSeq &&
      event.data.turn === active.turn &&
      event.data.step === active.step
    )
      state.active = null;
  }
  snapshot(agent) {
    const { instanceId, revision, complete, active } = this.state(agent);
    const text = active
      ? bounded(
          visible(
            textBlocks(
              assembleAssistantStream(active.stream.snapshot()).blocks(),
            ),
          ),
        )
      : null;
    return {
      mode: 'replace',
      cursor: agent.session.seq - 1,
      instanceId,
      revision,
      complete: complete && !active?.truncated && !text?.truncated,
      active: active
        ? {
            attemptId: active.attemptId,
            turn: active.turn,
            step: active.step,
            startedAfterSeq: active.startedAfterSeq,
            nextIndex: active.nextIndex,
            ...text,
            truncated: text.truncated || active.truncated,
          }
        : null,
    };
  }
  dispose(agent) {
    this.agents.delete(agent);
  }
  clear() {
    this.agents = new WeakMap();
  }
}
