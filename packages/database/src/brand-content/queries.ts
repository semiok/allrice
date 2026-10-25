import { BrandContextContentSchema } from '@allrice/contracts';
import {
  assertBrandContentDocument,
  assertBrandContentFile,
  assertBrandContentImages,
} from './authority.ts';
import {
  brandContentDigest,
  brandContentBundleDigest,
  brandContentFail as fail,
} from './rules.ts';
import {
  brandContentTables,
  type Tx,
  type Scope,
  type BrandRow,
  type ContextRow,
  type ArticleRow,
  type BundleRow,
  type BrandContentIdentity,
} from './types.ts';

export async function readBrand(
  tx: Tx,
  scope: Scope,
  id: string,
  lock = false,
  /** `false` on read paths: no row lock at all (MET-210 #4). */
  share = true,
) {
  const [row] = await tx<BrandRow[]>`select * from allrice_brand_content_brands
    where id=${id} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
    ${lock ? tx`for update` : share ? tx`for share` : tx``}`;
  if (!row) fail('not_found');
  return row;
}
export async function scopedRow<T extends object>(
  tx: Tx,
  scope: Scope,
  table: keyof typeof brandContentTables,
  brandId: string,
  id: string,
  lock = true,
) {
  const [row] = await tx<T[]>`select * from ${tx(brandContentTables[table])}
    where id=${id} and brand_id=${brandId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} ${lock ? tx`for share` : tx``}`;
  if (!row) fail('not_found');
  return row;
}
export async function scopedRows<T extends object>(
  tx: Tx,
  scope: Scope,
  table: keyof typeof brandContentTables,
  brandId: string,
) {
  return tx<T[]>`select * from ${tx(brandContentTables[table])}
    where brand_id=${brandId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
    order by created_at desc,id desc limit 201`;
}
export async function readBrandContext(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  id: string,
  lock = true,
) {
  const row = await scopedRow<ContextRow>(
    tx,
    scope,
    'contexts',
    brandId,
    id,
    lock,
  );
  row.content = BrandContextContentSchema.parse(row.content);
  if (
    brandContentDigest({ name: row.brand_name, content: row.content }) !==
    row.digest
  )
    fail('source_changed');
  for (const file of row.content.sourceFiles)
    await assertBrandContentFile(tx, context, scope, file, false, lock);
  return row;
}
export async function assertBrandBundle(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  article: ArticleRow,
  bundle: BundleRow,
  lock = true,
) {
  if (bundle.article_id !== article.id) fail('not_found');
  if (
    brandContentBundleDigest(
      article.platform,
      bundle.content,
      bundle.images,
    ) !== bundle.digest
  )
    fail('source_changed');
  await readBrandContext(tx, context, scope, brandId, article.context_id, lock);
  await assertBrandContentDocument(
    tx,
    context,
    scope,
    article.session_id,
    bundle.content,
    false,
    lock,
  );
  await assertBrandContentImages(tx, context, scope, bundle.images, lock);
}
