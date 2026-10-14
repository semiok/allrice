import {
  EmployeeMethodInspectSchema,
  EmployeeMethodSaveSchema,
  EmployeeContentManifestSchema,
  ReferenceSelectionsSchema,
  type EmployeeContentMutation,
  type EmployeeContentReference,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { employeeAccessTransaction } from './employee-access-cancellation.ts';
import {
  getEmployeeInstance,
  resolveEmployeeSessionInstance,
} from './employee-instances.ts';
import {
  assertEmployeeChatRun,
  employeeChatIdentity,
  employeeChatUuid,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import {
  inspectEmployeeMethodContent,
  mutateEmployeeContentInTransaction,
} from './employee-content.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';

export class EmployeeMethodChatError extends Error {
  constructor(
    readonly code:
      'explicit_method_request_required' | 'method_context_unavailable',
  ) {
    super(code);
  }
}

/** Only top-level user prose can authorize persistence. Keep quotation context
 * across lines so an imperative in a supplied document is never a command. */
function methodOperationClauses(text: string) {
  const lines: string[] = [];
  let fence: { character: string; length: number } | null = null;
  let quotedPassage = false;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = line.trim().match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence)
        fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
      else if (
        delimiter[1]![0] === fence.character &&
        delimiter[1]!.length >= fence.length &&
        !line.trim().slice(delimiter[1]!.length).trim()
      )
        fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    if (!line.trim()) {
      quotedPassage = false;
      continue;
    }
    if (
      /^(?:资料|附件|示例|例子|原文|引用|document|example|quotation).*(?:如下|原文|内容|:|：)/iu.test(
        line.trim(),
      )
    ) {
      quotedPassage = true;
      continue;
    }
    if (quotedPassage) continue;
    lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/gu, ' QUOTED ')
    .split(/[。；;！!\n]/)
    .map((clause) => clause.trim());
}

/** The operation targets the employee's method, not an article about methods.
 * A colon starts candidate content; its business constraints aren't commands. */
export function explicitEmployeeMethodIntent(text: string) {
  if (!text.trim() || text.length > 32000) return false;
  const clauses = methodOperationClauses(text);
  if (
    clauses.some((clause) =>
      /^(?:请)?(?:不要|无需|不必|勿|不能|不允许)(?:保存|修改|更新|持久化)(?:(?:我的)?(?:工作场景|执行要求|执行流程|工作方法|候选|草稿)|[，, ]|$)|^(?:please )?(?:do not|don't|never)\s+(?:save|update|persist)(?:\s+(?:my )?(?:method|scene|workflow|candidate|draft)|[,. ]*$)/iu.test(
        clause,
      ),
    )
  )
    return false;
  const first = text.trim().split(/[。；;！!\n：:]/, 1)[0]!;
  return (
    /^(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制)(?:[^《》“”"'「」『』`。；;！!\n：:]{0,80})(?:工作场景|执行要求|执行流程|工作方法)(?:候选|草稿)?$/u.test(
      first,
    ) ||
    /^(?:please )?(?:save|update|edit|create|add|customize)\s+(?:(?:my|this)\s+)?(?:work )?(?:method|scene|workflow)(?: (?:candidate|draft))?$/i.test(
      first,
    )
  );
}

export function explicitEmployeeMethodReferenceIntent(text: string) {
  const clauses = methodOperationClauses(text);
  if (
    clauses.some((clause) =>
      /(?:不要|无需|不必|勿|不能|不允许).{0,16}(?:引用|绑定|长期|以后)|(?:do not|don't|never).{0,20}(?:bind|reference|long.term)/iu.test(
        clause,
      ),
    )
  )
    return false;
  return clauses.some(
    (clause) =>
      (/^(?:请)?(?:(?:为我|帮我|在这个场景中)[，, ]*)?(?:(?:将|把).{1,80}(?:长期引用|长期绑定|长期使用)|(?:长期引用|长期绑定|长期使用).{1,80})$/u.test(
        clause.trim(),
      ) &&
        !/^(?:[“"'>]|例如|示例|引用|翻译|资料|附件写)/u.test(clause.trim())) ||
      /^(?:please )?(?:permanently|for future tasks) (?:bind|reference|use)\b/i.test(
        clause.trim(),
      ),
  );
}

const emptyManifest = () => ({
  schemaVersion: 1 as const,
  common: [],
  scenes: [],
  declaredConflicts: [],
});

/** Commit the context boundary BEFORE revealing a candidate or attempting a
 * save. Failure, interruption and abandoned edits cannot roll it back. The
 * original Run stays bound and readable; only subsequent Runs start fresh. */
async function enterMethodChat<T>(
  input: EmployeeChatCall,
  tool: string,
  retire: boolean,
  read: (
    tx: ContentTx,
    instance: Awaited<ReturnType<typeof getEmployeeInstance>>,
    text: string,
  ) => Promise<T>,
) {
  const { scope } = employeeChatIdentity(input);
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await readContentPrincipal(scope, tx, true);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
    const [session] = await tx<
      { assignment_id: string; instance_id: string }[]
    >`
      select employee_assignment_id assignment_id,coalesce(employee_instance_id,employee_assignment_id) instance_id
      from allrice_chat_sessions where id=${input.sessionId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.actor.id} and archived_at is null`;
    if (!session) throw new DataAccessError('not_found');
    const instance = await resolveEmployeeSessionInstance(
      scope,
      session.assignment_id,
      session.instance_id,
      tx,
    );
    const text = await assertEmployeeChatRun(tx, input, instance, tool);
    if (retire) {
      await tx`select run_id from allrice_employee_runs where run_id=${input.context.runId} for update nowait`;
      await tx`update allrice_employee_runs set method_authoring=true where run_id=${input.context.runId}`;
      const rows = await tx`update allrice_employee_content_contexts c
        set retired_at=coalesce(c.retired_at,clock_timestamp()),updated_at=clock_timestamp()
        from allrice_employee_runs er where er.run_id=${input.context.runId} and er.session_id=${input.sessionId}
          and er.content_generation_id=c.generation_id and c.invalidated_at is null
          and c.organization_id=${scope.organizationId} and c.workspace_id=${scope.workspaceId} and c.owner_id=${scope.actor.id}
        returning c.generation_id`;
      if (!rows.length)
        throw new EmployeeMethodChatError('method_context_unavailable');
    }
    return read(tx, instance, text);
  });
}

export async function inspectEmployeeMethodFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodInspectSchema.parse(input.arguments);
  const { scope } = employeeChatIdentity(input);
  // Candidate body resolution can fail independently; the first transaction's
  // retirement must survive that failure as well.
  if (args.view === 'candidate')
    await enterMethodChat(
      input,
      'workspace.employee.method.inspect',
      true,
      async () => undefined,
    );
  return enterMethodChat(
    input,
    'workspace.employee.method.inspect',
    false,
    async (tx, instance) => {
      const content = await inspectEmployeeMethodContent(
        scope,
        instance.id,
        args.view,
        tx,
      );
      const [run] = await tx<
        {
          employee_id: string;
          prompt_snapshot: { referenceSelections?: unknown };
        }[]
      >`
        select v.employee_id,er.prompt_snapshot from allrice_employee_runs er
        join allrice_employee_versions v on v.id=er.employee_version_id
        where er.run_id=${input.context.runId}`;
      const selectedReferences = [];
      for (const selected of ReferenceSelectionsSchema.parse(
        run?.prompt_snapshot.referenceSelections ?? [],
      )) {
        const reference = {
          sourceKind: 'knowledge' as const,
          contentId: selected.sourceId,
          revisionId: selected.revisionId,
          digest: selected.digest,
        };
        const current = await resolveEmployeeContentSource({
          context: scope,
          employeeId: run!.employee_id,
          ownership: {
            scope: 'personal',
            organizationId: scope.organizationId,
            ownerId: scope.actor.id,
          },
          ref: reference,
          sql: tx,
          lock: true,
          allowDraft: false,
        });
        if (!current.dto.available)
          throw new EmployeeContentError('source_changed');
        selectedReferences.push({
          reference,
          fileName: selected.fileName,
          purpose: selected.purpose,
        });
      }
      // Explicitly selected current-Run pins are data, not permission to bind.
      // Saving still requires the user's separate long-term reference intent.
      return { ...content, selectedReferences };
    },
  );
}

export async function saveEmployeeMethodFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodSaveSchema.parse(input.arguments);
  const { scope, requestId } = employeeChatIdentity(input);
  const { instance, setId, text } = await enterMethodChat(
    input,
    'workspace.employee.method.save_candidate',
    true,
    async (tx, instance, text) => {
      const [set] = await tx<
        { id: string }[]
      >`select id from allrice_employee_content_sets
        where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
          and instance_id=${instance.id} and scope='personal' and owner_id=${scope.actor.id}`;
      return {
        instance,
        text,
        setId: set?.id ?? employeeChatUuid('employee-method', instance.id),
      };
    },
  );
  if (
    !explicitEmployeeMethodIntent(text) ||
    (args.references?.length && !explicitEmployeeMethodReferenceIntent(text))
  )
    throw new EmployeeMethodChatError('explicit_method_request_required');
  const base: Extract<EmployeeContentMutation, { operation: 'save_draft' }> = {
    operation: 'save_draft',
    workspaceId: scope.workspaceId,
    setId,
    requestId,
    ownership: {
      scope: 'personal',
      organizationId: scope.organizationId,
      ownerId: scope.actor.id,
    },
    target: { kind: 'instance', instanceId: instance.id },
    expectedRevision: args.expectedRevision,
    changeSummary: args.changeSummary,
    manifest: emptyManifest(),
    textEdits: [],
  };
  return employeeAccessTransaction(getDatabase(), (tx) =>
    mutateEmployeeContentInTransaction(scope, base, tx, {
      inputDigest: runtimePolicyDigest({
        instanceId: instance.id,
        runId: input.context.runId,
        userMessageId: input.userMessageId,
        arguments: args,
      }),
      authorize: async () => {
        const current = await getEmployeeInstance(scope, instance.id, tx);
        const original = await assertEmployeeChatRun(
          tx,
          input,
          current,
          'workspace.employee.method.save_candidate',
        );
        if (
          !explicitEmployeeMethodIntent(original) ||
          (args.references?.length &&
            !explicitEmployeeMethodReferenceIntent(original))
        )
          throw new EmployeeMethodChatError('explicit_method_request_required');
      },
      buildInput: async (row) => {
        const [revision] =
          row?.candidate_revision_id || row?.active_revision_id
            ? await tx<
                { manifest: unknown }[]
              >`select manifest from allrice_employee_content_revisions
            where id=${row.candidate_revision_id ?? row.active_revision_id}`
            : [];
        const manifest = EmployeeContentManifestSchema.parse(
          revision?.manifest ?? emptyManifest(),
        );
        const sceneId =
          args.section === 'scene'
            ? (args.scene!.id ??
              employeeChatUuid('employee-method-scene', instance.id, requestId))
            : null;
        let scene = manifest.scenes.find((s) => s.id === sceneId);
        if (args.scene?.id && !scene)
          throw new EmployeeContentError('version_conflict');
        if (args.section === 'scene') {
          if (!scene) {
            scene = {
              id: sceneId!,
              name: args.scene!.name,
              appliesWhen: args.scene!.appliesWhen,
              references: [],
            };
            manifest.scenes.push(scene);
          } else
            Object.assign(scene, {
              name: args.scene!.name,
              appliesWhen: args.scene!.appliesWhen,
            });
        }
        const previousRefs = scene?.references ?? manifest.common;
        let updatedRefs: Extract<
          EmployeeContentMutation,
          { operation: 'save_draft' }
        >['manifest']['common'] = [...previousRefs];
        const textEdits: typeof base.textEdits = [];
        for (const [field, kind] of [
          ['requirements', 'requirement'],
          ['procedure', 'procedure'],
        ] as const) {
          const body = args[field];
          if (body === undefined) continue;
          const contentId = employeeChatUuid(
            'employee-method-text',
            instance.id,
            sceneId ?? 'common',
            kind,
          );
          const previous = previousRefs.find((r) => r.contentId === contentId);
          const [asset] = await tx<
            { revision: number; latest_revision_id: string }[]
          >`
          select revision,latest_revision_id from allrice_company_assets where id=${contentId}`;
          if (asset && asset.latest_revision_id !== previous?.revisionId)
            throw new EmployeeContentError('source_changed');
          textEdits.push({
            contentId,
            revisionId: employeeChatUuid(
              'employee-method-text-revision',
              requestId,
              contentId,
            ),
            expectedRevision: asset?.revision ?? 0,
            kind,
            title: `${scene?.name ?? '通用'} · ${kind === 'requirement' ? '执行要求' : '执行流程'}`,
            body,
          });
          updatedRefs = updatedRefs.filter((r) => r.contentId !== contentId);
          updatedRefs.push({ sourceKind: 'draft_text', contentId });
        }
        for (const ref of args.references ?? []) {
          // A reference remains a pinned index, never copied or widened. Current
          // source authority is checked within the same company transaction gate.
          const [assignment] = await tx<
            { employee_id: string }[]
          >`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
          const source = await resolveEmployeeContentSource({
            context: scope,
            employeeId: assignment!.employee_id,
            ownership: base.ownership,
            ref,
            sql: tx,
            lock: true,
            allowDraft: true,
          });
          if (!source.dto.available)
            throw new EmployeeContentError('source_changed');
          if (
            !updatedRefs.some(
              (r) =>
                r.sourceKind !== 'draft_text' &&
                referenceKey(r) === referenceKey(ref),
            )
          )
            updatedRefs.push(ref);
        }
        const draft = {
          ...manifest,
          common: args.section === 'common' ? updatedRefs : manifest.common,
          scenes: manifest.scenes.map((s) =>
            s.id === sceneId ? { ...s, references: updatedRefs } : s,
          ),
        };
        return { ...base, manifest: draft, textEdits };
      },
    }),
  );
}
function referenceKey(ref: EmployeeContentReference) {
  return `${ref.sourceKind}:${ref.contentId}:${ref.revisionId}:${ref.digest}`;
}

/** Used only by the existing checkpoint finalizer, scoped to its exact Run. */
export async function isEmployeeMethodAuthoringRun(scope: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  runId: string;
}) {
  const [row] = await getDatabase()<
    { method_authoring: boolean }[]
  >`select method_authoring from allrice_employee_runs
    where run_id=${scope.runId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}`;
  return row?.method_authoring === true;
}

/** Frozen recall can predate another Run entering authoring. Recheck at the
 * Worker execution boundary, preserving frozen bodies and historical records. */
export async function filterEmployeeMethodMemories<T extends { id: string }>(
  scope: { organizationId: string; workspaceId: string; ownerId: string },
  memories: T[],
): Promise<T[]> {
  if (!memories.length) return memories;
  const rows = await getDatabase()<
    { id: string }[]
  >`select m.id from allrice_memories m
    where m.id=any(${memories.map((m) => m.id)}::uuid[])
      and m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
      and (m.owner_id=${scope.ownerId} or m.visibility<>'private') and m.archived_at is null
      and not exists(select 1 from allrice_employee_runs er
        where er.organization_id=m.organization_id and er.workspace_id=m.workspace_id and er.method_authoring
          and ((m.source_type='message' and m.source_id in (er.user_message_id,er.assistant_message_id))
            or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
              where cp.id=m.source_id and cp.covered_through_message_id in (er.user_message_id,er.assistant_message_id)))))`;
  const readable = new Set(rows.map((row) => row.id));
  return memories.filter((memory) => readable.has(memory.id));
}
