import {
  ensureStorageDirectory,
  prepareOfficeRenderer,
  prepareDevelopmentDatabase,
  spawnDevelopmentServices,
} from './dev-environment.mjs';

try {
  await ensureStorageDirectory();
  await prepareDevelopmentDatabase();
  await prepareOfficeRenderer();

  console.info('[dev] Starting Web and Worker...');
  const child = spawnDevelopmentServices();

  process.on('SIGTERM', () => child.kill('SIGTERM'));

  child.on('error', (error) => {
    console.error(`[dev] Could not start services: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
