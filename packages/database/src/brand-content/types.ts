import type postgres from 'postgres';
import type {
  BrandContentCandidate,
  BrandContentImage,
  BrandContentVersionRef,
  BrandContextContent,
  BrandContentWorkflowPin,
  BrandContentFileRef,
  RequestContext,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';

export type BrandContentDatabase = ReturnType<typeof getDatabase>;
export type Tx = postgres.TransactionSql;
export type BrandContentAuthority = 'user' | 'workflow' | 'scheduler';
/** Internal ongoing work has current resource authority, not a browser login.
 * Default user mutations separately require and verify their real session. */
export type BrandContentIdentity = Omit<RequestContext, 'sessionId'> & {
  sessionId?: string;
};
export type Scope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  instanceId: string;
};
type Dated = { created_at: Date };
export type BrandRow = Dated & {
  id: string;
  name: string;
  revision: number;
  current_context_id: string;
  updated_at: Date;
};
export type ContextRow = Dated & {
  id: string;
  brand_name: string;
  number: number;
  digest: string;
  content: BrandContextContent;
};
export type BatchRow = Dated & {
  id: string;
  context_id: string;
  platform: string;
  revision: number;
  workflow: BrandContentWorkflowPin | null;
};
export type TopicRow = Dated & {
  id: string;
  context_id: string;
  platform: string;
  candidate: BrandContentCandidate;
  state: 'candidate' | 'accepted' | 'rejected';
  revision: number;
  decision_reason: string;
};
export type ArticleRow = Dated & {
  id: string;
  topic_id: string;
  topic_revision: number;
  context_id: string;
  session_id: string;
  platform: string;
  revision: number;
  state: 'awaiting_review' | 'changes_requested' | 'approved';
  current_bundle_id: string;
  updated_at: Date;
};
export type BundleRow = Dated & {
  id: string;
  article_id: string;
  number: number;
  content: BrandContentVersionRef;
  images: BrandContentImage[];
  digest: string;
  parent_bundle_id: string | null;
  source_review_id: string | null;
  change_summary: string;
  workflow: BrandContentWorkflowPin | null;
};
export type ReviewRow = Dated & {
  id: string;
  article_id: string;
  bundle_id: string;
  bundle_digest: string;
  decision: 'approved' | 'rejected';
  reason: string;
  decided_by: string;
};
export type PlanRow = Dated & {
  id: string;
  article_id: string;
  bundle_id: string;
  bundle_digest: string;
  review_id: string;
  revision: number;
  platform: string;
  planned_at: Date;
  timezone: string;
  publisher: string;
  notes: string;
  state: 'planned' | 'cancelled';
  reminder_status:
    'not_registered' | 'registered' | 'reminded' | 'failed' | 'unknown';
  automation_id: string | null;
  automation_run_id: string | null;
  run_id: string | null;
  reminder_message_id?: string | null;
  updated_at: Date;
};
export type ReceiptRow = Dated & {
  id: string;
  plan_id: string;
  bundle_digest: string;
  platform: string;
  publisher: string;
  published_url: string;
  actual_published_at: Date;
  source_type: 'manual_confirmation' | 'imported_public_record';
  evidence: string;
  evidence_files: BrandContentFileRef[];
  recorded_by: string;
};

export const brandContentTables = {
  contexts: 'allrice_brand_content_contexts',
  batches: 'allrice_brand_content_batches',
  topics: 'allrice_brand_content_topics',
  articles: 'allrice_brand_content_articles',
  bundles: 'allrice_brand_content_bundles',
  reviews: 'allrice_brand_content_reviews',
  plans: 'allrice_brand_content_plans',
  receipts: 'allrice_brand_content_receipts',
} as const;
