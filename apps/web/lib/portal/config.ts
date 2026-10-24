import { safeNavigationQuery } from './navigation-query';
import { configuredPortalEntries } from '../../server/portal-hosts.mjs';
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
    title: 'Allrice 管理后台',
    subtitle: '使用管理员账号登录，管理公司、员工与平台配置。',
    hosts: [
      'allrice-admin.bplabs.xyz',
      'allrice-admin.traditionow.ai',
      'allrice-dsh.bplabs.xyz',
      'allrice-dsh.traditionow.ai',
    ],
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
      workspaceName: '默认工作区',
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
      workspaceName: '默认工作区',
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

/** Hostname without brackets or port; idempotent, so a normalized value (a bare
 * IPv6 address included) normalizes to itself. */
export function normalizeHost(value: string | null | undefined) {
  if (!value) return '';
  const first = value.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end >= 0 ? first.slice(1, end) : first;
  }
  // More than one colon: a bare IPv6 address, which carries no port.
  if (first.indexOf(':') !== first.lastIndexOf(':')) return first;
  return first.split(':')[0] ?? '';
}

const configuredHosts = (variable: string) =>
  configuredPortalEntries(variable).map((entry) => entry.host);

/** Where this deployment's employees sign in: its first configured entry (with its
 * port), else the shared allrice.bplabs.xyz. */
export const employeePortalAuthority = () =>
  configuredPortalEntries('ALLRICE_EMPLOYEE_PORTAL_HOSTS')[0]?.authority ??
  'allrice.bplabs.xyz';

/** Where this deployment's platform admins sign in. */
export const adminPortalAuthority = () =>
  configuredPortalEntries('ALLRICE_ADMIN_PORTAL_HOSTS')[0]?.authority ??
  'allrice-admin.bplabs.xyz';

/** The shared employee entry: allrice.bplabs.xyz, plus the hosts a deployment lists
 * in ALLRICE_EMPLOYEE_PORTAL_HOSTS (its own domain; comma separated). */
export function isEmployeePortalHost(host: string | null | undefined) {
  const value = normalizeHost(host);
  return (
    value === 'allrice.bplabs.xyz' ||
    configuredHosts('ALLRICE_EMPLOYEE_PORTAL_HOSTS').includes(value)
  );
}

/** A portal's hostnames; the admin portal also takes ALLRICE_ADMIN_PORTAL_HOSTS. */
const portalHosts = (portal: PortalDefinition) =>
  portal.kind === 'platform_admin'
    ? [...portal.hosts, ...configuredHosts('ALLRICE_ADMIN_PORTAL_HOSTS')]
    : portal.hosts;

/** The shared entry never selects a person or organization from its hostname. */
export function isUnifiedPortalHost(host: string | null | undefined) {
  const value = normalizeHost(host);
  return (
    isEmployeePortalHost(value) ||
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
    definitions.find((definition) =>
      portalHosts(definition).includes(normalized),
    ) ?? null
  );
}

/** Public employee and admin entries accept only their own account kind.
 * Unconfigured localhost keeps the development harness usable with either role.
 */
export function portalAccountKind(host: string | null | undefined) {
  if (isEmployeePortalHost(host)) return 'employee' as const;
  const portal = resolvePortal(host);
  return portal?.kind === 'platform_admin'
    ? ('platform_admin' as const)
    : portal?.kind === 'tenant'
      ? ('employee' as const)
      : undefined;
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

/** All companies share the same account portal; the login selects membership. A
 * deployment with its own employee domain links there instead of allrice.bplabs.xyz. */
export function tenantTrialPortal(_organizationSlug: string, origin: string) {
  const source = new URL(origin);
  if (['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
    return `${source.origin}/chatflow`;
  return `https://${employeePortalAuthority()}/chatflow`;
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
  const host = normalizeHost(request.headers.get('host')),
    portal = resolvePortal(host);
  if (!portal || !portal.hosts.includes(host)) return null;
  // The admin entry itself, and an alias this deployment lists as one of its own
  // entries, are served here rather than moved.
  if (
    host === 'allrice-admin.bplabs.xyz' ||
    configuredHosts('ALLRICE_EMPLOYEE_PORTAL_HOSTS').includes(host) ||
    configuredHosts('ALLRICE_ADMIN_PORTAL_HOSTS').includes(host)
  )
    return null;
  const url = new URL(request.url);
  if (
    url.pathname !== '/' &&
    !/^\/(login|accept-invitation|chatflow|runtime-console|workspace|employees|automation)(\/|$)/.test(
      url.pathname,
    )
  )
    return null;
  // This deployment's own entries, else the shared public ones.
  const destination = new URL(
    `https://${portal.kind === 'platform_admin' ? adminPortalAuthority() : employeePortalAuthority()}`,
  );
  destination.pathname = url.pathname;
  destination.search = safeNavigationQuery(url);
  return destination;
}
