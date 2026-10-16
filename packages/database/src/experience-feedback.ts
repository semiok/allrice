/** Classify direct feedback, never infer permission to change a rule. The exact
 * original message is retained privately; collection does not adopt its text. */
export function classifyExperienceFeedback(
  text: string,
): 'correction' | 'explicit_feedback' | null {
  if (!text.trim() || text.length > 4000) return null;
  // Quoted/code/retrieved instructions and meta tasks cannot authorize learning.
  // Conservatively defer mixed quotations; later chat can provide direct feedback.
  if (
    /[`“”「」『』"<>]|^\s*>|^ {4}\S/mu.test(text) ||
    /(?:翻译|转述|复述|举例|假设|示例|引用|translate|quote|example)/iu.test(
      text,
    )
  )
    return null;
  // Immediate long-term edits already have MET181's explicit authority path.
  // One-off corrections can still be fulfilled by chat without becoming evidence.
  if (
    /(?:以后|今后|长期|永久|默认|从现在起|记住|保存为|仅本次|只[在对]?这次|这次就|暂时|临时|from now on|by default|remember|this time only)/iu.test(
      text,
    ) ||
    /(?:不要|不用|不必|无需|请勿|别)[^。！？；\n]{0,80}(?:记录|学习|记忆|沉淀|记下|保存)/u.test(
      text,
    ) ||
    /(?:这次|本次|这一次|当前)[^。！？；\n]{0,20}(?:只|仅)|(?:只|仅)[^。！？；\n]{0,20}(?:这次|本次|这一次|这一单|这一份)/u.test(
      text,
    ) ||
    /\b(?:do not|don't|never)\s+(?:(?:save|record|retain|learn|remember)\b)|\b(?:only|just)\s+(?:this|the current)\b|\b(?:this|the current)\s+(?:time|task|report)\s+only\b/iu.test(
      text,
    )
  )
    return null;
  const direct = text.trim();
  const subject =
    /^(?:反馈[：:，,\s]*)?(?:(?:你)?(?:刚才|上次|刚刚|上一轮)|这(?:份|个|次)(?:报告|表格|结果|分析|交付|计算)|上一(?:份|个|次)(?:报告|表格|结果|分析|交付|计算))/u;
  const correction =
    /(?:不对|有误|错误|漏[了掉算列]?|算错|重复(?:计算|统计|记录)|口径不(?:对|一致)|应当|应该|需要改|少[了算]|多算)/u;
  if (subject.test(direct) && correction.test(direct)) return 'correction';
  if (
    /^(?:反馈[：:，,\s]*|(?:我)?(?:已|已经)(?:核对|复核|验证|检查)[，,：:\s]*)/u.test(
      direct,
    ) &&
    /(?:正确|有误|不对|一致|不一致|漏|算错|通过|保留|清晰|方便|难以)/u.test(
      direct,
    )
  )
    return 'explicit_feedback';
  if (
    /^(?:your (?:last|previous) (?:report|result|calculation)|the (?:last|previous) (?:report|result|calculation))\b/iu.test(
      direct,
    ) &&
    /\b(?:wrong|incorrect|missed|missing|double.counted|should)\b/iu.test(
      direct,
    )
  )
    return 'correction';
  if (
    /^(?:feedback:|I (?:checked|verified|reviewed)\b)/iu.test(direct) &&
    /\b(?:correct|incorrect|wrong|missing|matches|clear|helpful)\b/iu.test(
      direct,
    )
  )
    return 'explicit_feedback';
  return null;
}
