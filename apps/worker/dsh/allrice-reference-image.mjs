/* global AbortSignal */
import { Buffer } from 'node:buffer';
import {
  ReferenceImageCallSchema,
  ReferenceImageAttachmentSchema,
  ReferenceReadImageResultSchema,
  ReferenceImageErrorSchema,
  ReferenceImageFailureSchema,
  referenceImagePolicy,
} from '@allrice/contracts/native-runtime';

const routeUnavailable = () => ({
  error: {
    code: 'REFERENCE_READ_UNSUPPORTED',
    reason: 'image_route',
    retryable: false,
    message:
      '当前模型路由未明确支持图片输入，暂时无法查看这张企业资料图片；本次未返回图片内容，也未自动切换模型。',
  },
});
const timeout = () => ({
  error: {
    code: 'REFERENCE_READ_TIMEOUT',
    reason: 'operation_budget',
    retryable: true,
    message: '本次图片读取超过时限，未自动重试。',
  },
});

export function referenceImageFailure(error) {
  const parsed = ReferenceImageFailureSchema.safeParse({
    code: error?.code,
    message: error?.message,
    retryable: error?.retryable ?? true,
  });
  if (!parsed.success) throw error;
  return { failure: parsed.data };
}

/** Private Worker RPC only; model tools never receive a host path/store handle. */
export async function referenceImageOperation(server, operation, params) {
  const call = ReferenceImageCallSchema.parse(params.call);
  const agent = server.ctx.agents.get(call.nativeSessionId);
  if (
    !agent ||
    !server.runAdmission ||
    server.runAdmission.attribute({ nativeSessionId: agent.id }).runId !==
      params.runId
  )
    throw Error('RUN_SESSION_DENIED');
  server.runAdmission.rootFor(agent);
  if (
    !Number.isSafeInteger(params.deadlineAt) ||
    params.deadlineAt > Date.now() + referenceImagePolicy.operationMilliseconds
  )
    throw Error('REFERENCE_IMAGE_DEADLINE_INVALID');
  if (params.deadlineAt <= Date.now()) return timeout();
  const signal = AbortSignal.timeout(params.deadlineAt - Date.now());
  const attachments = server.ctx.get('attachments');
  const llm = server.ctx.get('llm');
  const routed = agent.session.requestHeader()?.config;
  const provider = routed?.provider ?? agent.options.provider;
  const model = routed?.model ?? agent.options.model;
  if (!attachments || !llm || provider === undefined || model === undefined)
    return routeUnavailable();
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, signal);
  } catch (error) {
    if (signal.aborted) return timeout();
    throw error;
  }
  if (signal.aborted) return timeout();
  if (!info?.inputModalities?.includes('image')) return routeUnavailable();
  if (operation === 'route') return { supported: true };
  if (operation !== 'save') throw Error('REFERENCE_IMAGE_OPERATION_INVALID');
  if (
    typeof params.data !== 'string' ||
    params.data.length > Math.ceil(referenceImagePolicy.maximumBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data) ||
    params.data.length % 4 ||
    !['image/png', 'image/jpeg'].includes(params.mediaType) ||
    typeof params.name !== 'string' ||
    !params.name ||
    params.name.length > 255
  )
    throw Error('REFERENCE_IMAGE_SAVE_INVALID');
  const data = Buffer.from(params.data, 'base64');
  if (
    data.toString('base64') !== params.data ||
    data.length > referenceImagePolicy.maximumBytes
  )
    throw Error('REFERENCE_IMAGE_SAVE_INVALID');
  try {
    // Public batch admission also preserves deployment count/aggregate limits.
    const [image] = await attachments.saveImages([
      { data, mediaType: params.mediaType, name: params.name },
    ]);
    if (signal.aborted) return timeout();
    server.runAdmission.rootFor(agent);
    return { image: ReferenceImageAttachmentSchema.parse(image) };
  } catch (error) {
    if (signal.aborted) return timeout();
    const mapped = {
      UNSUPPORTED_IMAGE_TYPE: ['REFERENCE_READ_UNSUPPORTED', 'media_type'],
      INVALID_IMAGE: ['REFERENCE_READ_INVALID', 'image_decode'],
      IMAGE_TYPE_MISMATCH: ['REFERENCE_READ_INVALID', 'image_type_mismatch'],
      IMAGE_TOO_LARGE: ['REFERENCE_READ_LIMIT', 'image_bytes'],
      IMAGE_DIMENSION_TOO_LARGE: ['REFERENCE_READ_LIMIT', 'image_dimensions'],
      IMAGE_TOO_MANY_PIXELS: ['REFERENCE_READ_LIMIT', 'image_pixels'],
      TOO_MANY_IMAGES: ['REFERENCE_READ_LIMIT', 'native_image_budget'],
      IMAGES_TOO_LARGE: ['REFERENCE_READ_LIMIT', 'native_image_budget'],
    }[error?.code];
    // Storage/transport failures retain their original classification.
    if (!mapped) throw error;
    return {
      error: ReferenceImageErrorSchema.parse({
        code: mapped[0],
        reason: mapped[1],
        message: '原生图片服务无法接收这张图片，未返回图片内容。',
        retryable: false,
      }),
    };
  }
}

export const referenceImageOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { type: 'string', required: true },
      image: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          name: { type: 'string' },
          originalDimensions: {
            type: 'object',
            additionalProperties: false,
            properties: {
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
    },
  },
  render: (_args, value) => [
    { type: 'text', text: value.content },
    {
      type: 'image',
      attachment: ReferenceImageAttachmentSchema.parse(value.image),
    },
  ],
};

export function referenceImageValue(response) {
  const value = ReferenceReadImageResultSchema.parse(response.referenceImage);
  if (JSON.stringify(value) !== response.modelContent)
    throw Error('REFERENCE_IMAGE_RESULT_INVALID');
  return { content: response.modelContent, image: value.image };
}

// Same public image renderer; text members keep an ordinary text-only result.
// DSH marks optional fields by omitting required, not by setting it to false.
const archiveImageSchema = { ...referenceImageOutput.schema.properties.image };
delete archiveImageSchema.required;
export const referenceArchiveOutput = {
  schema: {
    ...referenceImageOutput.schema,
    properties: {
      ...referenceImageOutput.schema.properties,
      image: archiveImageSchema,
    },
  },
  render: (args, value) =>
    value.image
      ? referenceImageOutput.render(args, value)
      : [{ type: 'text', text: value.content }],
};
