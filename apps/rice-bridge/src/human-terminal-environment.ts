const utf8Locale = (value: string | undefined): value is string =>
  value !== undefined &&
  /^(?:[a-z][a-z0-9_-]*\.)?utf-?8(?:@[a-z0-9_-]+)?$/i.test(value);

/** Only the human PTY receives these overrides; Core and Agent environments
 * retain the inherited locale. An empty POSIX LC_ALL restores category priority
 * within the native terminal provider's public string-only environment API. */
export function humanTerminalLocaleEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform === 'win32' || utf8Locale(environment.LC_ALL)) return {};
  const ctype = environment.LC_CTYPE,
    language = environment.LANG;
  const clearAll: Record<string, string> = environment.LC_ALL
    ? { LC_ALL: '' }
    : {};
  if (utf8Locale(ctype) || (!ctype && utf8Locale(language))) return clearAll;
  const selected = utf8Locale(language)
    ? language
    : platform === 'darwin'
      ? 'en_US.UTF-8'
      : 'C.UTF-8';
  return {
    ...clearAll,
    LC_CTYPE: selected,
    ...(!language ? { LANG: selected } : {}),
  };
}
