import {
  CreateMemoryInputSchema,
  VectorRecallInputSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  createMemory,
  createRagChunk,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

const CreateMemoryWithEmbeddingSchema = CreateMemoryInputSchema.extend({
  embedding: VectorRecallInputSchema.shape.embedding,
}).strict();

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = CreateMemoryWithEmbeddingSchema.parse(await request.json());
    const { embedding, ...memoryInput } = input;
    const memory = await createMemory(context, memoryInput);
    const chunk = await createRagChunk(context, {
      workspaceId: input.workspaceId,
      memoryId: memory.id,
      content: input.content,
      embedding,
    });
    return Response.json({ memory, chunk }, { status: 201 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
