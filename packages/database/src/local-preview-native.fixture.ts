import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import { request } from 'node:http';
import { BridgeDeviceSchema } from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import type { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.ts';

export const previewProjectSource = `import http from 'node:http';
let writes=0,lastBody='';
http.createServer((q,s)=>{const chunks=[];q.on('data',b=>chunks.push(b));q.on('end',()=>{
 if(q.method==='POST'){writes++;lastBody=Buffer.concat(chunks).toString();console.log('P23_NATIVE_WRITE_COUNT='+writes);}
 if(q.url==='/app.js'){s.setHeader('content-type','application/javascript');s.end('document.addEventListener("DOMContentLoaded",()=>{const p=document.createElement("p");p.textContent="Actual project JavaScript loaded";document.body.append(p)})');return;}
 if(q.url==='/status'){s.setHeader('content-type','application/json');s.end(JSON.stringify({writes,lastBody}));return;}
 s.setHeader('content-type','text/html');
 s.end('<!doctype html><h1>Actual PG HTTP VM project</h1><p>Writes: '+writes+'</p><p>Received: '+lastBody+'</p><script src="/app.js"></script><form method="post" action="/save"><input name="message" value="synthetic-p23"><button>Save once</button></form>');
});}).listen(3100,'127.0.0.1');`;

/** Only account/session scaffolding is synthetic. Source bytes, runner profile,
 * local grant fingerprint, dispatch, START, service events and VM are real. */
export async function createNativePreviewFixture(
  db: ReturnType<typeof postgres>,
  storageRoot: string,
  runner: LocalCommandRunner,
) {
  const f = await createCloudExecutionFixture(db, storageRoot, {
    browserControl: true,
    localBrowser: true,
    localProcess: true,
    localPreview: true,
  });
  const projectRoot = await realpath(
    await mkdtemp(join(storageRoot, 'project-')),
  );
  await writeFile(join(projectRoot, 'service.mjs'), previewProjectSource, {
    mode: 0o600,
  });
  const rootFingerprint = createHash('sha256')
    .update(projectRoot)
    .digest('hex');
  const sourceHash = `sha256:${createHash('sha256').update(previewProjectSource).digest('hex')}`;
  const deviceId = randomUUID(),
    targetId = randomUUID(),
    folderId = randomUUID();
  const token = `synthetic-p23-native-${randomUUID()}`;
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    name: 'P23 isolated native acceptance',
    platform: `macos-${process.arch}`,
    protocolVersion: 2,
    capabilities: ['local.fs.list'],
    status: 'online',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
  });
  await db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${deviceId},${f.org},${f.workspace},${f.user},${device.name},${device.platform},2,array['local.fs.list'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
    values(${targetId},${f.org},${f.workspace},${`bridge.${deviceId}`},'rice_bridge','Native isolated Bridge','online','["files.read"]',${db.json({ bridgeDeviceId: deviceId })})`;
  await db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
    values(${folderId},${f.org},${f.workspace},${f.user},${deviceId},'Native acceptance project',${rootFingerprint})`;
  const profile = await runner.preflight();
  await reportLocalCommandProfile(
    device,
    { contractVersion: 1, available: true, ...profile },
    db,
  );
  const created = await createLocalCommandOperation(
    {
      context: f.execution,
      callId: 'p23-native-service',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['service.mjs'],
        path: '.',
        files: [{ path: 'service.mjs', sha256: sourceHash }],
        limits: {
          timeoutMs: 10000,
          outputBytes: 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: 180000,
          readiness: { kind: 'http', port: 3100, path: '/', timeoutMs: 10000 },
          stdin: {
            mode: 'none',
            maxRequests: 1,
            maxBytes: 100,
            requestTimeoutMs: 1000,
          },
        },
      },
    },
    db,
  );
  await f.approve(created);
  return {
    ...f,
    device,
    token,
    targetId,
    folderId,
    projectRoot,
    rootFingerprint,
    created,
    processId: created.snapshot.binding.attempt.operationId,
  };
}

/** Read-only test oracle from this fixture's real supervisor stdout. It remains
 * available after browser authority is revoked; it is not a browser capability
 * and never issues a request to the project application. */
export async function readNativePreviewWrites(
  runner: LocalCommandRunner,
  containerId: string,
  processId: string,
) {
  if (!/^[a-f0-9]{64}$/.test(containerId))
    throw Error('invalid test container');
  const actual = await runner.api.json<{
    Config: { Labels: Record<string, string> };
  }>('GET', `/containers/${containerId}/json`);
  if (actual.Config.Labels['xyz.bplabs.allrice.service'] !== processId)
    throw Error('foreign test container');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      {
        socketPath: runner.config.socketPath,
        path: `/v1.45/containers/${containerId}/logs?stdout=1&stderr=1&follow=0`,
        method: 'GET',
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(Error('test logs unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (part: Buffer) => {
          size += part.length;
          if (size > 65536) req.destroy(Error('test log bound'));
          else chunks.push(part);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    const timer = setTimeout(
      () => req.destroy(Error('test log deadline')),
      2500,
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw Error('incomplete test log');
    const length = bytes.readUInt32BE(offset + 4);
    if (length > 65536 || offset + 8 + length > bytes.length)
      throw Error('invalid test log');
    frames.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  let stdout = '';
  for (const line of Buffer.concat(frames)
    .toString()
    .split('\n')
    .filter(Boolean)) {
    const event = JSON.parse(line) as { type: string; data?: string };
    if (event.type === 'stdout' && typeof event.data === 'string')
      stdout += Buffer.from(event.data, 'base64').toString();
  }
  return [...stdout.matchAll(/P23_NATIVE_WRITE_COUNT=(\d+)/g)].map((match) =>
    Number(match[1]),
  );
}
