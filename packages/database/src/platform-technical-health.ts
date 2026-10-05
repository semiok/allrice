import {
  type TechnicalDiagnostics,
  type TechnicalEvidence,
} from './platform-technical-contracts.ts';
import { technicalEnvironment } from './platform-technical.ts';

/** Deployment configuration only, never a caller-controlled URL or arbitrary path. */
export async function platformTechnicalHealth(
  service: 'web' | 'worker',
): Promise<TechnicalDiagnostics['web']> {
  const evidence: TechnicalEvidence = {
    environment: technicalEnvironment(),
    source: service === 'web' ? 'web_health' : 'worker_health',
    freshness: 'unknown',
    sampledAt: null,
    windowStart: null,
    windowEnd: null,
    unavailableReason: 'not_configured',
  };
  const configured =
    service === 'web'
      ? (process.env.ALLRICE_TECHNICAL_WEB_HEALTH_URL ??
        (process.env.ALLRICE_WEB_PORT &&
          `http://127.0.0.1:${process.env.ALLRICE_WEB_PORT}/api/health/ready`))
      : process.env.ALLRICE_TECHNICAL_WORKER_HEALTH_URL;
  if (!configured) return { evidence, value: null };
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { evidence, value: null };
  }
  // Initial deployment is co-located. A remote agent needs an explicit trusted
  // collector contract, rather than granting this endpoint a generic fetch tool.
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== (service === 'web' ? '/api/health/ready' : '/health/ready')
  )
    return { evidence, value: null };
  const sampledAt = new Date().toISOString();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw Error('empty_health_response');
    const decoder = new TextDecoder();
    let body = '',
      size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 8192) throw Error('health_response_limit');
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data: unknown = JSON.parse(body);
    if (
      !data ||
      typeof data !== 'object' ||
      !('service' in data) ||
      data.service !== service ||
      !('status' in data) ||
      !['ready', 'not_ready'].includes(String(data.status)) ||
      ![200, 503].includes(response.status) ||
      (response.status === 200) !== (data.status === 'ready')
    )
      throw Error('invalid_health_response');
    const sha = response.headers.get('x-allrice-release-sha');
    return {
      evidence: {
        ...evidence,
        freshness: 'fresh',
        sampledAt,
        windowEnd: sampledAt,
        unavailableReason: null,
      },
      value: {
        status: data.status as 'ready' | 'not_ready',
        releaseSha: /^[a-f0-9]{40}$/.test(sha ?? '') ? sha : null,
      },
    };
  } catch {
    // A failed probe does not prove that the process has stopped. Keep unknown.
    return {
      evidence: { ...evidence, unavailableReason: 'collection_failed' },
      value: null,
    };
  }
}
