import {
  EmployeeMethodInspectSchema,
  EmployeeMethodSaveSchema,
  EmployeeMethodRestoreSchema,
  EmployeeContentManifestSchema,
  ReferenceSelectionsSchema,
  type EmployeeContentMutation,
  type EmployeeContentReference,
  type EmployeeMethodSharedTarget,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { lockWorkspaceStorageQuota } from '../core/storage-quota.ts';
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
  getEmployeeContentHistoryInTransaction,
  mutateEmployeeContentInTransaction,
} from './employee-content.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';
import {
  resolveEmployeeMethodTarget,
  sharedEmployeeMethodTarget,
  employeeMethodDepartmentChoices,
} from './employee-method-target.ts';
import { namedMethodDepartmentRequest } from './employee-method-department-intent.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';

export class EmployeeMethodChatError extends Error {
  constructor(
    readonly code:
      | 'explicit_method_request_required'
      | 'explicit_method_restore_required'
      | 'explicit_test_retry_required'
      | 'test_retry_not_allowed'
      | 'test_retry_model_changed'
      | 'method_text_target_required'
      | 'method_context_unavailable',
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
    if (quotedPassage) continue;
    const sourceStart =
      /(?:^|[。；;！!])\s*(?:资料|附件|示例|例子|原文|引用|document|example|quotation).*(?:如下|原文|内容|:|：)/iu.exec(
        line.trim(),
      );
    if (sourceStart) {
      if (sourceStart.index > 0)
        lines.push(line.trim().slice(0, sourceStart.index));
      quotedPassage = true;
      continue;
    }
    lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/gu, ' QUOTED ')
    .split(/[。；;！!\n]/)
    .map((clause) => clause.trim());
}

/** Only skip a bounded prior-transport outcome, never arbitrary prose that
 * could introduce instructions from a document, example or another person. */
function withoutMethodRetryPreface(text: string) {
  const request = text.replace(
    /^(?:(?:上次|刚才|上一轮|之前)(?:的)?(?:连接|网络|请求|任务|操作)?(?:失败|中断|断开|超时)(?:了)?(?:(?:后|[，,])?(?:尚未|还未|没有)(?:(?:保存|完成)(?:修改|操作|任务)?|执行(?:修改|操作|任务)))?(?:[，,](?:请)?继续(?:未完成的)?(?:移除操作|操作|任务))?[。！!\n]|(?:网络|连接)(?:失败|中断|断开|断|超时)(?:了)?(?:[，,](?:刚才|之前)?(?:尚未|还未|没有)(?:保存|完成)(?:修改|操作|任务)?)?[。！!\n]|The(?: previous| last)? (?:request|operation|task) (?:failed|timed out|was interrupted)[.!])/iu,
    '',
  );
  if (request === text) return text;
  // Only a recognized transport outcome may introduce this bounded transition.
  // The remainder must still start with an explicit authoring/test request;
  // quoted, indented, explanatory or negated text stays unauthorized.
  return request.replace(
    /^(?:\r?\n)*(?:现在|这次)?(?:请)?(?:只)?(?:继续|续办)(?:这一步|此步骤|原操作)[：:]/u,
    '',
  );
}

/** A colon separates the authoring request from candidate content. */
function methodAuthoringHeader(clause: string) {
  const raw = clause.replace(/^(?:[ \t]*\r?\n)+/, '');
  const request = namedMethodDepartmentRequest(raw)?.normalized ?? raw;
  if (/^(?: {4}|\t)/u.test(request)) return false;
  let first = request.split(/[。；;！!\n：:]/, 1)[0]!.trim();
  // A quoted literal scene name is an argument to an unquoted direct request.
  // Do not unquote an entire instruction, translation or supplied document.
  first = first
    .replace(
      /(?:“[^“”\r\n]{1,80}”|「[^「」\r\n]{1,80}」|『[^『』\r\n]{1,80}』|"[^"\r\n]{1,80}"|`[^`\r\n]{1,80}`)$/u,
      '',
    )
    .trimEnd();
  const named = first.match(
    /^(?<verb>(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制|重命名|移除|删除|停用)(?:我的|这个|该|本人的|本部门的|我们部门的|本公司的|我们公司的|全公司的|公司的)?)(?:“[^“”\r\n]{1,80}”|「[^「」\r\n]{1,80}」|『[^『』\r\n]{1,80}』|"[^"\r\n]{1,80}"|`[^`\r\n]{1,80}`)(?<target>的?(?:工作场景|执行要求|执行流程|工作方法)(?:候选|草稿)?)$/u,
  );
  if (named?.groups)
    first = `${named.groups.verb}字面名称${named.groups.target}`;
  return (
    /^(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制|重命名|移除|删除|停用)(?:[^《》“”"'「」『』`。；;！!\n：:]{0,80})(?:工作场景|执行要求|执行流程|工作方法)(?:候选|草稿)?$/u.test(
      first,
    ) ||
    /^(?:please )?(?:save|update|edit|create|add|customize|rename|remove|delete|disable)\s+(?:(?:my|this|company|our company)\s+)?(?:work )?(?:method|scene|workflow)(?: (?:candidate|draft))?$/i.test(
      first,
    )
  );
}

/** Temporary-use restrictions are not permission for a durable method change.
 * Called only on top-level prose clauses, never quoted candidate/source text. */
function limitsMethodPersistence(clause: string) {
  return (
    /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:仅|只)(?:供|用于|用在|在|限于|限)(?:本次|这次|此次|当前)(?:任务|工作)?(?:中)?(?:使用)?$|^(?:only|just) for (?:this|the current) (?:task|request)[.!]?$/iu.test(
      clause,
    ) ||
    /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|不必|无需|暂不|别|勿|不)(?:长期|永久)(?:保存|持久化)(?:候选|草稿|工作方法|工作场景)?$/iu.test(
      clause,
    )
  );
}

/** Require the leading request, allowing only a known retry preface. */
export function explicitEmployeeMethodIntent(text: string) {
  if (!text.trim() || text.length > 32000) return false;
  const clauses = methodOperationClauses(text).flatMap((clause) =>
    clause.split(/[，,]/u).map((part) => part.trim()),
  );
  if (
    clauses.some((clause) => {
      const affirmative = clause
        .replace(
          /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|不必|无需|暂不|别|勿|不)/u,
          '请',
        )
        .replace(/^(?:please )?(?:do not|don't|never)\s+/iu, 'please ');
      // Quoted names have already been masked as data. Apply the same target
      // grammar to a denial, rather than requiring the type next to “我的”.
      if (
        affirmative !== clause &&
        methodAuthoringHeader(
          affirmative.replace(/\.$/u, '').replace(/\s+QUOTED$/u, ''),
        )
      )
        return true;
      if (limitsMethodPersistence(clause)) return true;
      return /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|不必|无需|暂不|别|勿|不)(?:保存|修改|更新|持久化|重命名|移除|删除|停用)(?:(?:我的)?(?:工作场景|执行要求|执行流程|工作方法|候选|草稿)|[，, ]|$)|^(?:please )?(?:do not|don't|never)\s+(?:save|update|persist|rename|remove|delete|disable)(?:\s+(?:my )?(?:method|scene|workflow|candidate|draft)|[,. ]*$)/iu.test(
        clause,
      );
    })
  )
    return false;
  return methodAuthoringHeader(withoutMethodRetryPreface(text));
}

/** A scene's own requirements never authorize editing the shared common layer.
 * Reuse persistence/source checks, then constrain only the direct target. */
export function explicitEmployeeMethodCommonIntent(text: string) {
  if (!explicitEmployeeMethodIntent(text)) return false;
  const raw = withoutMethodRetryPreface(text).replace(/^(?:[ \t]*\r?\n)+/u, '');
  const request = namedMethodDepartmentRequest(raw)?.normalized ?? raw;
  const header = request.split(/[。；;！!\n：:]/u, 1)[0]!.trim();
  return /^(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制)(?:本部门|我们部门|我的部门|本公司|我们公司|公司|全公司)的?(?:通用|共同|所有场景共用的)执行要求(?:候选|草稿)?$/u.test(
    header,
  );
}

/** Whole-method restore must name the selected immutable version in the user's
 * own leading request. A scene-only request cannot replace the whole manifest. */
export function explicitEmployeeMethodRestoreIntent(
  text: string,
  source: { id: string; number: number },
  scope: 'personal' | 'department' | 'company' = 'personal',
) {
  if (!text.trim() || text.length > 32000) return false;
  const request = withoutMethodRetryPreface(text).replace(
    /^(?:[ \t]*\r?\n)+/u,
    '',
  );
  if (/^(?: {4}|\t)/u.test(request)) return false;
  const clauses = methodOperationClauses(request).flatMap((clause) =>
    clause.split(/[，,：:]/u).map((part) => part.trim()),
  );
  if (
    clauses.some((clause, index) => {
      if (
        /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|不必|无需|暂不|别|勿|不)(?:实际|立即|进行)?(?:恢复|还原|回退|保存|执行)|^(?:please )?(?:do not|don't|never)\s+(?:(?:actually|immediately)\s+)?(?:restore|revert|save|execute)/iu.test(
          clause,
        )
      )
        return true;
      // "Only discuss" limits the action. "Only show differences" may instead
      // limit the reply after an explicit preceding "after saving the candidate".
      if (
        /^(?:请)?(?:先)?(?:只|仅)讨论|^(?:please )?(?:only|just)\s+discuss/iu.test(
          clause,
        ) ||
        limitsMethodPersistence(clause)
      )
        return true;
      if (
        !/^(?:请)?(?:先)?(?:只|仅)(?:展示|查看|解释|分析)|^(?:please )?(?:only|just)\s+(?:show|view|explain|analyze)/iu.test(
          clause,
        )
      )
        return false;
      return !clauses
        .slice(0, index)
        .some((prior) =>
          /^(?:请)?(?:先)?保存(?:为)?(?:新的?)?候选(?:后|之后|以后)$|^after saving (?:the |a |a new )?candidate$/iu.test(
            prior,
          ),
        );
    })
  )
    return false;
  if (
    methodOperationClauses(request)
      .flatMap((c) => c.split(/[，,：:]/u))
      .some((c) =>
        /(?:只|仅)(?:恢复|还原|回退)(?!我的整份工作方法|个人整份工作方法|整份工作方法)|(?:场景|执行要求|执行流程).{0,12}(?:保持不变|保留原样|不要修改)|only\s+(?:restore|revert)\s+(?!my entire work method)|(?:keep|leave).{0,60}(?:scene|procedure|requirement).{0,20}unchanged/iu.test(
          c.trim(),
        ),
      )
  )
    return false;
  if (employeeMethodRequestedScope(request) !== scope) return false;
  const normalized =
    namedMethodDepartmentRequest(request)?.normalized ?? request;
  const header = normalized.split(/[。；;！!\n，,：:]/u, 1)[0]!.trim();
  const match =
    header.match(
      /^(?:请)?(?:为我|帮我)?(?:恢复|还原|回退)(?:我的|个人|本部门|我们部门|我的部门|本公司|我们公司|全公司|公司)(?:的)?(?:整份)?工作方法(?:候选)?(?:到|至|为)(?:第\s*([1-9]\d*)\s*版|[rv]([1-9]\d*)|版本\s+([a-f0-9-]{36}))$/iu,
    ) ??
    header
      .replace(/\.$/u, '')
      .match(
        /^(?:please )?(?:restore|revert) (?:my|(?:our )?company) (?:entire )?work method(?: candidate)? to (?:(?:revision|version) ([1-9]\d*)|[rv]([1-9]\d*)|version-id ([a-f0-9-]{36}))$/iu,
      );
  return (
    !!match &&
    (match[3]
      ? match[3].toLowerCase() === source.id.toLowerCase()
      : Number(match[1] ?? match[2]) === source.number)
  );
}

function methodTestRequest(text: string) {
  const request = withoutMethodRetryPreface(text);
  const normalized = request
    .replace(/^((?:请)?(?:为我|帮我)?)(?:验证|测试)/u, '$1更新')
    .replace(/^(please )?(?:test|validate)\s+/i, '$1update ');
  return { request, normalized };
}

export function explicitEmployeeMethodTestIntent(text: string) {
  const { request, normalized } = methodTestRequest(text);
  return (
    normalized !== request &&
    !methodOperationClauses(request)
      .flatMap((c) => c.split(/[，,]/u).map((p) => p.trim()))
      .some((c) =>
        /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|不必|无需|暂不|别|勿|不)(?:测试|验证)|^(?:please )?(?:do not|don't|never) (?:test|validate)/iu.test(
          c,
        ),
      ) &&
    explicitEmployeeMethodIntent(normalized.replace(/\.(?=\s*$)/u, ''))
  );
}

export function explicitEmployeeMethodCommonTestIntent(text: string) {
  return (
    explicitEmployeeMethodTestIntent(text) &&
    explicitEmployeeMethodCommonIntent(methodTestRequest(text).normalized)
  );
}

/** A new paid attempt needs a direct request naming this exact failed test.
 * An identifier in backticks is allowed; instructions inside quotations are not. */
export function explicitEmployeeMethodTestRetryIntent(
  text: string,
  testId: string,
) {
  if (!text.trim() || text.length > 32000) return false;
  const request = withoutMethodRetryPreface(text).replace(
    /^(?:[ \t]*\r?\n)+/u,
    '',
  );
  if (/^(?: {4}|\t)/u.test(request)) return false;
  if (
    methodOperationClauses(request)
      .flatMap((clause) => clause.split(/[，,.]/u))
      .some((clause) =>
        /^(?:请)?(?:不要|无需|不必|勿|不能|不允许)(?:重试|重跑|重新(?:运行|执行)|测试|验证|运行|执行)|^(?:please )?(?:do not|don't|never)\s+(?:retry|rerun|test|validate|run|execute)/iu.test(
          clause.trim(),
        ),
      )
  )
    return false;
  const first = request.split(/[。；;！!\n，,]/u, 1)[0]!.trim();
  const match =
    /^(?:(?:请)?(?:为我|帮我)?(?:重试|重跑|重新运行|重新执行)(?:这个)?(?:专项|候选)?测试|(?:please )?(?:retry|rerun) (?:the )?(?:candidate )?test)[：:\s]*(`?)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\1$/iu.exec(
      first.replace(/\.(?=\s*$)/u, ''),
    );
  return match?.[2]?.toLowerCase() === testId.toLowerCase();
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
      (/^(?:请)?(?:(?:为我|帮我|在这个场景中)[，, ]*)?(?:(?:将|把).{1,80}(?:长期引用|长期绑定|长期使用)(?:(?:到|至|于|在).{1,120})?|(?:长期引用|长期绑定|长期使用).{1,80})$/u.test(
        clause.trim(),
      ) &&
        !/(?:这|那|该|此)(?:句话?|段(?:话|文字)?|个句子)|(?:改写|翻译|润色)(?:这|那|该|此|上述|上面)|(?:措辞|表述|句子|说法).{0,16}(?:改|调|译|写)/u.test(
          clause,
        ) &&
        !/^(?:[“"'>]|例如|示例|引用|翻译|资料|附件写)/u.test(clause.trim())) ||
      /^(?:please )?(?:permanently|for future tasks) (?:bind|reference|use)\b/i.test(
        clause.trim(),
      ),
  );
}

/** Removing an index is a separate user intent. It never deletes the source
 * or changes active content, but must not be inferred from an ordinary edit. */
export function explicitEmployeeMethodRemovalIntent(
  text: string,
  kind: 'scene' | 'reference',
) {
  const clauses = methodOperationClauses(withoutMethodRetryPreface(text))
    .filter(Boolean)
    .map((s, index) => {
      const colon = s.search(/[：:]/);
      // Unwrap only the leading request after the bounded retry preface.
      return index === 0 && colon >= 0 && methodAuthoringHeader(s)
        ? s.slice(colon + 1).trim()
        : s;
    });
  const target =
    kind === 'scene'
      ? /场景|\bscene\b/iu
      : /资料|引用|绑定|\breference\b|\bbinding\b/iu;
  if (
    clauses.some(
      (s) =>
        target.test(s) &&
        /^(?:请)?(?:不要|无需|不必|勿|不能|不允许).*(?:移除|删除|停用|解除|取消|替换)|^(?:please )?(?:do not|don't|never)\b.*\b(?:remove|delete|disable|unlink|replace)\b/iu.test(
          s,
        ),
    )
  )
    return false;
  return clauses.some((s) => {
    const chinese =
      /^(?:请)?(?:(?:从|在)(?:当前|我的|这个|该)?(?:候选|草稿)(?:中)?[，, ]*)?(?:移除|删除|停用|解除|取消|替换)\s*(.{1,120})$/u.exec(
        s,
      );
    if (chinese) {
      const object = chinese[1]!.trim();
      // An ambiguous compound instruction must never authorize removal of
      // the entire container ("delete steps, preserve this scene").
      if (
        /中的|内的|里的|下的|里面|内部|步骤|空行|段落|内容|文字|文本|保留|保持|检查|核对|然后|之后|再|并|[：:,，、]/u.test(
          object,
        )
      )
        return false;
      return kind === 'scene'
        ? /场景(?:候选)?$|^(?:这个|该|我的|当前)?(?:工作)?场景\s*QUOTED$/u.test(
            object,
          )
        : /资料(?:引用|绑定)?$|(?:引用|绑定)$|^(?:这个|该|我的|当前)?(?:资料)?(?:引用|绑定)\s*QUOTED$/u.test(
            object,
          );
    }
    const english =
      /^(?:please )?(?:remove|delete|disable|unlink|replace)\s+(.{1,120})$/iu.exec(
        s,
      );
    if (!english) return false;
    const object = english[1]!.trim().replace(/[.!?]+$/, '');
    if (
      /[,;]|\b(?:from|within|inside|in|of|for|steps?|lines?|content|text|keep|preserve|retain|then|and|but)\b/iu.test(
        object,
      )
    )
      return false;
    return kind === 'scene'
      ? /\bscene(?:\s+QUOTED)?$/iu.test(object)
      : /\b(?:reference|binding)(?:\s+QUOTED)?$/iu.test(object);
  });
}

/** Sharing needs explicit scope in the direct request. Candidate body, quoted
 * source text and an employee's maintenance level cannot supply that consent. */
export function employeeMethodRequestedScope(text: string) {
  const raw = withoutMethodRetryPreface(text).replace(/^(?:[ \t]*\r?\n)+/u, '');
  const request = namedMethodDepartmentRequest(raw)?.normalized ?? raw;
  const clauses = methodOperationClauses(request);
  const leading = (clauses.find(Boolean) ?? '').split(/[：:]/u, 1)[0]!;
  const object = leading
    .replace(
      /^(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制|重命名|移除|删除|停用|测试|验证|恢复|还原|回退)/u,
      '',
    )
    .trim();
  // The scope is the direct grammatical target, not a keyword in an object
  // name or an explanation that expressly excludes sharing.
  const department =
    /^(?:本部门|我们部门|我的部门)(?:的|\s|整份|工作|执行|(?:通用|共同|所有场景共用的)执行要求|QUOTED)/u.test(
      object,
    );
  const company =
    /^(?:本公司|我们公司|全公司|公司)(?:的|\s|整份|工作|执行|(?:通用|共同|所有场景共用的)执行要求|QUOTED)/u.test(
      object,
    ) ||
    /^(?:please )?(?:save|update|edit|create|add|customize|rename|remove|delete|disable|test|validate)\s+(?:our )?company\s+(?:work )?(?:method|scene|workflow)(?: (?:candidate|draft))?[.!]?$/iu.test(
      leading,
    ) ||
    /^(?:please )?(?:restore|revert) (?:our )?company (?:entire )?work method(?: candidate)? to /iu.test(
      leading,
    );
  const personalOnly = clauses.some((clause) =>
    /(?:仅供|仅限|只供|只给|只为)(?:我(?:个人|自己)?|个人)(?:使用|[，,；;]|$)|(?:而非|不是|不在)(?:本部门|我们部门|部门|本公司|我们公司|公司)(?:的)?共享/u.test(
      clause,
    ),
  );
  const noSharing = clauses.some((clause) =>
    clause.split(/[，,]/u).some((part) => {
      const denial =
        /^(?:请)?(?:(?:先|暂时|这次|本次)\s*){0,2}(?:不要|不允许|不能|无需|暂不|别|勿|不)(?:(?:在|向)(?<target>.{1,200}?))?共享(?:[。.!]?|(?:这个|该|我的)?(?:候选|工作方法|工作场景))$/u.exec(
          part.trim(),
        );
      if (!denial) return false;
      const target = denial.groups?.target?.replace(/\s+/gu, '');
      // Reuse the positive target grammar for names and IDs, including names
      // masked as QUOTED by the source-text boundary. Do not maintain a second
      // list of accepted department-name endings just for denials.
      return (
        !target ||
        /^(?:本部门|我们部门|我的部门|部门|本公司|我们公司|全公司|公司)$/u.test(
          target,
        ) ||
        namedMethodDepartmentRequest(`保存${target}的工作方法`) !== null
      );
    }),
  );
  if (department)
    return personalOnly || noSharing ? 'unsupported' : 'department';
  if (/^(?:我的|个人|仅供我(?:个人|自己)?使用)/u.test(object))
    return 'personal';
  if (company) return personalOnly || noSharing ? 'unsupported' : 'company';
  if (/部门|department|公司|全员|company|everyone/iu.test(leading))
    return 'unsupported';
  return 'personal';
}

/** A model-selected ID cannot substitute for the user's target. Own-department
 * wording stays bound to current membership even for a company maintainer. */
export async function assertEmployeeMethodDepartmentRequest(
  context: Parameters<typeof sharedEmployeeMethodTarget>[0],
  instanceId: string,
  shared: EmployeeMethodSharedTarget | undefined,
  text: string,
  tx: ContentTx,
) {
  if (shared?.scope !== 'department') return;
  const selection = await resolveEmployeeMethodTarget(
    context,
    instanceId,
    shared,
    tx,
  );
  const request = withoutMethodRetryPreface(text).replace(
    /^(?:[ \t]*\r?\n)+/u,
    '',
  );
  const named = namedMethodDepartmentRequest(request);
  const { departments, ownDepartmentId } =
    await employeeMethodDepartmentChoices(context, tx);
  const selected = departments.find((d) => d.id === shared.departmentId);
  const matches =
    named?.kind === 'id'
      ? named.value.toLowerCase() === selected?.id
      : named?.kind === 'name'
        ? named.value === selected?.name &&
          departments.filter((d) => d.name === named.value).length === 1
        : ownDepartmentId === shared.departmentId;
  if (!matches || selection.audience?.departmentName !== selected?.name)
    throw new EmployeeMethodChatError('explicit_method_request_required');
}

function assertMethodEditIntent(
  text: string,
  args: ReturnType<typeof EmployeeMethodSaveSchema.parse>,
) {
  if (
    !explicitEmployeeMethodIntent(text) ||
    employeeMethodRequestedScope(text) !==
      (args.sharedTarget?.scope ?? 'personal') ||
    (args.sharedTarget &&
      args.section === 'common' &&
      !explicitEmployeeMethodCommonIntent(text)) ||
    (args.references?.length && !explicitEmployeeMethodReferenceIntent(text)) ||
    (args.removeReferences?.length &&
      !explicitEmployeeMethodRemovalIntent(text, 'reference')) ||
    (args.operation === 'remove_scene' &&
      !explicitEmployeeMethodRemovalIntent(text, 'scene'))
  )
    throw new EmployeeMethodChatError('explicit_method_request_required');
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
export async function enterMethodChat<T>(
  input: EmployeeChatCall,
  tool: string,
  retire: boolean,
  read: (
    tx: ContentTx,
    instance: Awaited<ReturnType<typeof getEmployeeInstance>>,
    text: string,
  ) => Promise<T>,
  options: { reserveStorage?: boolean } = {},
) {
  const { scope } = employeeChatIdentity(input);
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    if (options.reserveStorage)
      await lockWorkspaceStorageQuota(
        tx,
        scope.organizationId,
        scope.workspaceId,
      );
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
  if (args.view !== 'effective')
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
      const choices =
        args.scope === 'department'
          ? await employeeMethodDepartmentChoices(scope, tx)
          : undefined;
      if (choices && !args.departmentId && !choices.ownDepartmentId) {
        const principal = await readContentPrincipal(scope, tx, true);
        if (principal?.maintenanceLevel !== 'company')
          throw new DataAccessError('authorization_denied');
        return {
          view: args.view,
          scope: 'department' as const,
          selectionRequired: true,
          departments: choices.departments,
          sharedTarget: null,
          selectedReferences: [],
        };
      }
      const selected =
        args.scope === 'department' || args.scope === 'company'
          ? await sharedEmployeeMethodTarget(
              scope,
              instance.id,
              args.scope,
              tx,
              args.departmentId,
            )
          : undefined;
      if (args.view === 'history') {
        const selection =
          selected ??
          (await resolveEmployeeMethodTarget(
            scope,
            instance.id,
            undefined,
            tx,
          ));
        const [set] = await tx<
          { id: string }[]
        >`select id from allrice_employee_content_sets
          where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
            and id=${selection.setId}`;
        const history = set
          ? await getEmployeeContentHistoryInTransaction(
              scope,
              set.id,
              args.beforeRevision,
              tx,
            )
          : {
              setId: null,
              revision: 0,
              activeRevisionId: null,
              candidateRevisionId: null,
              revisions: [],
              nextBeforeRevision: null,
            };
        return {
          ...history,
          ...(selected
            ? {
                sharedTarget: selected.sharedTarget,
                audience: selected.audience,
              }
            : {}),
          ...(choices ? { departments: choices.departments } : {}),
          view: 'history' as const,
          instanceId: instance.id,
          selectedReferences: [],
        };
      }
      const content = await inspectEmployeeMethodContent(
        scope,
        instance.id,
        args.view,
        tx,
        selected?.sharedTarget,
        args.beforeTestId,
      );
      if (selected)
        return {
          ...content,
          ...(choices ? { departments: choices.departments } : {}),
          selectedReferences: [],
        };
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

export async function restoreEmployeeMethodFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodRestoreSchema.parse(input.arguments);
  const { scope, requestId } = employeeChatIdentity(input);
  const tool = 'workspace.employee.method.restore_candidate';
  const { instance, selection } = await enterMethodChat(
    input,
    tool,
    true,
    async (tx, instance) => {
      return {
        instance,
        selection: await resolveEmployeeMethodTarget(
          scope,
          instance.id,
          args.sharedTarget,
          tx,
        ),
      };
    },
  );
  return employeeAccessTransaction(getDatabase(), (tx) =>
    mutateEmployeeContentInTransaction(
      scope,
      {
        operation: 'restore_draft',
        workspaceId: scope.workspaceId,
        setId: selection.setId,
        requestId,
        ownership: selection.ownership,
        target: selection.target,
        expectedRevision: args.expectedRevision,
        sourceRevisionId: args.sourceRevisionId,
        changeSummary: args.changeSummary,
      },
      tx,
      {
        inputDigest: runtimePolicyDigest({
          instanceId: instance.id,
          runId: input.context.runId,
          userMessageId: input.userMessageId,
          arguments: args,
        }),
        authorize: async () => {
          await resolveEmployeeMethodTarget(
            scope,
            instance.id,
            args.sharedTarget,
            tx,
          );
          const current = await getEmployeeInstance(scope, instance.id, tx);
          const original = await assertEmployeeChatRun(
            tx,
            input,
            current,
            tool,
          );
          const [source] = await tx<
            { id: string; number: number }[]
          >`select id,number from allrice_employee_content_revisions
          where id=${args.sourceRevisionId} and set_id=${selection.setId}`;
          if (!source) throw new DataAccessError('not_found');
          if (
            !explicitEmployeeMethodRestoreIntent(
              original,
              source,
              selection.ownership.scope,
            )
          )
            throw new EmployeeMethodChatError(
              'explicit_method_restore_required',
            );
          await assertEmployeeMethodDepartmentRequest(
            scope,
            instance.id,
            args.sharedTarget,
            original,
            tx,
          );
        },
      },
    ),
  );
}

export async function saveEmployeeMethodFromChat(input: EmployeeChatCall) {
  const args = EmployeeMethodSaveSchema.parse(input.arguments);
  const { scope, requestId } = employeeChatIdentity(input);
  if (
    args.sharedTarget &&
    (args.references?.length || args.removeReferences?.length)
  )
    throw new DataAccessError('authorization_denied');
  const { instance, selection, text } = await enterMethodChat(
    input,
    'workspace.employee.method.save_candidate',
    true,
    async (tx, instance, text) => {
      return {
        instance,
        text,
        selection: await resolveEmployeeMethodTarget(
          scope,
          instance.id,
          args.sharedTarget,
          tx,
        ),
      };
    },
  );
  assertMethodEditIntent(text, args);
  const base: Extract<EmployeeContentMutation, { operation: 'save_draft' }> = {
    operation: 'save_draft',
    workspaceId: scope.workspaceId,
    setId: selection.setId,
    requestId,
    ownership: selection.ownership,
    target: selection.target,
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
        await resolveEmployeeMethodTarget(
          scope,
          instance.id,
          args.sharedTarget,
          tx,
        );
        assertMethodEditIntent(original, args);
        await assertEmployeeMethodDepartmentRequest(
          scope,
          instance.id,
          args.sharedTarget,
          original,
          tx,
        );
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
              employeeChatUuid(
                'employee-method-scene',
                selection.identitySeed,
                requestId,
              ))
            : null;
        let scene = manifest.scenes.find((s) => s.id === sceneId);
        if (args.scene?.id && !scene)
          throw new EmployeeContentError('version_conflict');
        if (args.operation === 'remove_scene') {
          return {
            ...base,
            manifest: {
              ...manifest,
              scenes: manifest.scenes.filter((s) => s.id !== sceneId),
            },
          };
        }
        if (args.section === 'scene') {
          if (!scene) {
            scene = {
              id: sceneId!,
              name: args.scene!.name!,
              appliesWhen: args.scene!.appliesWhen!,
              references: [],
            };
            manifest.scenes.push(scene);
          } else {
            if (args.scene!.name !== undefined) scene.name = args.scene!.name;
            if (args.scene!.appliesWhen !== undefined)
              scene.appliesWhen = args.scene!.appliesWhen;
          }
        }
        const previousRefs = scene?.references ?? manifest.common;
        let updatedRefs: Extract<
          EmployeeContentMutation,
          { operation: 'save_draft' }
        >['manifest']['common'] = [...previousRefs];
        for (const ref of args.removeReferences ?? []) {
          if (
            !previousRefs.some((old) => referenceKey(old) === referenceKey(ref))
          )
            throw new EmployeeContentError('version_conflict');
          updatedRefs = updatedRefs.filter(
            (old) =>
              old.sourceKind === 'draft_text' ||
              referenceKey(old) !== referenceKey(ref),
          );
        }
        const textEdits: typeof base.textEdits = [];
        for (const [field, kind] of [
          ['requirements', 'requirement'],
          ['procedure', 'procedure'],
        ] as const) {
          const body = args[field];
          if (body === undefined) continue;
          const stableContentId = employeeChatUuid(
            'employee-method-text',
            selection.identitySeed,
            sceneId ?? 'common',
            kind,
          );
          const previous = previousRefs.find(
            (r) => r.contentId === stableContentId,
          );
          const replacements = (args.replaceTextReferences ?? []).filter(
            (ref) => ref.sourceKind === kind,
          );
          // Old API/migration-authored text has its own identity. Do not
          // silently append a conflicting chat procedure beside it. The model
          // must identify the exact existing text it is replacing in this
          // candidate; source assets and historical revisions stay untouched.
          if (
            !previous &&
            !replacements.length &&
            previousRefs.some((ref) => ref.sourceKind === kind)
          )
            throw new EmployeeMethodChatError('method_text_target_required');
          for (const ref of replacements) {
            if (
              !previousRefs.some(
                (old) => referenceKey(old) === referenceKey(ref),
              )
            )
              throw new EmployeeContentError('version_conflict');
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
            updatedRefs = updatedRefs.filter(
              (old) =>
                old.sourceKind === 'draft_text' ||
                referenceKey(old) !== referenceKey(ref),
            );
          }
          // An explicit replacement forks only the selected pins, including an
          // older published pin restored from history. Never overwrite its asset
          // or move its latest pointer. Further edits can replace this fork too.
          const contentId = replacements.length
            ? employeeChatUuid(
                'employee-method-text-replacement',
                requestId,
                selection.identitySeed,
                sceneId ?? 'common',
                kind,
              )
            : stableContentId;
          const [asset] = await tx<
            { revision: number; latest_revision_id: string }[]
          >`
          select revision,latest_revision_id from allrice_company_assets where id=${contentId}`;
          if (
            asset &&
            (replacements.length ||
              asset.latest_revision_id !== previous?.revisionId)
          )
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
          if (
            updatedRefs.some(
              (old) =>
                old.sourceKind !== 'draft_text' &&
                old.sourceKind === ref.sourceKind &&
                old.contentId === ref.contentId &&
                referenceKey(old) !== referenceKey(ref),
            )
          )
            throw new EmployeeContentError('version_conflict');
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
