import { Context } from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import Query from '@deepseek-ai/dsh-session-query-sqlite';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import Subagents, { finalAssistantOutput } from '@deepseek-ai/dsh-subagent';
import Fs from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { NativeSubagentSummarySchema } from '@allrice/contracts/native-runtime';
import './allrice-dsh-inputs.mjs';
import './allrice-dsh-waits.mjs';

/** Internal storage composition, not an authorization boundary. The caller must
 * resolve the approved namespace/reader before entering; no HTTP accepts paths.
 * No Agent, model, Session creation/resume, writer or search index is installed. */
export async function withNativeQueryReader(storageNamespace, read) {
  const ctx = new Context();
  try {
    for (const [plugin, config] of [
      [Sessions],
      [Projections],
      [Fs],
      [SystemPrompt, {}],
      [WorkingDirectory],
      [TokenMeter],
      [Subagents, {}],
      [Persistence, { root: storageNamespace, compression: 'none' }],
      [Query, { path: ':memory:', openAt: 'never' }],
    ])
      await ctx.plugin(plugin, config).await();
    return await read(ctx);
  } finally {
    await ctx.fiber.dispose();
  }
}

const cut = ({ source, cursor }) => ({ source, cursor });

/** Read only native facts. Prepared cuts may contain synthetic interrupted-turn
 * closers: preserve their source, never manufacture activation completion.
 * The supplied root must already be authorized by the owning Host/Worker. */
export async function readNativeSubagentSummary(ctx, rootId, signal) {
  const observations = new Map();
  const liveSessions = new Map();
  const observe = async (id) => {
    if (!observations.has(id)) {
      liveSessions.set(id, ctx.sessions.get(id));
      observations.set(
        id,
        await ctx.sessionQuery.observeSession(id, { signal }),
      );
    }
    return observations.get(id);
  };
  try {
    const root = await observe(rootId);
    if (
      root.header.id !== rootId ||
      root.header.parentSession ||
      root.header.isSeeded
    )
      throw Error('NATIVE_QUERY_ROOT_MISMATCH');
    const trusted = new Set([rootId]);
    const descendants = [];
    for (const row of await ctx.subagents.listDescendants(rootId, signal)) {
      signal?.throwIfAborted();
      const diagnostic = (reason) => ({
        kind: 'diagnostic',
        id: row.id,
        parentId: row.parentId,
        depth: row.depth,
        reason,
      });
      if (!trusted.has(row.parentId)) {
        descendants.push(diagnostic('parent_unverified'));
        continue;
      }
      if (row.kind === 'diagnostic') {
        descendants.push(row);
        continue;
      }
      if (row.mode === 'external') {
        descendants.push(diagnostic('unsupported'));
        continue;
      }
      try {
        const child = await observe(row.id);
        const parent = await observe(row.parentId);
        const values = child.projections?.values;
        const identity = values?.subagent;
        const own = child.events.slice(child.inheritedEventCount);
        const catalog = parent.projections?.values.subagentCatalog;
        if (
          child.header.id !== row.id ||
          child.header.parentSession !== row.parentId ||
          !identity ||
          identity.mode !== row.mode ||
          identity.label !== row.label ||
          !own.some(
            (e) => e.type === 'subagent/descriptor' && e.seq === identity.seq,
          ) ||
          !catalog?.some(
            (entry) =>
              entry.id === row.id &&
              entry.mode === identity.mode &&
              entry.label === identity.label &&
              entry.createdAt === child.header.createdAt,
          )
        ) {
          descendants.push(diagnostic('identity_mismatch'));
          continue;
        }
        const session = liveSessions.get(row.id);
        const agent = ctx.get('agents')?.get(row.id);
        const status =
          root.source === 'live' &&
          child.source === 'live' &&
          session &&
          ctx.sessions.get(row.id) === session &&
          agent?.session === session
            ? agent.status
            : undefined;
        // The native tool supplies its task as the first text block; later
        // blocks can be internal continuable return guidance, not the task.
        const task = own.find(
          (e) => e.type === 'user/message' && e.data.source.kind === 'user',
        )?.data.content[0];
        const summary = {
          kind: 'child',
          id: row.id,
          parentId: row.parentId,
          depth: row.depth,
          mode: identity.mode,
          label: identity.label,
          running:
            status === 'running' ? true : status === 'idle' ? false : null,
          title: foldSessionTitle(own)?.title,
          task: task?.type === 'text' ? task.text : undefined,
          activity: root.source === 'live' ? row.activity : 'unknown',
          observation: cut(child),
          timing: values.subagentTiming,
          usage: values.tokenUsage,
          lastReply:
            finalAssistantOutput(own)
              ?.filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('') || null,
        };
        // Validate before trusting this node as a parent for any later branch.
        NativeSubagentSummarySchema.parse({
          rootId,
          root: cut(root),
          descendants: [summary],
        });
        descendants.push(summary);
        trusted.add(row.id);
      } catch (error) {
        signal?.throwIfAborted();
        descendants.push(
          diagnostic(
            error?.code === 'SESSION_QUERY_CORRUPT_SESSION' ||
              error?.code === 'SESSION_QUERY_SOURCE_CONFLICT'
              ? 'corrupt'
              : 'unavailable',
          ),
        );
      }
    }
    return NativeSubagentSummarySchema.parse({
      rootId,
      root: cut(root),
      descendants,
    });
  } finally {
    for (const observation of observations.values())
      observation[Symbol.dispose]();
  }
}
