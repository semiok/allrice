import { prepareDevelopmentDatabase } from './dev-environment.mjs';

try {
  await prepareDevelopmentDatabase();
} catch (error) {
  console.error(`[setup] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
