// Test processes only. Never write the caller's shell or the OS proxy settings.
export function withTestNoProxy(env) {
  const bypass = [
    env.NO_PROXY,
    env.no_proxy,
    'allrice.test,.allrice.test,localhost,.localhost,127.0.0.1,::1,[::1]',
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const value = [...new Set(bypass)].join(',');
  return { ...env, NO_PROXY: value, no_proxy: value };
}

export function testChromiumOptions(options = {}) {
  // Managed-browser tests deliberately exercise their own pinned proxy. Leave
  // explicit proxy routing (including loopback subtraction) entirely intact.
  if (
    options.proxy ||
    options.args?.some((arg) =>
      /^--proxy-(server|pac-url|auto-detect|bypass-list)(=|$)/.test(arg),
    )
  )
    return options;
  return {
    ...options,
    ...(options.env ? { env: withTestNoProxy(options.env) } : {}),
    args: [
      ...(options.args ?? []),
      // Headless Shell 151 on macOS ignores --no-proxy-server and a standalone
      // bypass list when it inherits the OS proxy. An explicit DIRECT rule works.
      '--proxy-server=direct://',
      '--proxy-bypass-list=*.allrice.test;allrice.test;localhost;*.localhost;127.0.0.1;[::1]',
    ],
  };
}

export function installTestChromiumProxy(chromium) {
  const launch = chromium.launch;
  const launchPersistentContext = chromium.launchPersistentContext;
  chromium.launch = function (options) {
    return launch.call(this, testChromiumOptions(options));
  };
  chromium.launchPersistentContext = function (directory, options) {
    return launchPersistentContext.call(
      this,
      directory,
      testChromiumOptions(options),
    );
  };
  return () => {
    chromium.launch = launch;
    chromium.launchPersistentContext = launchPersistentContext;
  };
}
