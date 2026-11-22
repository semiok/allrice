import { renderMemoryIndexV2 } from '@allrice/contracts';

/** Content format memory-index-v2-native-mcp-v1, pinned by the new context
 * table's 4.0 generation. MET-272 at 13c1b201 exports memory_read; this is a
 * fixed rendering adaptation, never a tool alias or configurable tool name.
 * Reuse all V2 item/ordinal validation and leave legacy snapshots unchanged. */
export function renderNativeMemoryIndexV2(
  items: Parameters<typeof renderMemoryIndexV2>[0],
) {
  return renderMemoryIndexV2(items).replace(
    'Read marked details with workspace_memory_read(number)',
    'Read marked details with memory_read(number)',
  );
}
