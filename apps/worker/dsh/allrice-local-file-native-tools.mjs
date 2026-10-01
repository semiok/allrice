import { LocalFileToolArguments } from '@allrice/contracts';

const path = {
  type: 'string',
  required: true,
  description:
    'Exact relative filename inside the current authorized Bridge folder. Preserve spaces and Chinese characters; never supply an absolute path.',
};
const checksum = {
  type: 'string',
  required: true,
  description:
    'Exact sha256 checksum returned by the file tools; never infer it.',
};
const expected = {
  type: 'object',
  required: true,
  additionalProperties: false,
  description:
    'Copy the exact version returned by local_file_inspect or local_file_save. If the file changed or moved, inspect it again; unknown effects must not be replayed.',
  properties: {
    checksum,
    sizeBytes: { type: 'integer', required: true },
    version: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
  },
};
const descriptions = {
  inspect:
    'Inspect one file in the authorized Bridge folder and return its content checksum and physical file version. This does not upload bytes.',
  import:
    'Upload the exact inspected local file as an existing workspace attachment. Pass expected from local_file_inspect; respect requests to keep local inputs off the platform. An uploaded receipt means the server verified the actual bytes.',
  save: 'Save an existing authorized platform object into the Bridge folder using its objectId and checksum. Create-only: never overwrite an existing name. Report the physical save separately from platform download availability.',
  open: 'Ask the Mac default application to open the exact inspected or saved document/image. The system receipt proves the open action was accepted, not that the user read the file. Executables and scripts are refused.',
  reveal:
    'Reveal the exact inspected or saved document/image in Finder. Use its current expected version and relative filename; do not invent a disk path or claim the user read it.',
};

// Model declarations only. The shared strict contract and the existing Broker
// independently enforce frozen tools, device/grant binding and v2 authority.
export const localFileNativeTools = Object.entries(descriptions).map(
  ([action, description]) => {
    const canonicalName = `local.file.${action}`;
    return {
      canonicalName,
      wireName: `local_file_${action}`,
      description,
      presentation: 'tool',
      // Match the existing native governed-tool wait window. The operation's
      // immutable Run/job deadline and execution lease are not extended.
      timeoutMs: 3_800_000,
      isConcurrencySafe: false,
      parameters: {
        path,
        ...(action === 'save'
          ? {
              objectId: {
                type: 'string',
                required: true,
                description:
                  'Tenant-authorized immutable storage object UUID returned by workspace_file_list or a deliverable.',
              },
              checksum,
            }
          : action === 'inspect'
            ? {}
            : { expected }),
      },
      validateArguments(args) {
        LocalFileToolArguments[canonicalName].parse(args);
        return args;
      },
    };
  },
);
