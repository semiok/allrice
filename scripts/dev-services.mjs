import { spawnDevelopmentServices } from './dev-environment.mjs';

try {
  const child = spawnDevelopmentServices();
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
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
