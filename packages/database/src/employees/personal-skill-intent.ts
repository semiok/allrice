import { parsePersonalSkillGitHubUrl } from '@allrice/contracts';

/** Installation is a persistent private binding. Only the user's complete
 * direct request can authorize it; never extract an imperative from documents,
 * quotes, a translation request, or an instruction for this task only. */
export function explicitPersonalSkillInstallIntent(
  text: string,
  fileName: string,
) {
  // Markdown indented code is quoted material, even when its contents are
  // otherwise a valid command. Inspect raw whitespace before trimming it.
  if (/(?:^|\n)(?: {4}| {0,3}\t)/u.test(text)) return false;
  if (
    !text.trim() ||
    text.length > 2_000 ||
    !/^(?:SKILL\.md|[^\r\n“”「」"'`]+\.zip)$/iu.test(fileName)
  )
    return false;
  // Treat the actual attachment name as an argument, never as arbitrary prose.
  // All clauses still need to match the complete direct-request grammar.
  if (/\.zip$/iu.test(fileName)) {
    text = text
      .replaceAll(fileName, 'SKILL.md')
      .replace(
        /\bZIP\s*(?:(?:里|中|里面)的?\s*(?:技能|Skill))?/giu,
        'SKILL.md',
      );
  }
  text = text.replaceAll('技能包', '技能文件');
  const clauses = text
    .trim()
    .split(/[。；;！!\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  let install = false;
  for (const original of clauses) {
    // Quoting the exact attachment name is fine; quoting a command is not.
    const clause = original.replace(/[“「"'`]SKILL\.md[”」"'`]/gi, 'SKILL.md');
    if (
      /^(?:请|麻烦)?(?:帮我|为我)?(?:把|将)?(?:我(?:刚)?上传的|这个|该|附件(?:里|中)的)?\s*(?:SKILL\.md|技能文件)\s*(?:安装|装)(?:到|给)(?:你|当前\s*(?:这个)?(?:AI\s*)?员工)(?:的个人技能)?(?:中|里)?(?:[，,]\s*(?:以后|后续|今后)(?:的任务)?(?:都)?(?:可以|请|需要时)?(?:使用|用它|按它执行))?[.]?$/iu.test(
        clause,
      ) ||
      /^(?:请|麻烦)?(?:帮我|为我)?安装(?:我(?:刚)?上传的|这个|该|附件(?:里|中)的)?\s*(?:SKILL\.md|技能文件)(?:[，,]\s*(?:(?:绑定到|用于)(?:你|当前\s*(?:AI\s*)?员工)|给当前\s*(?:AI\s*)?员工使用))?[.]?$/iu.test(
        clause,
      ) ||
      /^(?:please\s+)?install\s+(?:the\s+)?(?:attached\s+)?SKILL\.md(?:\s+(?:for|in)\s+(?:this|the current)\s+(?:AI\s+)?employee)?\.?$/i.test(
        clause,
      )
    ) {
      install = true;
      continue;
    }
    if (
      /^(?:这是|我(?:刚)?上传了?)(?:一份|一个)?(?:个人)?(?:技能文件|SKILL\.md)[.]?$/iu.test(
        clause,
      ) ||
      /^(?:以后|后续|今后)(?:的任务)?(?:都)?(?:可以|请|需要时)?(?:使用这个技能|使用它|用它|按它执行)[.]?$/u.test(
        clause,
      ) ||
      /^(?:如果|若)有多个[，,]\s*(?:请)?先让我选(?:择)?一个[.]?$/u.test(clause)
    )
      continue;
    return false;
  }
  return install;
}

/** The literal source must come from this direct message, not a model-selected
 * URL or repository instructions. Source labels are arguments; the complete
 * surrounding request must still authorize persistent personal installation. */
export function explicitPersonalSkillGitHubInstallIntent(
  text: string,
  url: string,
) {
  if (
    !text.trim() ||
    text.length > 2_000 ||
    /(?:^|\n)(?: {4}| {0,3}\t)/u.test(text)
  )
    return false;
  try {
    parsePersonalSkillGitHubUrl(url);
  } catch {
    return false;
  }
  const urls =
    text.match(/https?:\/\/[^\s<>“”「」"'`()\[\]，。；;！!？?]+/giu) ?? [];
  if (urls.length !== 1 || urls[0] !== url) return false;
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Keep the bound URL distinct from an attachment name in the same message.
  // A standalone link must not borrow an imperative aimed at an uploaded file.
  const boundSource = '__ALLRICE_BOUND_GITHUB_SOURCE__';
  if (text.includes(boundSource)) return false;
  let normalized = text
    .replace(
      new RegExp(`\\[[^\\]\\r\\n]{1,80}\\]\\(${escaped}\\)`, 'u'),
      boundSource,
    )
    .replace(url, boundSource);
  if (
    /(?:上传|附件|\b(?:attached|uploaded)\b|SKILL\.md|\.zip\b)/iu.test(
      normalized,
    )
  )
    return false;
  normalized = normalized
    .replaceAll(boundSource, 'SKILL.md')
    .replace(/<SKILL\.md>/gu, 'SKILL.md');
  // Handle a source on its own line without extracting imperatives from a
  // quotation or a larger paragraph. The existing grammar checks every clause.
  normalized = normalized.replace(/^\s*SKILL\.md\s*$/gmu, '这是SKILL.md');
  const sourceLabel =
    /(?:这个|该)?\s*(?:公开\s*)?GitHub\s*(?:链接|仓库|目录)(?:(?:里|中)的?)?(?:技能|Skill)?\s*[:：]?\s*(?:SKILL\.md)?/giu;
  normalized = normalized.replace(sourceLabel, 'SKILL.md');
  normalized = normalized
    .replace(/SKILL\.md\s*(?:里面|里|中)的?\s*(?:技能|Skill)/giu, 'SKILL.md')
    .replace(/(?:这个|该)\s*技能\s*[:：]\s*SKILL\.md/gu, 'SKILL.md')
    .replace(/((?:这个|该))技能(?=\s*(?:[:：。；;！!\n]|$))/gu, '$1技能文件')
    .replace(/((?:SKILL\.md|技能文件))[:：](?=\s*(?:\n|$))/gu, '$1');
  normalized = normalized.replace(
    /(?:the\s+)?(?:public\s+)?GitHub\s+(?:skill|repository|directory)\s+(?:at|from)\s+SKILL\.md/giu,
    'SKILL.md',
  );
  normalized = normalized.replace(
    /SKILL\.md\s*装上/gu,
    'SKILL.md安装到当前员工',
  );
  return explicitPersonalSkillInstallIntent(normalized, 'SKILL.md');
}

/** A fresh user message must select one exact candidate from this session's
 * pending import. Model-provided path/name never supplies this authority. */
export function explicitPersonalSkillSelectionIntent(
  text: string,
  candidates: readonly { sourcePath: string; definition?: { name: string } }[],
) {
  if (text.length > 2_000 || /(?:^|\n)(?: {4}| {0,3}\t)/u.test(text))
    return null;
  const clauses = text
    .trim()
    .split(/[。；;！!\n]/u)
    .map((line) => line.trim())
    .filter(Boolean);
  let selected: string | null = null;
  for (const original of clauses) {
    const clause = original
      .replace(/^我选(?:择)?/u, '选择')
      .replace(/[，,]\s*(?:请)?安装到当前\s*(?:AI\s*)?员工[.]?$/u, '');
    if (
      /^(?:以后|后续|今后)(?:的任务)?(?:都)?(?:可以|请|需要时)?(?:使用这个技能|使用它|用它|按它执行)[.]?$/u.test(
        clause,
      )
    )
      continue;
    const match =
      clause.match(
        /^(?:请)?(?:选择|选|安装)(?:并安装)?\s*(.+?)(?:\s*(?:这个技能|并安装|安装到当前\s*(?:AI\s*)?员工))?[.]?$/u,
      ) ??
      clause.match(
        /^(?:please\s+)?(?:select|install)\s+(.+?)(?:\s+and install)?[.]?$/iu,
      );
    if (!match) return null;
    const label = match[1]!
      .replace(
        /^(?:“([^“”]+)”|「([^「」]+)」|"([^"\n]+)"|`([^`\n]+)`)$/u,
        (_all, a, b, c, d) => a ?? b ?? c ?? d,
      )
      .trim();
    const choices = candidates.filter(
      (candidate) =>
        candidate.sourcePath === label || candidate.definition?.name === label,
    );
    if (
      choices.length !== 1 ||
      (selected && selected !== choices[0]!.sourcePath)
    )
      return null;
    selected = choices[0]!.sourcePath;
  }
  return selected;
}

export function explicitPersonalSkillCancelIntent(
  text: string,
  fileName: string,
) {
  if (text.length > 2_000 || /(?:^|\n)(?: {4}| {0,3}\t)/u.test(text))
    return false;
  const clause = text.trim().replaceAll(fileName, 'ZIP');
  return /^(?:(?:请)?取消\s*(?:这个|该|刚才的)?(?:ZIP|技能包|导入)\s*(?:的)?(?:安装|导入)?|(?:刚才|之前)?(?:那个|这个)?\s*(?:ZIP|技能包)\s*(?:先|暂时)?(?:不要|不|别)装(?:了)?)[。.!！]?$/iu.test(
    clause,
  );
}
