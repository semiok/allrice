import { createHash } from 'node:crypto';
import {
  EgressError,
  type EgressReadRoute,
  type EgressResponse,
} from './contract.js';

const deny = () => {
  throw new EgressError('DENIED');
};
const invalid = () => {
  throw new EgressError('INVALID_RESPONSE');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function json(response: EgressResponse) {
  if (
    response.status !== 200 ||
    !/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(response.contentType)
  )
    return invalid();
  try {
    return record(JSON.parse(Buffer.from(response.body).toString('utf8')));
  } catch {
    return invalid();
  }
}
function respond(value: unknown): EgressResponse {
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(value)),
  };
}
function parameters(query: URLSearchParams, allowed: readonly string[]) {
  if (
    [...query.keys()].some(
      (key) => !allowed.includes(key) || query.getAll(key).length !== 1,
    )
  )
    deny();
}
type Budget = { maxResponseBytes: number; timeoutMs: number };

/** Public OKX market semantics, configured by the host. No account/trade endpoints. */
export function createOkxMarketRoutes(
  policy: Budget & {
    symbols: readonly string[];
    bars: readonly string[];
    maxCandles: number;
  },
): EgressReadRoute[] {
  if (
    !Number.isSafeInteger(policy.maxCandles) ||
    policy.maxCandles < 1 ||
    !policy.symbols.length ||
    !policy.bars.length
  )
    throw new EgressError('POLICY_INVALID');
  return ['instruments', 'candles'].map((kind) => ({
    ...policy,
    id: `market.okx.${kind}`,
    path: `/market/okx/${kind}`,
    origins: ['https://www.okx.com'],
    target(query) {
      parameters(
        query,
        kind === 'instruments' ? [] : ['symbol', 'bar', 'limit'],
      );
      const target = new URL(
        kind === 'instruments'
          ? '/api/v5/public/instruments'
          : '/api/v5/market/candles',
        'https://www.okx.com',
      );
      if (kind === 'instruments') target.searchParams.set('instType', 'SPOT');
      else {
        const symbol = query.get('symbol'),
          bar = query.get('bar'),
          limit = query.get('limit');
        if (
          !symbol ||
          !policy.symbols.includes(symbol) ||
          !bar ||
          !policy.bars.includes(bar) ||
          !limit ||
          !/^[1-9][0-9]*$/.test(limit) ||
          !Number.isSafeInteger(Number(limit)) ||
          Number(limit) > policy.maxCandles
        )
          return deny();
        target.searchParams.set('instId', symbol);
        target.searchParams.set('bar', bar);
        target.searchParams.set('limit', limit);
      }
      return target;
    },
    validate(response) {
      const value = json(response);
      if (value.code !== '0' || !Array.isArray(value.data)) invalid();
      const rows = value.data as unknown[];
      if (
        kind === 'candles' &&
        (rows.length > policy.maxCandles ||
          rows.some(
            (row) =>
              !Array.isArray(row) ||
              row.length !== 9 ||
              row.some(
                (cell, i) =>
                  typeof cell !== 'string' ||
                  (i === 8
                    ? !['0', '1'].includes(cell)
                    : !/^\d+(?:\.\d+)?$/.test(cell)),
              ),
          ))
      )
        invalid();
      if (
        kind === 'instruments' &&
        rows.some((row) => {
          const item = record(row);
          return (
            item.instType !== 'SPOT' ||
            typeof item.instId !== 'string' ||
            typeof item.baseCcy !== 'string' ||
            typeof item.quoteCcy !== 'string'
          );
        })
      )
        invalid();
    },
  }));
}

type Artifact = { target: URL; algorithm: 'sha256' | 'sha512'; digest: string };
/** Standard npm registry and pip simple-index facade over public repository metadata. */
export function createPackageMirrorRoutes(
  policy: Budget & {
    npmOrigin: string;
    pypiOrigin: string;
    pythonFilesOrigin: string;
    maxArtifacts: number;
  },
): EgressReadRoute[] {
  if (!Number.isSafeInteger(policy.maxArtifacts) || policy.maxArtifacts < 1)
    throw new EgressError('POLICY_INVALID');
  const artifacts = new Map<string, Artifact>();
  const origins = [
    policy.npmOrigin,
    policy.pypiOrigin,
    policy.pythonFilesOrigin,
  ];
  const npmName = (path: string) => {
    let name: string;
    try {
      name = decodeURIComponent(path.slice('/npm/'.length));
    } catch {
      return deny();
    }
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
      name.split('/').some((part) => part === '.' || part === '..')
    )
      return deny();
    return name;
  };
  const pythonName = (path: string) => {
    const name = path.slice('/python/simple/'.length).replace(/\/$/, '');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) return deny();
    return name;
  };
  function artifactId(path: string) {
    const id = path.slice('/packages/'.length).split('/')[0]!;
    if (!/^[a-f0-9]{64}$/.test(id)) return deny();
    return id;
  }
  function add(
    target: URL,
    algorithm: Artifact['algorithm'],
    digest: string,
    name: string,
    gateway: string,
  ) {
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !origins.includes(target.origin) ||
      !name ||
      /[\/\\\u0000-\u001f]/.test(name)
    )
      return invalid();
    const id = createHash('sha256')
      .update(JSON.stringify([target.href, algorithm, digest]))
      .digest('hex');
    if (!artifacts.has(id) && artifacts.size >= policy.maxArtifacts)
      throw new EgressError('LIMIT_EXCEEDED');
    artifacts.set(id, { target, algorithm, digest });
    return `${gateway}/packages/${id}/${encodeURIComponent(name)}`;
  }
  const common = {
    ...policy,
    origins,
    validate(response: EgressResponse) {
      if (response.status !== 200) invalid();
    },
  };
  return [
    {
      ...common,
      id: 'packages.npm.read',
      path: '/npm/',
      matches: (path) => path.startsWith('/npm/'),
      target(query, path) {
        parameters(query, []);
        return new URL(
          '/' + encodeURIComponent(npmName(path)),
          policy.npmOrigin,
        );
      },
      transform(response, path, gateway) {
        const value = json(response),
          name = npmName(path);
        if (value.name !== name) return invalid();
        const versions = record(value.versions);
        for (const [version, raw] of Object.entries(versions)) {
          const item = record(raw),
            dist = record(item.dist);
          if (
            item.name !== name ||
            item.version !== version ||
            typeof dist.tarball !== 'string' ||
            typeof dist.integrity !== 'string'
          )
            return invalid();
          const match = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(
            dist.integrity,
          );
          if (!match) return invalid();
          const algorithm = match[1] as Artifact['algorithm'],
            bytes = Buffer.from(match[2]!, 'base64');
          if (
            bytes.length !== (algorithm === 'sha512' ? 64 : 32) ||
            bytes.toString('base64') !== match[2]
          )
            return invalid();
          const target = new URL(dist.tarball);
          if (
            target.origin !== policy.npmOrigin ||
            !target.pathname.startsWith('/' + name + '/-/') ||
            !target.pathname.endsWith('.tgz')
          )
            return invalid();
          dist.tarball = add(
            target,
            algorithm,
            bytes.toString('hex'),
            target.pathname.split('/').at(-1)!,
            gateway,
          );
        }
        return respond(value);
      },
    },
    {
      ...common,
      id: 'packages.python.read',
      path: '/python/simple/',
      matches: (path) => path.startsWith('/python/simple/'),
      target(query, path) {
        parameters(query, []);
        return new URL(`/pypi/${pythonName(path)}/json`, policy.pypiOrigin);
      },
      transform(response, path, gateway) {
        const value = json(response),
          name = pythonName(path);
        const info = record(value.info);
        if (
          typeof info.name !== 'string' ||
          info.name.toLowerCase().replace(/[-_.]+/g, '-') !== name
        )
          return invalid();
        const links: string[] = [];
        for (const files of Object.values(record(value.releases))) {
          if (!Array.isArray(files)) return invalid();
          for (const raw of files) {
            const file = record(raw),
              digest = record(file.digests).sha256;
            if (
              typeof file.filename !== 'string' ||
              typeof file.url !== 'string' ||
              typeof digest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(digest)
            )
              return invalid();
            const target = new URL(file.url);
            if (
              target.origin !== policy.pythonFilesOrigin ||
              !target.pathname.startsWith('/packages/')
            )
              return invalid();
            if (!/\.(?:whl|tar\.gz|zip)$/.test(file.filename)) continue;
            const url = add(target, 'sha256', digest, file.filename, gateway);
            const escape = (s: string) =>
              s.replace(
                /[&<>"']/g,
                (c) =>
                  ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                  })[c]!,
              );
            if (
              file.requires_python !== null &&
              file.requires_python !== undefined &&
              typeof file.requires_python !== 'string'
            )
              return invalid();
            links.push(
              `<a href="${escape(url)}#sha256=${digest}"${typeof file.requires_python === 'string' ? ` data-requires-python="${escape(file.requires_python)}"` : ''}${file.yanked ? ' data-yanked=""' : ''}>${escape(file.filename)}</a>`,
            );
          }
        }
        return {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(
            '<!doctype html><html><body>' + links.join('\n') + '</body></html>',
          ),
        };
      },
    },
    {
      ...common,
      id: 'packages.artifact.read',
      path: '/packages/',
      matches: (path) => path.startsWith('/packages/'),
      target(query, path) {
        parameters(query, []);
        const artifact = artifacts.get(artifactId(path));
        if (!artifact) return deny();
        return new URL(artifact.target);
      },
      transform(response, path) {
        const artifact = artifacts.get(artifactId(path));
        if (
          !artifact ||
          createHash(artifact.algorithm).update(response.body).digest('hex') !==
            artifact.digest
        )
          return invalid();
        return { ...response, contentType: 'application/octet-stream' };
      },
    },
  ];
}
