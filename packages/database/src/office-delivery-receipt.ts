import {
  OfficeDeliveryReceiptSchema,
  officeMediaTypes,
  type OfficeDeliveryReceipt,
} from '@allrice/contracts';

type Output = { checksum: string; mediaType: string; format: string };

/** Validate facts against the object actually being registered, before writes.
 * No defaults or inference for historical receipts without these optional facts. */
export function parseOfficeDeliveryReceiptForObject(
  value: unknown,
  output: Output,
): OfficeDeliveryReceipt {
  const receipt = OfficeDeliveryReceiptSchema.parse(value);
  if (
    receipt.quality.status === 'checked' &&
    (receipt.quality.format !== output.format ||
      officeMediaTypes[receipt.quality.format] !== output.mediaType)
  )
    throw new Error('office_receipt_format_mismatch');
  if (receipt.savedValues) {
    if (output.format !== 'xlsx' || output.mediaType !== officeMediaTypes.xlsx)
      throw new Error('office_receipt_format_mismatch');
    if (receipt.savedValues.checksum !== output.checksum)
      throw new Error('office_receipt_checksum_mismatch');
  }
  return receipt;
}

/** Read only a receipt already persisted for this exact Run/version/object.
 * Invalid/missing historical facts stay unknown; never substitute a retry's
 * newly inspected or rendered receipt for the original publication. */
export function readBoundOfficeDeliveryReceipt(
  metadata: unknown,
  output: Output & { objectId: string; runId: string | null },
): OfficeDeliveryReceipt | null {
  if (!output.runId || !metadata || typeof metadata !== 'object') return null;
  const row = metadata as Record<string, unknown>;
  if (
    row.objectId !== output.objectId ||
    row.checksum !== output.checksum ||
    row.runId !== output.runId
  )
    return null;
  try {
    return parseOfficeDeliveryReceiptForObject(row.receipt, output);
  } catch {
    return null;
  }
}
