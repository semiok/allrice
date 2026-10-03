import {
  LocalFileToolArguments,
  FileDerivationArgumentsSchema,
} from '@allrice/contracts';

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
export const localFileNativeTools = [
  ...Object.entries(descriptions).map(([action, description]) => {
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
  }),
  {
    canonicalName: 'local.file.derive',
    wireName: 'local_file_derive',
    description:
      'Process inspected local bytes into a bounded ZIP, merge/extract/rotate PDF pages, or resize/re-encode PNG/JPEG/WebP as a private downloadable attachment. PDF pages are unique one-based numbers; rotations90/180/270; encrypted, signed or form PDFs refused. Image width/height are exact pixels, dimensions<=8192 and<=16MP; PNG/WebP retain alpha, JPEG uses white, animations use first frame, EXIF/ICC removed. PDF/image processing is a fixed isolated supervised native process, never host Python. This preserves source files and does not write host destinations. Use exact expected from local_file_inspect, never the native survey version. ZIP input/output and unpacked total each <=9000000 bytes, at most32 files. Reject traversal, links, encryption, duplicate names, invalid CRC or oversized expansion. To create a host file, separately call local_file_save with the returned objectId and checksum; never overwrite or retry unknown effects.',
    presentation: 'tool',
    timeoutMs: 3_800_000,
    isConcurrencySafe: false,
    parameters: {
      path: {
        type: 'string',
        enum: ['.'],
        description:
          'Current authorized folder; always dot, never a host path.',
      },
      inputs: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { path, expected },
        },
      },
      request: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            required: true,
            enum: [
              'zip_pack',
              'zip_list',
              'zip_extract',
              'pdf_merge',
              'pdf_extract',
              'pdf_rotate',
              'image_resize',
              'image_format',
            ],
          },
          fileName: {
            type: 'string',
            description:
              'One output basename for pack (.zip) or extract; omit for list.',
          },
          entry: {
            type: 'string',
            description:
              'Exact safe archive entry path; required only for extract.',
          },
          pages: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'One-based unique PDF pages in requested order; required for pdf_extract, optional for rotate.',
          },
          degrees: {
            type: 'integer',
            enum: [90, 180, 270],
            description: 'Required clockwise rotation for pdf_rotate.',
          },
          format: {
            type: 'string',
            enum: ['png', 'jpeg', 'webp'],
            description:
              'Required image output format; filename suffix must match.',
          },
          width: {
            type: 'integer',
            description:
              'Required exact output pixel width for image_resize, at most8192.',
          },
          height: {
            type: 'integer',
            description:
              'Required exact output pixel height for image_resize, at most8192, total pixels<=16000000.',
          },
          quality: {
            type: 'number',
            description: 'Optional encoded image quality, 0.01 through1.',
          },
        },
      },
    },
    validateArguments(args) {
      return FileDerivationArgumentsSchema.parse(args);
    },
  },
];
