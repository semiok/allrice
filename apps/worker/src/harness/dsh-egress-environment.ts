const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:']);

function configuredProxy(
  environment: NodeJS.ProcessEnv,
  name: 'ALLRICE_DSH_HTTP_PROXY' | 'ALLRICE_DSH_HTTPS_PROXY',
) {
  const value = environment[name]?.trim();
  if (!value) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new TypeError(`${name} must be an absolute HTTP(S) proxy URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTP(S) proxy URL`);
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError(`${name} must use the http or https protocol`);
  }
  return value;
}

/**
 * Build the intentionally small egress environment inherited by DSH child
 * processes. AllRice does not inherit ambient host proxy variables: operators
 * must explicitly opt a deployment into the proxy route.
 */
export function dshEgressEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const httpProxy = configuredProxy(environment, 'ALLRICE_DSH_HTTP_PROXY');
  const httpsProxy = configuredProxy(environment, 'ALLRICE_DSH_HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return {};

  const result: Record<string, string> = {
    NODE_USE_ENV_PROXY: '1',
  };
  if (httpProxy) result.HTTP_PROXY = httpProxy;
  if (httpsProxy) result.HTTPS_PROXY = httpsProxy;

  const noProxy = environment.ALLRICE_DSH_NO_PROXY?.trim();
  if (noProxy) result.NO_PROXY = noProxy;
  return result;
}
