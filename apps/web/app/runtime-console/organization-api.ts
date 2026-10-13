const messages: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '登录已过期，请重新登录。',
  AUTHORIZATION_DENIED: '需要平台管理员账号。',
  NOT_FOUND: '公司、员工或部门已不存在，请刷新。',
  INVALID_REQUEST: '请检查名称、英文账号格式和密码长度。',
  account_conflict: '员工信息已被其他操作修改，请刷新后重试。',
  organization_conflict: '公司信息已更新，请刷新后重试。',
  username_taken: '英文账号已被使用，请换一个昵称；现有账号的密码不会被覆盖。',
  email_taken: '邮箱已关联其他账号。',
  reserved_username: '这个账号名称用于平台管理，请换一个英文昵称。',
  department_conflict: '部门已被其他操作修改，请刷新后重试。',
  department_name_taken: '本公司已有同名部门，请使用现有部门或更换名称。',
  department_in_use: '部门仍有关联员工，请先调整员工的主部门，再停用。',
  department_inactive: '部门已停用，请刷新并选择可用部门。',
  department_request_conflict: '这次创建请求的内容已变更，请刷新核对已有部门。',
};
export async function organizationApi<T>(
  url: string,
  method = 'GET',
  input?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    signal,
    ...(input
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const body = await response.json();
  if (!response.ok)
    throw Error(messages[body.code] ?? '请求未完成，请刷新核对后重试。');
  return body as T;
}
export const organizationErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '暂时无法连接，请重试。';
