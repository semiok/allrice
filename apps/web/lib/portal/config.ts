import { safeNavigationQuery } from './navigation-query';
export type PortalKind = 'platform_admin' | 'tenant';

export interface PortalDefinition {
  key: 'runtime-console' | 'snow' | 'drink';
  kind: PortalKind;
  title: string;
  subtitle: string;
  hosts: readonly string[];
  username: string;
  passwordEnvironmentVariable: string;
  homePath: string;
  principal: {
    organizationSlug: string;
    organizationName: string;
    workspaceSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    role: 'admin' | 'member';
  };
}

const definitions: readonly PortalDefinition[] = [
  {
    key: 'runtime-console',
    kind: 'platform_admin',
    title: 'AllRice Runtime Console',
    subtitle: '查看真实 Worker DSH Runtime、Session 与原生事件。',
    hosts: ['allrice-dsh.bplabs.xyz', 'allrice-dsh.traditionow.ai'],
    username: process.env.ALLRICE_PLATFORM_ADMIN_USER ?? 'admin',
    passwordEnvironmentVariable: 'ALLRICE_PLATFORM_ADMIN_PASSWORD',
    homePath: '/runtime-console',
    principal: {
      organizationSlug: 'allrice-platform',
      organizationName: 'AllRice Platform',
      workspaceSlug: 'control-plane',
      workspaceName: 'Platform Control Plane',
      email:
        process.env.ALLRICE_PLATFORM_BOOTSTRAP_EMAIL ?? 'semiokshen@gmail.com',
      displayName: 'AllRice Platform Administrator',
      role: 'member',
    },
  },
  {
    key: 'snow',
    kind: 'tenant',
    title: 'Snow · AllRice',
    subtitle: '与分配给 Snow 的 AI 员工一起工作。',
    hosts: [
      'allrice-snow.bplabs.xyz',
      'allrice-snow.traditionow.ai',
      // Migration aliases retained until the four-domain rollout is accepted.
      'allrice.traditionow.ai',
      'rice.traditionow.ai',
    ],
    username: process.env.ALLRICE_SNOW_USER ?? 'snow',
    passwordEnvironmentVariable: 'ALLRICE_SNOW_PASSWORD',
    homePath: '/chatflow',
    principal: {
      organizationSlug: 'snow',
      organizationName: 'Snow',
      workspaceSlug: 'default',
      workspaceName: 'Snow Workspace',
      email:
        process.env.ALLRICE_SNOW_BOOTSTRAP_EMAIL ??
        'snow@bootstrap.allrice.local',
      displayName: 'Snow',
      role: 'member',
    },
  },
  {
    key: 'drink',
    kind: 'tenant',
    title: 'Drink · AllRice',
    subtitle: '与分配给 Drink 的 AI 员工一起工作。',
    hosts: ['allrice-drink.bplabs.xyz', 'allrice-drink.traditionow.ai'],
    username: process.env.ALLRICE_DRINK_USER ?? 'drink',
    passwordEnvironmentVariable: 'ALLRICE_DRINK_PASSWORD',
    homePath: '/chatflow',
    principal: {
      organizationSlug: 'drink',
      organizationName: 'Drink',
      workspaceSlug: 'default',
      workspaceName: 'Drink Workspace',
      email:
        process.env.ALLRICE_DRINK_BOOTSTRAP_EMAIL ??
        'drink@bootstrap.allrice.local',
      displayName: 'Drink',
      role: 'member',
    },
  },
] as const;

export function portalAuthEnabled() {
  return process.env.ALLRICE_PORTAL_AUTH_ENABLED === '1';
}

export function normalizeHost(value: string | null | undefined) {
  if (!value) return '';
  const first = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end >= 0 ? first.slice(1, end) : first;
  }
  return first.split(':')[0] ?? '';
}

/** The shared entry never selects a person or organization from its hostname. */
export function isUnifiedPortalHost(host: string | null | undefined) {
  const value = normalizeHost(host);
  return (
    value === 'allrice.bplabs.xyz' ||
    (['localhost', '127.0.0.1', '::1'].includes(value) &&
      (process.env.ALLRICE_LOCAL_PORTAL ?? 'unified') === 'unified')
  );
}

export function resolvePortal(host: string | null | undefined) {
  if (isUnifiedPortalHost(host)) return null;
  const normalized = normalizeHost(host);
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  ) {
    const localKey = process.env.ALLRICE_LOCAL_PORTAL ?? 'snow';
    return (
      definitions.find((definition) => definition.key === localKey) ?? null
    );
  }
  return (
    definitions.find((definition) => definition.hosts.includes(normalized)) ??
    null
  );
}

export function portalPublicView(portal: PortalDefinition) {
  return {
    key: portal.key,
    kind: portal.kind,
    title: portal.title,
    subtitle: portal.subtitle,
    username: portal.username,
    homePath: portal.homePath,
  };
}

/** All companies share the same account portal; the login selects membership. */
export function tenantTrialPortal(_organizationSlug: string, origin: string) {
  const source = new URL(origin);
  return ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)
    ? `${source.origin}/chatflow`
    : 'https://allrice.bplabs.xyz/chatflow';
}

/** Deployment bootstrap only. Never expose these values through publicPortal. */
export function legacyPortalMigrationAccounts() {
  return definitions.map((portal) => ({
    email: portal.principal.email,
    username: portal.username,
    organizationSlug: portal.principal.organizationSlug,
    workspaceSlug: portal.principal.workspaceSlug,
    kind:
      portal.kind === 'tenant'
        ? ('employee' as const)
        : ('platform_admin' as const),
    ...(portal.kind === 'platform_admin'
      ? { initialPassword: process.env[portal.passwordEnvironmentVariable] }
      : {}),
  }));
}

/** Navigation only; device credentials, callbacks and downloads keep their host. */
export function legacyPortalNavigation(request: {
  url: string;
  method: string;
  headers: Headers;
}) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const host = request.headers.get('host'),
    portal = resolvePortal(host);
  if (!portal || !portal.hosts.includes(normalizeHost(host))) return null;
  const url = new URL(request.url);
  if (
    url.pathname !== '/' &&
    !/^\/(login|accept-invitation|chatflow|runtime-console|workspace|employees|automation)(\/|$)/.test(
      url.pathname,
    )
  )
    return null;
  const destination = new URL('https://allrice.bplabs.xyz');
  destination.pathname = url.pathname;
  destination.search = safeNavigationQuery(url);
  return destination;
}
