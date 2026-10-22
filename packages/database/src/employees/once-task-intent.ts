import { scheduleConversationIntent } from './schedule-conversation-intent.ts';
import type { AutomationConversationMode } from '@allrice/contracts';

export type OnceTaskIntent = {
  delayMinutes: number;
  /** Exact human request, including the source request of a confirmed exchange. */
  authoritativeRequest: string;
  conversationMode?: AutomationConversationMode;
};

const maximumDelayMinutes = 525_600;
const chineseDigits = '零一二三四五六七八九';
const chineseUnits: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1_000,
};
const minuteUnits: Readonly<Record<string, number>> = {
  分钟: 1,
  小时: 60,
  天: 1_440,
};
const numberPattern = '[0-9零〇一二两三四五六七八九十百千万]+';
const requestPrefix = '(?:请\\s*|麻烦(?:你)?\\s*)?(?:(?:帮我|为我)\\s*)?';
const schedulePrefix = `(?:${requestPrefix}(?:给我\\s*)?(?:搞|建|创建|设置|设|安排|添加|定)(?:一)?(?:个|条)?(?:定时任务|一次性任务|定时提醒|提醒|任务)\\s*[，,:：。]?\\s*)?`;
const relativeRequest = new RegExp(
  `^${schedulePrefix}${requestPrefix}(?:(?:从现在(?:起|开始)?|现在开始)\\s*)?(?:在\\s*|再?过\\s*)?(${numberPattern})\\s*(分钟|小时|天)(?:之后|以后|后)?\\s*[，,:：]?\\s*(.+)$`,
  'su',
);
const reminderRequest = new RegExp(
  `^${requestPrefix}(提醒(?:我|我们)|告诉(?:我|我们)|通知(?:我|我们))\\s*(?:在\\s*|再?过\\s*)?(${numberPattern})\\s*(分钟|小时|天)(?:之后|以后|后)\\s*[，,:：]?\\s*(.+)$`,
  'su',
);

function chineseInteger(value: number, omitLeadingOne = true): string {
  if (value >= 10_000) {
    const rest = value % 10_000;
    return `${chineseInteger(Math.floor(value / 10_000))}万${rest ? `${rest < 1_000 ? '零' : ''}${chineseInteger(rest, false)}` : ''}`;
  }
  let result = '';
  let zero = false;
  for (const [unit, label] of [
    [1_000, '千'],
    [100, '百'],
    [10, '十'],
    [1, ''],
  ] as const) {
    const digit = Math.floor(value / unit);
    value %= unit;
    if (!digit) {
      if (result && value) zero = true;
      continue;
    }
    if (zero) result += '零';
    if (!(omitLeadingOne && !result && unit === 10 && digit === 1))
      result += chineseDigits[digit];
    result += label;
    zero = false;
  }
  return result;
}

function positiveInteger(literal: string): number | null {
  if (/^[1-9][0-9]*$/u.test(literal)) {
    const number = Number(literal);
    return Number.isSafeInteger(number) && number <= maximumDelayMinutes
      ? number
      : null;
  }
  const normalized = literal.replaceAll('两', '二').replaceAll('〇', '零');
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of normalized) {
    const value = chineseDigits.indexOf(character);
    if (value >= 0) digit = value;
    else if (character === '万') {
      total += (section + digit) * 10_000;
      section = digit = 0;
    } else {
      const unit = chineseUnits[character];
      if (!unit) return null;
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  const number = total + section + digit;
  // A round trip rejects malformed/ambiguous forms such as 一百二 or 一二十.
  return number > 0 &&
    number <= maximumDelayMinutes &&
    chineseInteger(number) === normalized
    ? number
    : null;
}

/** Keep quoted task arguments as data while checking the surrounding request.
 * Never unwrap an entire quotation into a new leading instruction. */
function maskQuotedArguments(text: string): string | null {
  const pairs: Readonly<Record<string, string>> = {
    '“': '”',
    '「': '」',
    '『': '』',
    '"': '"',
    "'": "'",
    '`': '`',
  };
  const stack: string[] = [];
  let result = '';
  for (const character of text) {
    if (stack.at(-1) === character) {
      stack.pop();
      if (!stack.length) result += '字面内容';
    } else if (pairs[character]) stack.push(pairs[character]!);
    else if ('”」』'.includes(character)) return null;
    else if (!stack.length) result += character;
  }
  return stack.length ? null : result;
}

function onceQualifier(clause: string): boolean {
  return (
    /^(?:请)?(?:实际)?(?:创建|安排|预约)(?:一个)?一次性任务$/u.test(clause) ||
    /^(?:请)?(?:不要|别|无需)(?:现在|立即|马上)执行$/u.test(clause) ||
    /^(?:请)?(?:只|仅)(?:执行|运行|提醒)一次$/u.test(clause) ||
    /^(?:请)?(?:不要|无需)(?:长期|永久)保存(?:我的)?(?:偏好|设置)$/u.test(
      clause,
    )
  );
}

function taskClause(clause: string): boolean {
  const request = clause
    .replace(/^(?:请)?(?:然后|最后|同时|并且|并|再)\s*/u, '')
    .replace(/^(?:请)?(?:帮我|为我)\s*/u, '')
    .replace(
      /^(?:请)?(?:在(?:这个|当前)(?:对话|会话)(?:中|里)?|在此(?:对话|会话))\s*/u,
      '',
    );
  const match = request.match(
    /^(?:请)?(?:只|仅)?(?:回复|回答|提醒|告诉|通知|检查|整理|生成|汇总|查询|查找|总结|读取|列出|编写|执行|完成|发送|翻译|给出|附上|使用|分成|保持)(.+)$/u,
  );
  return Boolean(
    match &&
    !/^(?:我|一下|我一下|一下我|任务|这个任务)?$/u.test(match[1]!.trim()),
  );
}

/** Recognize one explicit relative-time request without requiring time-first
 * wording. Only a server-loaded human message may be passed here. Its
 * provenance, tenant/frozen/live authority and exact tool delay are checked by
 * the caller. Unsupported or uncertain requests need clarification, not a guess.
 */
export function explicitOnceTaskIntent(text: string): OnceTaskIntent | null {
  if (
    !text.trim() ||
    text.length > 32_000 ||
    // Reject hidden control characters rather than silently changing authority.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(
      text,
    ) ||
    /(?:^|\n)(?:[ \t]*>| {4}| {0,3}\t)|```|~~~/u.test(text)
  )
    return null;
  const selection = scheduleConversationIntent(text);
  const prose = maskQuotedArguments(selection.request);
  if (prose === null) return null;
  const reminder = prose.trim().match(reminderRequest);
  const match = reminder
    ? [reminder[0], reminder[2], reminder[3], `${reminder[1]}${reminder[4]}`]
    : prose.trim().match(relativeRequest);
  if (!match) return null;
  const number = positiveInteger(match[1]!);
  const minutes =
    number === null ? null : number * (minuteUnits[match[2]!] ?? 0);
  if (!minutes || minutes > maximumDelayMinutes) return null;
  const clauses = match[3]!
    .split(/[。；;！!，,\n.]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (!clauses.length || onceQualifier(clauses[0]!)) return null;
  let work = false;
  for (const clause of clauses) {
    if (onceQualifier(clause)) continue;
    if (
      /[?？]|如果|假如|若|除非|倘|视情况|看情况|有空|(?:不要|不用|不必|无需|不能|不允许|暂不|别|勿)|每|定期|循环|周期|反复|重复|长期|永久|默认|今后|以后|大约|大概|左右|差不多|稍后|待会|等会|过会|尽快|至少|至多|最迟|不超过|或者|是否|怎么|如何|能否|可否|(?:吗|么|呢|行不行|好不好|可不可以)$|只是示例|仅作示例|仅供参考|刚才|上次|之前|上述|上面|同上|照旧/u.test(
        clause,
      ) ||
      new RegExp(
        `${numberPattern}\\s*(?:秒|分(?:钟)?|小时|天|周|个月|月|年)(?:之后|以后|后|内|前)|明天|后天|(?:[0-9零一二两三四五六七八九十]+\\s*[点时](?:整|钟|回复|提醒|执行|发送|$)|[0-9]{1,2}[:：][0-9]{2})`,
        'u',
      ).test(clause) ||
      !taskClause(clause)
    )
      return null;
    work = true;
  }
  return work
    ? {
        delayMinutes: minutes,
        authoritativeRequest: text,
        ...(selection.conversationMode === undefined
          ? {}
          : { conversationMode: selection.conversationMode }),
      }
    : null;
}

export function isOnceTaskConfirmationReply(text: string): boolean {
  return /^(?:是(?:的)?|对(?:的)?|确认(?:了)?|没错|好(?:的)?|可以|就这样|就这么办|嗯(?:嗯)?|ok|okay)[。.!！\s]*$/iu.test(
    text.trim(),
  );
}

/** A short answer can confirm the preceding human's complete request. The
 * assistant question only links the exchange; it never supplies task authority.
 * SQL callers must verify adjacency, human provenance and no prior enrollment.
 */
export function confirmedOnceTaskIntent(
  reply: string,
  request: string,
  question: string,
): OnceTaskIntent | null {
  if (
    !isOnceTaskConfirmationReply(reply) ||
    !/(?:确认|是否|对吗|对不对|好吗|好不好|可以吗|要不要|是不是)/u.test(
      question,
    ) ||
    !/[?？]/u.test(question)
  )
    return null;
  const intent = explicitOnceTaskIntent(request);
  if (!intent) return null;
  // Do not treat agreement with a changed time as agreement with the original.
  const proposedTimes = question
    .replace(/[*_]/gu, '')
    .matchAll(
      new RegExp(
        `(${numberPattern})\\s*(分钟|小时|天)(?:之后|以后|后|(?=\\s*(?:提醒|回复|告诉|通知|执行)))`,
        'gu',
      ),
    );
  for (const time of proposedTimes) {
    const value = positiveInteger(time[1]!);
    if (
      value === null ||
      value * minuteUnits[time[2]!]! !== intent.delayMinutes
    )
      return null;
  }
  return intent;
}
