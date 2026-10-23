import { cloudPlatform } from '@allrice/contracts';

// Built from infra/docker/Dockerfile.office-sandbox. This is selected by the
// server, never by model arguments. DSH Office assets remain byte-identical.
export const officeSandboxImage: string = cloudPlatform.images.office;
