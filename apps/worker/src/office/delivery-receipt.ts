import { createHash } from 'node:crypto';
import {
  OfficeDeliveryReceiptSchema,
  type OfficeDeliveryReceipt,
} from '@allrice/contracts';
import { HandlerError } from '../errors.js';

/** The same typed projection goes to the tool result and both publishers.
 * Hash final returned bytes, not the renderer's earlier input. */
export function officeDeliveryReceipt(
  finalBytes: Buffer,
  checked: OfficeDeliveryReceipt,
): OfficeDeliveryReceipt {
  let receipt: OfficeDeliveryReceipt;
  try {
    receipt = OfficeDeliveryReceiptSchema.parse(checked);
  } catch {
    throw new HandlerError(
      'OFFICE_DOCUMENT_INVALID',
      '最终文件的 Office 检查回执无效，未发布正式成果。',
      false,
    );
  }
  if (
    receipt.savedValues &&
    receipt.savedValues.checksum !==
      `sha256:${createHash('sha256').update(finalBytes).digest('hex')}`
  )
    throw new HandlerError(
      'OFFICE_DOCUMENT_INVALID',
      'Office 保存值事实与最终文件不一致，未发布正式成果。',
      false,
    );
  return receipt;
}

/** Null means no persisted Office receipt, not a successful reinspection. */
export function officeDeliveryResultFields(value: unknown) {
  const parsed = OfficeDeliveryReceiptSchema.safeParse(value);
  const receipt = parsed.success ? parsed.data : null;
  return {
    quality: receipt?.quality,
    warnings: receipt?.warnings ?? [],
    savedValues: receipt?.savedValues,
    diagnostic: receipt?.diagnostic,
  };
}
