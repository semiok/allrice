import type {
  InvestmentReport,
  InvestmentSample,
  InvestmentBaseline,
  InvestmentWork,
  InvestmentStatement,
  InvestmentRevision,
  InvestmentOmission,
} from './investment.ts';
export function estimateInvestment(input: {
  organizationId: string;
  period: InvestmentReport['period'];
  samples: Pick<
    InvestmentSample,
    'revision' | 'baseline' | 'sourceAvailable'
  >[];
  candidateWorks: number;
  statements: InvestmentRevision[];
  filtered: boolean;
  generatedAt: string;
}): InvestmentReport {
  if (
    input.candidateWorks < input.samples.length ||
    new Set(input.samples.map((s) => s.revision.entryId)).size !==
      input.samples.length
  )
    throw new Error('Duplicate or inconsistent business sample denominator');
  const missing: InvestmentReport['missing'] = {
    not_adopted: 0,
    baseline_missing: 0,
    human_input_missing: 0,
    human_scope_incomplete: 0,
    source_unavailable: 0,
    calculation_out_of_range: 0,
  };
  const samples = input.samples.map((s) => {
    const work = s.revision.content as InvestmentWork,
      b = s.baseline?.content as InvestmentBaseline | undefined,
      omissions: InvestmentOmission[] = [];
    if (!work.adoptedAt) omissions.push('not_adopted');
    if (!b) omissions.push('baseline_missing');
    if (work.humanMinutes === null) omissions.push('human_input_missing');
    if (work.humanScope !== 'complete')
      omissions.push('human_scope_incomplete');
    if (!s.sourceAvailable) omissions.push('source_unavailable');
    let savedMinutes = omissions.length
      ? null
      : b!.minutesPerUnit * work.units - work.humanMinutes!;
    let valueMinor =
      savedMinutes === null || b?.hourlyRateMinor === null || !b?.currency
        ? null
        : Math.sign(savedMinutes) *
          Math.round(Math.abs(savedMinutes * b.hourlyRateMinor) / 60);
    if (valueMinor !== null && !Number.isSafeInteger(valueMinor)) {
      omissions.push('calculation_out_of_range');
      savedMinutes = null;
      valueMinor = null;
    }
    for (const key of omissions) missing[key]++;
    return {
      ...s,
      omissions,
      savedMinutes,
      valueMinor,
      currency: b?.currency ?? null,
    };
  });
  const included = samples.filter((s) => s.savedMinutes !== null),
    truncated = input.candidateWorks > samples.length;
  const statements = input.statements.filter(
    (r) =>
      r.content.kind === 'statement' &&
      Date.parse(r.content.from) === Date.parse(input.period.from) &&
      Date.parse(r.content.to) === Date.parse(input.period.to),
  );
  const currencies = new Set([
    ...samples.flatMap((s) => (s.currency ? [s.currency] : [])),
    ...statements.map((r) => (r.content as InvestmentStatement).currency),
  ]);
  const groups = [...currencies].sort().map((currency) => {
    const valued = included.filter(
        (s) => s.currency === currency && s.valueMinor !== null,
      ),
      statement =
        statements.find(
          (r) => (r.content as InvestmentStatement).currency === currency,
        ) ?? null,
      c = statement?.content as InvestmentStatement | undefined;
    const modelMinor = c?.modelMinor ?? null,
      otherMinor = c?.otherMinor ?? null,
      refs = statement?.facts.subscriptionReferences as
        { amountMinor: number }[] | undefined;
    const subscriptionMinor = c?.subscriptionKnown
      ? (refs ?? []).reduce((n, r) => n + r.amountMinor, 0)
      : null;
    const known = [modelMinor, subscriptionMinor, otherMinor].every(
      (x) => x !== null,
    );
    const costMinor = known
      ? modelMinor! + subscriptionMinor! + otherMinor!
      : null;
    const excludedCosts: string[] = [];
    if (modelMinor === null)
      excludedCosts.push(
        '模型费用缺少明确账单依据和币种；原始账本不改写、不重复累计助手费用',
      );
    if (subscriptionMinor === null) excludedCosts.push('订阅分摊未确认');
    if (otherMinor === null) excludedCosts.push('其他投入未确认');
    if (c?.coverage !== 'complete') excludedCosts.push('未声明投入范围完整');
    if (input.filtered)
      excludedCosts.push('员工/AI/岗位筛选与公司费用范围不同');
    if (truncated) excludedCosts.push('业务样本超出本次证据上限');
    const unvaluedWorks = included.filter(
      (s) =>
        (s.currency === currency || s.currency === null) &&
        s.valueMinor === null,
    ).length;
    if (unvaluedWorks)
      excludedCosts.push('已登记样本存在未知人工费率或币种，收益仅为已知部分');
    if (included.length !== input.candidateWorks)
      excludedCosts.push('已登记样本未全部满足估算条件');
    const complete =
      known && c?.coverage === 'complete' && !input.filtered && !truncated;
    const valueSum = valued.reduce((n, s) => n + s.valueMinor!, 0);
    const valueMinor =
      valued.length && !truncated && Number.isSafeInteger(valueSum)
        ? valueSum
        : null;
    if (valued.length && !Number.isSafeInteger(valueSum))
      excludedCosts.push('收益总额超出精确计算范围');
    const valueCoverage =
      valueMinor === null
        ? ('unknown' as const)
        : unvaluedWorks || included.length !== input.candidateWorks
          ? ('partial' as const)
          : ('complete' as const);
    const ratio =
      valueMinor !== null &&
      valueCoverage === 'complete' &&
      complete &&
      costMinor! > 0
        ? valueMinor / costMinor!
        : null;
    return {
      currency,
      valuedWorks: valued.length,
      unvaluedWorks,
      valueCoverage,
      valueMinor,
      modelMinor,
      subscriptionMinor,
      otherMinor,
      costMinor,
      costCoverage: complete
        ? ('complete' as const)
        : known
          ? ('partial' as const)
          : ('unknown' as const),
      ratio,
      roi: ratio === null ? null : ratio - 1,
      statement,
      excludedCosts,
    };
  });
  const savedMinutes =
    included.length && !truncated
      ? included.reduce((n, s) => n + s.savedMinutes!, 0)
      : null;
  const hours = [
    ...new Set(
      statements.flatMap((s) =>
        (s.content as InvestmentStatement).standardHours === null
          ? []
          : [(s.content as InvestmentStatement).standardHours!],
      ),
    ),
  ];
  const standardHours = hours.length === 1 ? hours[0]! : null;
  return {
    algorithm: 'allrice-human-savings-v1',
    organizationId: input.organizationId,
    period: input.period,
    candidateWorks: input.candidateWorks,
    includedWorks: included.length,
    returnedWorks: samples.length,
    truncated,
    savedMinutes,
    missing,
    groups,
    standardHours,
    hoursEquivalent:
      savedMinutes === null || standardHours === null
        ? null
        : savedMinutes / 60 / standardHours,
    samples,
    generatedAt: input.generatedAt,
    scopeNote:
      '按业务标识归并的人工确认样本；采用日期落入所选期间。遗漏原因可重叠，不能相加。AI 耗时不作为人工投入；未登记的经营活动不属于覆盖分母。费用仅按明确同周期同币种声明，不重算原始模型账本。',
  };
}
