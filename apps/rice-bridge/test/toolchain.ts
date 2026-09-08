import { homedir } from 'node:os';
import { join } from 'node:path';
import { localCommandToolchainImageV1 } from '@allrice/contracts';

// Tests never follow DOCKER_HOST or the user's default Docker context.
export const testSocket = join(homedir(), '.colima/allrice-b2/docker.sock');
export const testImage =
  process.env.ALLRICE_LOCAL_DOCKER_TEST_IMAGE ?? localCommandToolchainImageV1;
