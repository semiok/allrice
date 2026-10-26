export const loginUnavailable = '暂时登录不了，请稍后再试。';

/** What went wrong in plain words; the login API's status and code, never shown. */
export function loginFailure(
  status: number,
  code: unknown,
  entry: { adminHost: string; employeeHost: string },
) {
  if (status === 403 && code === 'AUTHORIZATION_DENIED')
    return `此账号无法登录这个入口。管理员请从 ${entry.adminHost} 登录；员工请从 ${entry.employeeHost} 登录。`;
  // A wrong password is 401; an account that cannot exist fails validation.
  if (
    (status === 401 && code === 'AUTHENTICATION_REQUIRED') ||
    (status === 400 && code === 'VALIDATION_FAILED')
  )
    return '账号或密码不对，请检查后重新输入。';
  if (status === 429) return '尝试次数太多，请稍后再试。';
  return loginUnavailable;
}
