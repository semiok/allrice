// Model-visible native declarations; publication and execution authority stay
// in the Tool Broker. Keep wire enums in parity with its validated definitions.
import {
  ImageToolInputSchema,
  IMAGE_MODEL_SELECTION_GUIDANCE,
  IMAGE_PROMPT_GUIDANCE,
  PLATFORM_IMAGE_MODELS,
  OfficeExportSchema,
  NativeOfficeExportSchema,
  OfficePdfExportSchema,
  ExecutionLocationSchema,
} from '@allrice/contracts';

export const workbenchNativeTools = [
  ...['generate', 'edit'].map((action) => ({
    canonicalName: `image.${action}`,
    wireName: `image_${action}`,
    timeoutMs: 320_000,
    isConcurrencySafe: false,
    presentation: 'tool',
    description:
      action === 'generate'
        ? 'Generate one image only when the user requests drawing or image creation. Return the real downloadable PNG. Do not use for image understanding. Never retry unknown results.'
        : 'Edit a specific authorized image and preserve its original version. Resolve source.objectId and checksum via workspace_file_list. Ask if the source is ambiguous. Never retry unknown results.',
    validateArguments: (args) => ImageToolInputSchema.parse(args),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description:
          'Detailed image creation or edit instructions, max 4000 characters. ' +
          IMAGE_PROMPT_GUIDANCE,
      },
      imageModel: {
        type: 'string',
        enum: [...PLATFORM_IMAGE_MODELS],
        description: IMAGE_MODEL_SELECTION_GUIDANCE,
      },
      fileName: {
        type: 'string',
        required: true,
        description: 'Human-readable PNG filename.',
      },
      source: {
        type: 'object',
        ...(action === 'edit' ? { required: true } : {}),
        additionalProperties: false,
        properties: {
          objectId: {
            type: 'string',
            required: true,
            description: 'Authorized exact source storage object UUID.',
          },
          checksum: {
            type: 'string',
            required: true,
            description: 'Exact sha256 checksum returned by AllRice.',
          },
        },
      },
    },
  })),
  {
    canonicalName: 'workspace.export.create',
    wireName: 'workspace_export_create',
    description:
      'Create a tenant-private deliverable or reviewable file-change proposal in AllRice managed storage when requested. Native Python Office can use the authorized ready Bridge runtime; select its execution location with the top-level location parameter. Publishing a proposal does not write to the local device.',
    presentation: 'tool',
    validateArguments(args) {
      if (
        [args.content, args.office, args.python, args.officePdf].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        throw new Error(
          'Supply exactly one of content, python, officePdf or legacy office.',
        );
      if (args.location !== undefined) {
        if (args.python === undefined && args.officePdf === undefined)
          throw new Error(
            'location applies only to python native Office or officePdf conversion.',
          );
        ExecutionLocationSchema.parse(args.location);
      }
      if (args.officePdf !== undefined) {
        OfficePdfExportSchema.parse(args.officePdf);
        if (args.format !== 'pdf')
          throw new Error('officePdf requires format=pdf.');
        if (args.artifactKind !== undefined && args.artifactKind !== 'document')
          throw new Error('officePdf delivers a document.');
      }
      if (args.python !== undefined) {
        if (args.inputs !== undefined || args.sourceObjectId !== undefined)
          throw new Error(
            'Put inputs and sourceObjectId INSIDE python: {script, inputs, sourceObjectId}. Use storage object IDs and checksums returned by workspace_file_list/workspace_document_read, not attachment IDs.',
          );
        NativeOfficeExportSchema.parse(args.python);
      }
      if (args.office !== undefined) {
        const parsed = OfficeExportSchema.safeParse(args.office);
        if (!parsed.success)
          throw new Error(
            'Invalid Office payload: ' +
              parsed.error.issues
                .slice(0, 5)
                .map(
                  (issue) => `office.${issue.path.join('.')}: ${issue.message}`,
                )
                .join('; '),
          );
      }
    },
    parameters: {
      artifactKind: {
        type: 'string',
        enum: ['document', 'plan', 'changeset'],
        description:
          'document or plan for deliverables; changeset for a reviewed proposal in the current authorized Bridge folder, always format=json. Text changes use content={"files":[{"path":"relative/path","before":"original text or null for a new file","after":"new full text or null for deletion"}]}, after reading existing text. Original-byte copy/move/rename uses content={"operations":[{"path":"source/path","target":"destination/path","operation":"copy|move|rename","source":{"checksum":"exact survey SHA","version":"exact native survey version","sizeBytes":123},"expectedDestination":null}]}, encoded as JSON. Read source from local_fs_list with survey.hash=true; never substitute the different local_file_inspect version or represent binary files as text. At most 32 files, each <=9000000 bytes, total <=128000000 bytes. Existing destination parents are required; no overwrite, overlapping paths, cycles or permanent deletion. Supply the exact source proof; do not supply device IDs, grants or approvals. Publishing never executes changes; the user separately requests application through the workbench and must approve the exact action when required by their work mode. Plan acceptance is not action authorization. Preserve per-file confirmed, unexecuted and unknown outcomes without replay; recovery only inverses confirmed moves with unchanged destination versions, and copies remain.',
      },
      fileName: {
        type: 'string',
        required: true,
        description: 'Human-readable file name.',
      },
      format: {
        type: 'string',
        required: true,
        enum: [
          'markdown',
          'text',
          'html',
          'json',
          'docx',
          'xlsx',
          'pptx',
          'pdf',
        ],
      },
      content: {
        type: 'string',
        description:
          'Complete final text content, or the changeset JSON proposal. Supply exactly one of content, python or legacy office.',
      },
      python: {
        type: 'object',
        additionalProperties: false,
        properties: {
          script: {
            type: 'string',
            required: true,
            description: 'Python code. Save /tmp/work/output/result.<format>.',
          },
          inputs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: {
                  type: 'string',
                  required: true,
                  description:
                    'Relative input filename, available at /tmp/work/input/<path>.',
                },
                objectId: {
                  type: 'string',
                  required: true,
                  description:
                    'Storage object UUID returned by the file tools; not an attachment ID.',
                },
                checksum: {
                  type: 'string',
                  required: true,
                  description:
                    'Exact sha256 checksum returned by the file tools.',
                },
              },
            },
          },
          sourceObjectId: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'For edits, the input object ID also listed in python.inputs. For new files omit this field or use null.',
          },
          changeSummary: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'Optional version summary; the top-level changeSummary is preferred. Do not supply conflicting summaries.',
          },
        },
        description:
          'Default Office workflow. New-file example: {fileName: "report.xlsx", format: "xlsx", python: {script: "Python code", inputs: []}}. For edits add inputs: [{path, objectId, checksum}] and sourceObjectId INSIDE python; for new files omit sourceObjectId or use null. Put changeSummary and execution location at the top level. Preinstalled python-docx, openpyxl, pandas, python-pptx; no installation needed. Files are /tmp/work/input/<path>; write exactly /tmp/work/output/result.<format>. A fresh isolated workspace per call. Upstream check_office.py runs automatically before versioned download. Formula recalculation and preview depend on actual quality capabilities and data authorization; local-only execution does not send bytes to cloud quality services. Inspect returned quality and nativeExecution rather than assuming recalculation or preview succeeded. Read the Office Skill format guide first. Use native libraries freely for document features; no fixed edit-operation list.',
      },
      location: {
        type: 'string',
        enum: ['auto', 'local', 'cloud'],
        description:
          'Optional for python native Office or officePdf. Omit for auto: prefer the ready Bridge capability; when the Office-to-PDF converter is absent locally, only conversion of that authorized Office file uses the server DSH provider. local requires local execution; local-only data must not be sent to cloud. Never supply device IDs or runtime paths.',
      },
      officePdf: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectId: {
            type: 'string',
            required: true,
            description:
              'Exact authorized Office storage object UUID, not an attachment ID.',
          },
          checksum: {
            type: 'string',
            required: true,
            description:
              'Exact sha256 checksum returned by the file or export tools.',
          },
        },
        description:
          'Convert the same existing DOCX/XLSX/PPTX into a formal PDF using DSH Office-to-PDF. Example: {fileName: "report.pdf", format: "pdf", officePdf: {objectId: "...", checksum: "sha256:..."}}. Supply officePdf alone instead of content/python/legacy office; do not regenerate the report or supply a path/script. Inspect actual conversion location and missingFonts warnings. A PDF starts its own version series and retains the Office source; to revise that PDF use its previous objectId as top-level parentObjectId.',
      },
      office: {
        type: 'object',
        additionalProperties: true,
        description:
          'Compatibility only for previously frozen employee packages. Current Office workflows use python with native document libraries.',
      },
      parentObjectId: {
        type: 'string',
        description:
          'Existing tenant-scoped deliverable object UUID when this file is a revision. Omit when creating the first version.',
      },
      changeSummary: {
        type: 'string',
        description:
          'Short human-readable summary of what changed from the parent version.',
      },
    },
  },
];
