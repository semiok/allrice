const modelOutputLimit = 20_000;
const truncationNotice =
  '应用结果较长，以下仅为部分预览，不代表完整列表或全部字段。请缩小 fields、减少 perPage 并分页查询；不要用预览条目数推断总数，也不要重复原样查询。';

/** DSH materializes the same MCP content in both content and value. Remove
 * value only when every field is already present, preserving distinct data. */
function withoutDuplicateValue(result: Record<string, unknown>) {
  const value = result.value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => JSON.stringify(result[key]) === JSON.stringify(item),
    )
  ) {
    const rest = { ...result };
    delete rest.value;
    return rest;
  }
  return result;
}

function preview(value: unknown, size: number, depth = 0): unknown {
  if (depth > 12) return '[内容已省略]';
  if (typeof value === 'string') {
    // MCP text often contains serialized JSON. Keep that JSON parseable too.
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.stringify(preview(JSON.parse(value), size, depth + 1));
      } catch {
        // Ordinary text uses an explicit, bounded excerpt.
      }
    }
    return value.length > size
      ? value.slice(0, size) + '…[后续内容已省略]'
      : value;
  }
  if (Array.isArray(value))
    return value
      .slice(0, Math.max(1, Math.floor(size / 16)))
      .map((item) => preview(item, size, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, preview(item, size, depth + 1)]),
    );
  return value;
}

/** Never slice serialized JSON. Small results remain exact; large results are
 * explicitly partial, valid JSON. The full redacted result still has its digest. */
export function serializeMcpModelResult(result: Record<string, unknown>) {
  const canonical = withoutDuplicateValue(result);
  const full = JSON.stringify(canonical);
  if (full.length <= modelOutputLimit) return full;
  for (const size of [1024, 512, 256, 128, 64, 16]) {
    const output = JSON.stringify({
      isError: result.isError === true,
      truncated: true,
      originalCharacters: full.length,
      notice: truncationNotice,
      preview: preview(canonical, size),
    });
    if (output.length <= modelOutputLimit) return output;
  }
  return JSON.stringify({
    isError: result.isError === true,
    truncated: true,
    originalCharacters: full.length,
    notice: truncationNotice,
  });
}

export const mcpPermissionGuidance =
  '连接成功、get_me 身份和协作者 admin/write 角色仅证明连接或账号权限，不证明当前连接令牌具备操作权限。GitHub 合并还取决于令牌覆盖目标仓库并具有 Contents: Read and write，以及分支保护、审查和检查状态。仅做只读核查时，应明确说明令牌合并权限尚未验证；不要为测试权限而执行合并或其他写操作。';
