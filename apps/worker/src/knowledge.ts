import {
  indexKnowledgeDocumentForExecution,
  listKnowledgeSourceFilesForExecution,
  retrieveKnowledgeForExecution,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import type { ExecutionContext, KnowledgeCitation } from '@allrice/contracts';

const maximumKnowledgeFileBytes = 2_000_000;
const chunkCharacters = 2_400;
const chunkOverlap = 240;

async function readText(
  storage: LocalStorageAdapter,
  object: Parameters<LocalStorageAdapter['get']>[0],
) {
  if (object.sizeBytes > maximumKnowledgeFileBytes) {
    throw new Error('knowledge source file exceeds the indexing limit');
  }
  const stream = await storage.get(object);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumKnowledgeFileBytes) {
        throw new Error('knowledge source file exceeds the indexing limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks).toString('utf8');
  if (object.mediaType !== 'application/json') return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function chunkKnowledgeText(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const chunks: { content: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkCharacters);
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf('\n\n', end);
      if (paragraph > start + chunkCharacters / 2) end = paragraph;
    }
    const content = normalized.slice(start, end).trim();
    if (content) chunks.push({ content, start, end });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - chunkOverlap);
  }
  return chunks;
}

export async function buildAuthorizedKnowledgeContext(input: {
  context: ExecutionContext;
  employeeId: string;
  knowledgeRevisionIds: string[];
  query: string;
  storageRoot: string;
}): Promise<{ context: string; citations: KnowledgeCitation[] }> {
  if (input.knowledgeRevisionIds.length === 0) {
    return { context: '', citations: [] };
  }
  const files = await listKnowledgeSourceFilesForExecution(input);
  const storage = new LocalStorageAdapter(input.storageRoot);
  for (const file of files.filter((candidate) => candidate.needsIndex)) {
    const text = await readText(storage, file.object);
    const chunks = chunkKnowledgeText(text);
    if (chunks.length === 0) continue;
    await indexKnowledgeDocumentForExecution({
      context: input.context,
      employeeId: input.employeeId,
      document: {
        knowledgeRevisionId: file.knowledgeRevisionId,
        sourceRef: file.sourceRef,
        storageObjectId: file.object.id,
        ownerId: file.object.ownerId,
        visibility: file.visibility,
        title: file.title,
        mediaType: file.object.mediaType,
        checksum: file.object.checksum,
        updatedAt: file.updatedAt,
        chunks,
      },
    });
  }
  const results = await retrieveKnowledgeForExecution({
    context: input.context,
    employeeId: input.employeeId,
    knowledgeRevisionIds: input.knowledgeRevisionIds,
    query: input.query,
  });
  return {
    context:
      results.length === 0
        ? 'Authorized Knowledge retrieval returned no matching content.'
        : [
            'Authorized Knowledge snapshot. Cite claims using the supplied [K#] labels; do not infer access to any other source.',
            ...results.map(
              (result, index) =>
                `[K${index + 1}] ${result.citation.label}\n${result.content}`,
            ),
          ].join('\n\n'),
    citations: results.map((result) => result.citation),
  };
}
