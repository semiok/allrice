import { McpError } from './mcp.ts';

export function assertMcpSchemaSubset(schema: Record<string, unknown>) {
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 32_768)
    throw new McpError('MCP_LIMIT');
  let nodes = 0;
  function visit(value: unknown, depth: number) {
    if (depth > 24 || ++nodes > 4_096) throw new McpError('MCP_LIMIT');
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      // A schema cannot perform network I/O or inject prototypes. Rejecting all
      // refs is an explicit first-release subset, not an unsafe ref resolver.
      if (
        [
          '$ref',
          '$dynamicRef',
          '$recursiveRef',
          '__proto__',
          'constructor',
          'prototype',
        ].includes(key)
      )
        throw new McpError('MCP_INVALID_SCHEMA');
      visit(item, depth + 1);
    }
  }
  visit(schema, 0);
  if (schema.type !== 'object') throw new McpError('MCP_INVALID_SCHEMA');
  const keywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'description',
    'title',
    'default',
    '$schema',
  ]);
  function supported(value: unknown): void {
    if (typeof value === 'boolean') return;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new McpError('MCP_INVALID_SCHEMA');
    for (const [key, item] of Object.entries(value)) {
      // Explicit bounded subset: never silently ignore a newer constraint,
      // compile an attacker-controlled regex, or resolve schema references.
      if (!keywords.has(key)) throw new McpError('MCP_INVALID_SCHEMA');
      if (key === 'properties') {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new McpError('MCP_INVALID_SCHEMA');
        for (const child of Object.values(item)) supported(child);
      } else if (
        key === 'items' ||
        (key === 'additionalProperties' && typeof item !== 'boolean')
      )
        supported(item);
    }
  }
  supported(schema);
}
