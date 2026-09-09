import { createHash } from 'node:crypto';
import type {
  BrowserObservation,
  StoragePort,
  StorageObject,
} from '@allrice/contracts';
import { BrowserObservationSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  currentBrowserWorkspace,
  type BrowserWorkspaceRow,
} from './browser-control-authority.ts';
import { browserPrincipal } from './browser-control.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import { runtimePolicyDigest, RuntimePolicyError } from './runtime-policy.ts';
/** JSON manifest links immutable evidence; never serves third-party HTML as same-origin content. */
export async function publishBrowserObservationArtifact(
  w: BrowserWorkspaceRow,
  observation: BrowserObservation,
  storage: StoragePort,
  db = getDatabase(),
) {
  if (process.env.ALLRICE_WORKBENCH_ENABLED !== '1') return null;
  const obs = BrowserObservationSchema.parse(observation),
    bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        untrustedExternalContent: true,
        browserWorkspaceId: w.id,
        observation: obs,
      }),
    );
  let object: StorageObject | undefined;
  try {
    return await db.begin(async (tx) => {
      // Acquire the tenant quota lock before browserIdentity takes a SHARE lock
      // on this row and local admission locks the browser workspace. Upgrading
      // it afterwards deadlocks against a concurrent observer holding tenant
      // SHARE while waiting for the browser-workspace UPDATE lock.
      await tx`select id from allrice_workspaces where id=${w.workspace_id} and organization_id=${w.organization_id} for update`;
      const current = await currentBrowserWorkspace(
        tx,
        browserPrincipal(w.execution_context),
        w.id,
      );
      if (
        current.observation?.id !== obs.id ||
        current.profile_id !== obs.profileId ||
        current.control_fence !== obs.fence
      )
        throw new RuntimePolicyError('browser_observation_changed');
      const requestId = `browser-observation:${obs.id}`;
      const [prior] = await tx<
        { version_id: string }[]
      >`select version_id from allrice_workbench_artifacts where organization_id=${w.organization_id} and workspace_id=${w.workspace_id} and run_id=${w.run_id} and request_id=${requestId}`;
      if (prior) return prior.version_id;
      object = {
        ...createToolBrokerExportObject({
          context: w.execution_context,
          mediaType: 'application/json',
          sizeBytes: bytes.length,
          checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        }),
        immutable: true,
      };
      await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
      const version = await registerToolBrokerExport(
        {
          context: w.execution_context,
          sessionId: w.session_id,
          fileName: `browser-${obs.revision}.json`,
          format: 'json',
          object,
        },
        tx,
      );
      const execution = {
        targetId: w.target_id,
        targetKind: w.transport === 'local' ? 'rice_bridge' : 'cloud_sandbox',
        deviceId: w.device_id,
        grantId: w.grant_id,
        grantVersion: w.grant_version,
        scopeDigest: runtimePolicyDigest(w.profile),
        workCopy: {
          id: w.profile_id,
          kind: w.transport === 'local' ? 'local_copy' : 'cloud_copy',
        },
      };
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)
      values(${version.id},${w.organization_id},${w.workspace_id},${w.owner_id},${w.run_id},'browser_capture',${tx.json({ kind: 'tool_result', runId: w.run_id, operationId: null, stepId: null })},${tx.json(execution)},${requestId},${runtimePolicyDigest(obs)})`;
      await currentBrowserWorkspace(
        tx,
        browserPrincipal(w.execution_context),
        w.id,
      );
      return version.id;
    });
  } catch (error) {
    // Unknown commit acknowledgment retains bounded evidence, never destroys a committed artifact.
    if (object) {
      const known =
        await db`select id from allrice_storage_objects where id=${object.id}`.catch(
          () => null,
        );
      if (known?.length === 0)
        await storage
          .delete({ ...object, immutable: false })
          .catch(() => undefined);
    }
    throw error;
  }
}
