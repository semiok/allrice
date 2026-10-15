/** A department name/ID is a literal argument to an unquoted leading request.
 * Never search candidate bodies, quoted instructions or explanatory prose. */
export function namedMethodDepartmentRequest(request: string) {
  const match = request.match(
    /^(?<prefix>(?:请)?(?:为我|帮我)?(?:保存|更新|调整|修改|创建|新增|定制|重命名|移除|删除|停用|测试|验证))(?:(?:部门\s*)(?:“(?<double>[^“”\r\n]{1,100})”|「(?<corner>[^「」\r\n]{1,100})」|『(?<book>[^『』\r\n]{1,100})』|"(?<ascii>[^"\r\n]{1,100})"|`(?<code>[^`\r\n]{1,100})`|(?<plain>[^\s的《》“”"'「」『』`。；;！!，,：:]{1,100}))|(?:“(?<suffixDouble>[^“”\r\n]{1,100})”|「(?<suffixCorner>[^「」\r\n]{1,100})」)部门|(?<bare>[^\s的《》“”"'「」『』`。；;！!，,：:]{1,98}(?:部门|部|中心|组)))的/u,
  );
  if (
    !match?.groups ||
    /^(?:本|我们|我的)部门的/u.test(match[0].slice(match.groups.prefix!.length))
  )
    return null;
  const { prefix, ...names } = match.groups;
  const value = Object.values(names).find(Boolean)!.trim();
  if (!value) return null;
  return {
    value,
    kind: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)
      ? ('id' as const)
      : ('name' as const),
    normalized: `${prefix}本部门的${request.slice(match[0].length)}`,
  };
}
