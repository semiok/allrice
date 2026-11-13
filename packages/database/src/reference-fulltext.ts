import type postgres from 'postgres';
import { z } from 'zod';
import type { StorageObject } from '@allrice/contracts';
import { isIndexableKnowledgeTextSource } from './memory/knowledge-retrieval.ts';

/** Same 20 MiB binary-document cap as the existing Worker document reader. */
export function isIndexableReferenceSource(
  source: Pick<StorageObject, 'mediaType' | 'sizeBytes'>,
) {
  return (
    isIndexableKnowledgeTextSource(source) ||
    ([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ].includes(source.mediaType) &&
      source.sizeBytes >= 0 &&
      source.sizeBytes <= 20 * 1024 * 1024)
  );
}

/** Derived text only. Publication, authorization and processing remain elsewhere. */
const ReferenceFullTextSchema = z
  .object({
    text: z.string().min(1),
    kind: z.enum(['text', 'pdf', 'docx', 'xlsx', 'pptx']),
    totalPages: z.number().int().positive().optional(),
    units: z.array(
      z
        .object({
          label: z.string(),
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          pageNumber: z.number().int().positive().optional(),
          sheetName: z.string().optional(),
        })
        .strict(),
    ),
    tables: z
      .array(
        z
          .object({
            pageNumber: z.number().int().positive(),
            tableNumber: z.number().int().positive(),
            rows: z.array(
              z
                .object({
                  rowNumber: z.number().int().positive(),
                  cells: z.array(z.string()),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    warnings: z.array(z.string()),
    parser: z.object({ name: z.string(), version: z.string() }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    let previousEnd = 0;
    for (const unit of value.units) {
      if (
        unit.start < previousEnd ||
        unit.end < unit.start ||
        unit.end > value.text.length
      ) {
        context.addIssue({ code: 'custom', message: 'Invalid text locator' });
      }
      previousEnd = unit.end;
    }
    if (!value.text.trim() || !value.units.length) {
      context.addIssue({ code: 'custom', message: 'Empty full text' });
    }
    if (
      value.kind === 'pdf' &&
      (value.totalPages !== value.units.length ||
        value.units.some(
          (unit, index) =>
            unit.pageNumber !== index + 1 || unit.end === unit.start,
        ))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Incomplete physical PDF pages',
      });
    }
  });

export type ReferenceFullText = z.infer<typeof ReferenceFullTextSchema>;

export function validateReferenceFullText(input: ReferenceFullText) {
  return ReferenceFullTextSchema.parse(input);
}

/** Only adds derived fields to the exact existing document. No authority writes. */
export async function writeReferenceFullText(
  tx: postgres.TransactionSql,
  documentId: string,
  fullText: ReferenceFullText,
) {
  await tx`update allrice_knowledge_documents
    set full_text=${fullText.text},
      full_text_locations=${tx.json({
        units: fullText.units,
        ...(fullText.tables ? { tables: fullText.tables } : {}),
      })},
      full_text_metadata=${tx.json({
        kind: fullText.kind,
        ...(fullText.totalPages ? { totalPages: fullText.totalPages } : {}),
        warnings: fullText.warnings,
        ...(fullText.parser ? { parser: fullText.parser } : {}),
      })}
    where id=${documentId}`;
}
