import type { RecurringScheduleRule } from '@allrice/contracts';

export type RecurringTaskIntent = {
  rule: RecurringScheduleRule;
  /** Exact current human message, never a model-selected task body. */
  authoritativeRequest: string;
};

const maximumSeconds = 31_536_000;
const maximumNumber = maximumSeconds / 60;
const chineseDigits = '零一二三四五六七八九';
const chineseUnits: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1_000,
};
const secondsPerUnit: Readonly<Record<string, number>> = {
  分钟: 60,
  小时: 3_600,
  天: 86_400,
};
const numberPattern = '[0-9零〇一二两三四五六七八九十百千万]+';
const requestPrefix = '(?:请\\s*|麻烦(?:你)?\\s*)?(?:(?:帮我|为我)\\s*)?';
const everyRequest = new RegExp(
  `^${requestPrefix}每(?:隔)?\\s*(${numberPattern})\\s*(分钟|小时|天)\\s*[，,:：]?\\s*(.+)$`,
  'su',
);
// A named IANA zone (including its explicit UTC identifier), never a local
// abbreviation, numeric offset, browser default or historical preference.
const zonePattern = '(?:[A-Za-z_+-]+(?:/[A-Za-z0-9_+-]+)+|UTC)';
const dailyRequest = new RegExp(
  `^${requestPrefix}(?:每天|每日)\\s*((?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?)\\s*[，,]?\\s*(?:时区\\s*[:：]?\\s*)?(${zonePattern})\\s*[，,:：]?\\s*(.+)$`,
  'su',
);
const weeklyRequest = new RegExp(
  `^${requestPrefix}每(?:周|星期)\\s*([一二三四五六日天](?:\\s*[、,，和及]\\s*(?:周|星期)?[一二三四五六日天])*)\\s*[，,]?\\s*((?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?)\\s*[，,]?\\s*(?:时区\\s*[:：]?\\s*)?(${zonePattern})\\s*[，,:：]?\\s*(.+)$`,
  'su',
);
const otherTime = new RegExp(
  `${numberPattern}\\s*(?:秒|分(?:钟)?|小时|天|周|个月|月|年)(?:之后|以后|后|内|前)|${numberPattern}\\s*次|[0-9]{1,2}[:：][0-9]{2}|[0-9零一二两三四五六七八九十]+\\s*[点时](?:整|钟|回复|提醒|执行|发送|$)|[0-9]{4}[-/年][0-9]{1,2}`,
  'u',
);
const actionPattern =
  '(?:回复|回答|提醒|告诉|检查|整理|生成|汇总|查询|查找|总结|读取|列出|编写|执行|完成|发送|翻译|给出|附上|使用|保持|创建|安排|预约|设置|登记|启用|开启|运行|调度|通知|发消息)';
// Match instruction syntax, not individual characters in work objects such as
// 人才、若干、不同、每日订单、工作文档 or 重复订单.
const conditionalInstruction = new RegExp(
  `如果|假如|除非|倘若|只要|只有|一旦|即使|(?:假设|若)(?:我|你|有|无|已|未|不|没|需|要|能|可)|(?:才|就)(?:再)?${actionPattern}|视情况|看情况|有空|有需要|必要时|(?:确认|同意|批准)(?:之后|以后|后)|(?:等|待)我`,
  'u',
);
const deniedInstruction = new RegExp(
  `(?:不要|不用|不必|无需|不能|不允许|不准|不得|暂不|不|别|勿|禁止)\\s*(?:(?:再|现在|立即|马上|实际|擅自|给我|帮我|为我|自动|继续|你)\\s*){0,6}${actionPattern}|(?:不想|不希望|不需要|没有要求|未授权)\\s*(?:(?:被|再|现在|立即|实际|你|他|她|它|继续|自动|周期|定时|重复)\\s*)*${actionPattern}|(?:^|请|并|然后|同时|另外|再|且)\\s*(?:取消|停止|暂停|撤销)(?:任务|计划|提醒|运行|执行|调度|创建|发送|$)`,
  'u',
);
const repeatClock =
  '(?:(?:[0-9]{1,2}[:：][0-9]{2}(?::[0-9]{2})?|[零一二两三四五六七八九十]+点(?:整|钟)?)\\s*)?';
const nestedSchedule = new RegExp(
  `(?:并且|并|而且|同时|另外|然后|再|以及|但|不过)\\s*(?:也|还|再|请)?\\s*(?:每隔|每天|每日|每晚|每早|每周|每月)|(?:每天|每日)\\s*(?:早上|早晨|上午|中午|下午|傍晚|晚上|夜间)(?!\\s*的)|每(?:隔)?\\s*${numberPattern}\\s*(?:分钟|小时|天|周|个月|月|年)(?!\\s*的)|每(?:隔)?\\s*(?:分钟|小时)\\s*(?:请)?(?:只|仅)?${actionPattern}|(?:每天|每日|每晚|每早|每周[一二三四五六日天]?|每月(?:${numberPattern}日)?)\\s*${repeatClock}(?:请)?(?:只|仅)?${actionPattern}|(?:定期|循环|反复|重复)\\s*${actionPattern}|(?:创建|安排|设置|登记)(?:一个)?(?:周期|定时|重复|循环)任务`,
  'u',
);
const exampleScaffolding =
  /(?:这是|此为|只是|仅是|仅作|仅为|仅供|只作|只供|作为)(?:一(?:个|段|条))?(?:示例|例子|范例|文档|教程|参考|演示)|是(?:一(?:个|段|条))?(?:示例|例子|范例)|(?:文档|教程|示例)(?:中)?(?:说|写道|提到|规定|要求)[:：]/u;

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
    const value = Number(literal);
    return Number.isSafeInteger(value) && value <= maximumNumber ? value : null;
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
  const value = total + section + digit;
  // Reject shorthand, mixed digits and malformed units rather than guessing.
  return value > 0 &&
    value <= maximumNumber &&
    chineseInteger(value) === normalized
    ? value
    : null;
}

/** Quote contents are task data only after a real outer instruction. An entire
 * quotation is never unwrapped into fresh scheduling authority. */
function maskQuotedArguments(text: string): string | null {
  const pairs: Readonly<Record<string, string>> = {
    '“': '”',
    '‘': '’',
    '「': '」',
    '『': '』',
    '"': '"',
    "'": "'",
    '`': '`',
  };
  const stack: string[] = [];
  let literalHasText = false;
  let result = '';
  for (const character of text) {
    if (stack.at(-1) === character) {
      stack.pop();
      if (!stack.length) {
        if (!literalHasText) return null;
        result += '字面内容';
      }
    } else if (pairs[character]) {
      if (!stack.length) literalHasText = false;
      stack.push(pairs[character]!);
    } else if ('”’」』'.includes(character)) return null;
    else if (!stack.length) result += character;
    else if (character.trim()) literalHasText = true;
  }
  return stack.length ? null : result;
}

function recurringQualifier(clause: string): boolean {
  return (
    new RegExp(
      `^${requestPrefix}(?:实际)?(?:创建|安排|设置)(?:一个)?(?:周期|定时|重复)任务$`,
      'u',
    ).test(clause) ||
    /^(?:请)?(?:不要|别|无需)(?:现在|立即|马上)执行$/u.test(clause)
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
    /^(?:请)?(?:只|仅)?(回复|回答|提醒|告诉|检查|整理|生成|汇总|查询|查找|总结|读取|列出|编写|执行|完成|发送|翻译|给出|附上|使用|分成|保持)(.+)$/u,
  );
  // A translation task needs its own explicit source, not an instruction to
  // translate the preceding scheduling sentence into scheduling authority.
  if (match?.[1] === '翻译' && !match[2]!.includes('字面内容')) return false;
  return Boolean(
    match &&
    !/^(?:我|一下|我一下|一下我|任务|这个任务)?$/u.test(match[2]!.trim()),
  );
}

function explicitWork(text: string): boolean {
  const clauses = text
    .split(/[。；;！!，,\n.]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (!clauses.length || recurringQualifier(clauses[0]!)) return false;
  let work = false;
  for (const clause of clauses) {
    if (recurringQualifier(clause)) continue;
    if (
      // These are outer instructions, not words inside quoted task content.
      conditionalInstruction.test(clause) ||
      deniedInstruction.test(clause) ||
      nestedSchedule.test(clause) ||
      exampleScaffolding.test(clause) ||
      /[?？]|长期|永久|默认|偏好|习惯|今后|以后|大约|大概|左右|差不多|稍后|待会|等会|过会|尽快|至少|至多|最迟|最多|最少|或者|或是|还是|是否|怎么|如何|能否|可否|能不能|可不可以|(?:吗|么|呢|行不行|好不好)$|刚才|上次|之前|此前|上述|上面|同上|照旧|照办|原计划|已确认|已经确认|已同意|(?:这个|那个|该|这项|那项)(?:的)?(?:任务|工作|要求|计划)|今天|明天|后天|今晚|明早|周末|星期|礼拜|下周|本周|下月|本月|明年|开始|起始|截至|截止|直到|结束|终止|持续|有效期|生效|到期|时区|当地时间|本地时间/u.test(
        clause,
      ) ||
      otherTime.test(clause) ||
      !taskClause(clause)
    )
      return false;
    work = true;
  }
  return work;
}

/** Within an already explicit interval, 就/都 is a frequency adverb and
 * 提醒我一次 describes one reminder per occurrence, not a total-run limit.
 * A reminder's object may be the following clause. Keep all existing checks
 * on that object; conditions, denials and additional schedules stay ambiguous. */
function recurringWork(text: string): boolean {
  const body = text.replace(
    new RegExp(`^(?:就|都)\\s*(?=${actionPattern})`, 'u'),
    '',
  );
  const reminder = body.match(
    /^(?:请)?提醒(?:我|我们)(?:一次|一下)?\s*[，,]\s*(?:要)?(.+)$/su,
  );
  if (reminder) return explicitWork(`提醒我${reminder[1]}`);
  return explicitWork(
    body.replace(/^(提醒(?:我|我们))(?:一次|一下)(?=\S)/u, '$1'),
  );
}

/** Conservative, deliberately bounded grammar, not general language inference.
 * The caller must supply the server-loaded current human message and separately
 * verify provenance, tenant/frozen/live authority and exact tool-rule equality.
 * Unknown expressions require clarification in a new complete human request.
 */
export function explicitRecurringTaskIntent(
  text: string,
): RecurringTaskIntent | null {
  if (
    !text.trim() ||
    text.length > 32_000 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(
      text,
    ) ||
    /(?:^|\n)(?:[ \t]*>| {4}| {0,3}\t)|```|~~~/u.test(text)
  )
    return null;
  const prose = maskQuotedArguments(text)?.trim();
  if (!prose) return null;
  const every = prose.match(everyRequest);
  if (every) {
    const number = positiveInteger(every[1]!);
    const seconds = number === null ? 0 : number * secondsPerUnit[every[2]!]!;
    return seconds >= 60 &&
      seconds <= maximumSeconds &&
      recurringWork(every[3]!)
      ? { rule: { kind: 'every', seconds }, authoritativeRequest: text }
      : null;
  }
  const weekly = prose.match(weeklyRequest);
  if (weekly) {
    if (!explicitWork(weekly[4]!)) return null;
    const weekdays = weekly[1]!
      .replaceAll('星期', '')
      .replaceAll('周', '')
      .split(/[、,，和及]/u)
      .map(
        (value) =>
          '一二三四五六日'.indexOf(value.trim().replaceAll('天', '日')) + 1,
      )
      .sort((a, b) => a - b);
    if (
      weekdays.some((value) => value < 1) ||
      new Set(weekdays).size !== weekdays.length
    )
      return null;
    const timezone = weekly[3]!;
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      return null;
    }
    const [hour, minute, second = '00'] = weekly[2]!.split(':');
    return {
      rule: {
        kind: 'weekly',
        weekdays,
        time: `${hour!.padStart(2, '0')}:${minute}:${second}`,
        timezone,
      },
      authoritativeRequest: text,
    };
  }
  const daily = prose.match(dailyRequest);
  if (!daily || !explicitWork(daily[3]!)) return null;
  const timezone = daily[2]!;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return null;
  }
  const [hour, minute, second = '00'] = daily[1]!.split(':');
  return {
    rule: {
      kind: 'daily',
      time: `${hour!.padStart(2, '0')}:${minute}:${second}`,
      timezone,
    },
    authoritativeRequest: text,
  };
}
