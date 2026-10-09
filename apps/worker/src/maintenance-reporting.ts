import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { LocalCommandOutputFilter } from '@allrice/project-runtime';
import {
  collectMaintenanceSourceReports,
  claimMaintenanceSourceReport,
  settleMaintenanceSourceReport,
} from '@allrice/database';
import {
  MaintenanceConnectionFileSchema,
  MaintenanceConnectionStateSchema,
  MaintenanceReportReceiptSchema,
  maintenanceProbeFixtures,
} from '@allrice/database/technical-contracts';

export function probeMaintenanceOutputFilter() {
  const failedAssertions: Array<
    (typeof maintenanceProbeFixtures)[number]['id']
  > = [];
  for (const fixture of maintenanceProbeFixtures) {
    const filter = new LocalCommandOutputFilter();
    let output = '';
    for (const chunk of fixture.chunks)
      output += filter.push(Buffer.from(chunk));
    output += filter.push(Buffer.alloc(0), true);
    if (
      !output.includes('[REDACTED]') ||
      fixture.forbidden.some((x) => output.includes(x))
    )
      failedAssertions.push(fixture.id);
  }
  return {
    specId: 'command-output.credentials.v2' as const,
    fixtureDigest:
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify(maintenanceProbeFixtures))
        .digest('hex'),
    failedAssertions,
  };
}
export class MaintenanceReportingError extends Error {
  constructor(
    readonly code:
      'connection_invalid' | 'transport_unavailable' | 'response_invalid',
  ) {
    super(code);
  }
}
/** Known filesystem/HTTP failures have ended. Database commit failures remain
 * unknown and must propagate into the existing producer lifecycle. */
export async function runMaintenanceReportingProducer(
  input: Parameters<typeof reportMaintenanceTick>[0] = {},
) {
  try {
    await reportMaintenanceTick(input);
  } catch (error) {
    if (!(error instanceof MaintenanceReportingError)) throw error;
    console.warn('[MET-167] maintenance reporting deferred', {
      code: error.code,
    });
  }
}
let nextPollAt = 0;
/** Invoked by the existing automation producer. No new execution engine/model
 * tasks; unchanged facts stay quiet, and transport replay is immutable. */
export async function reportMaintenanceTick(
  input: {
    signal?: AbortSignal;
    connectionFile?: string;
    releaseSha?: string;
    transport?: typeof fetch;
  } = {},
) {
  const file =
    input.connectionFile ?? process.env.ALLRICE_MAINTENANCE_CONNECTION_FILE;
  if (!file || Date.now() < nextPollAt) return;
  nextPollAt = Date.now() + 60000;
  const connection = await (async () => {
    try {
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0
      )
        throw Error('invalid');
      return MaintenanceConnectionFileSchema.parse(
        JSON.parse(await readFile(file, 'utf8')),
      );
    } catch {
      throw new MaintenanceReportingError('connection_invalid');
    }
  })();
  const base = new URL(connection.centralUrl).origin;
  const releaseSha = input.releaseSha ?? process.env.ALLRICE_RELEASE_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(releaseSha))
    throw new MaintenanceReportingError('connection_invalid');
  const connectionDigest =
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          centralUrl: base,
          deploymentId: connection.deploymentId,
        }),
      )
      .digest('hex');
  const headers = {
    Authorization: 'Bearer ' + connection.installationKey,
    'x-allrice-deployment-id': connection.deploymentId,
  };
  const transport = input.transport ?? fetch;
  const request = async (path: string, init: RequestInit = {}) => {
    try {
      const r = await transport(base + path, {
        ...init,
        headers: { ...headers, ...init.headers },
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
      if (!r.ok) throw Error('maintenance_transport_unavailable');
      const reader = r.body?.getReader();
      if (!reader) throw Error('maintenance_response_invalid');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64000) {
            await reader.cancel();
            throw Error('maintenance_response_invalid');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new MaintenanceReportingError('transport_unavailable');
    }
  };
  const stateResult = MaintenanceConnectionStateSchema.safeParse(
    await request('/api/v1/maintenance/connection'),
  );
  if (!stateResult.success)
    throw new MaintenanceReportingError('response_invalid');
  const state = stateResult.data;
  if (state.deploymentId !== connection.deploymentId)
    throw new MaintenanceReportingError('response_invalid');
  if (state.paused || input.signal?.aborted) return;
  await collectMaintenanceSourceReports({
    connectionDigest,
    deploymentId: connection.deploymentId,
    releaseSha,
    intervalMinutes: state.checkIntervalMinutes,
    probe: probeMaintenanceOutputFilter(),
  });
  for (let i = 0; i < 3 && !input.signal?.aborted; i++) {
    const pending = await claimMaintenanceSourceReport(connectionDigest);
    if (!pending) break;
    let receipt;
    try {
      const response = await request('/api/v1/maintenance/reports', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-allrice-sent-at': new Date().toISOString(),
        },
        body: JSON.stringify(pending.payload),
      });
      receipt = MaintenanceReportReceiptSchema.parse(response);
      if (
        receipt.deploymentId !== pending.deploymentId ||
        receipt.sourceReportId !== pending.payload.sourceReportId ||
        receipt.payloadDigest !== pending.payloadDigest
      )
        throw new MaintenanceReportingError('response_invalid');
    } catch {
      await settleMaintenanceSourceReport({
        id: pending.id,
        attempt: pending.attempt,
        failed: true,
      });
      break;
    }
    // Do not downgrade an unknown acknowledgement commit into a known retry.
    await settleMaintenanceSourceReport({
      id: pending.id,
      attempt: pending.attempt,
      receipt,
    });
  }
}
