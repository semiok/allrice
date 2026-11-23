-- MET-270: the global runner owns DDL, its advisory lock and migration ledger.
-- This is the only live schema definition (formerly approval-gateway/0001).
-- A temporary reference lets us adopt an explicitly applied module table only
-- when its columns, defaults, constraints and indexes still match this schema.
CREATE TEMPORARY TABLE allrice_outbound_approvals_expected (
  request_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope_key, idempotency_key),
  CHECK (record->'ref'->>'requestId' = request_id::text),
  CHECK (record->>'scopeKey' = scope_key),
  CHECK (record->>'idempotencyKey' = idempotency_key)
) ON COMMIT DROP;

CREATE TABLE IF NOT EXISTS allrice_outbound_approvals (
  LIKE pg_temp.allrice_outbound_approvals_expected INCLUDING ALL
);

LOCK TABLE allrice_outbound_approvals IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  actual oid := format('%I.allrice_outbound_approvals', current_schema())::regclass;
  expected oid := 'pg_temp.allrice_outbound_approvals_expected'::regclass;
  mismatched boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = actual AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_inherits WHERE inhrelid = actual OR inhparent = actual
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = actual AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = actual
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite WHERE ev_class = actual
  ) THEN
    RAISE EXCEPTION 'outbound approval schema mismatch; migration not recorded';
  END IF;

  WITH definitions AS (
    SELECT relation,
      (
        SELECT jsonb_agg(jsonb_build_array(
          a.attnum, a.attname, a.atttypid, a.atttypmod, a.attcollation,
          a.attnotnull, a.attisdropped, a.attidentity, a.attgenerated,
          pg_get_expr(d.adbin, d.adrelid)
        ) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = relation AND a.attnum > 0
      ) AS columns,
      (
        SELECT jsonb_agg(definition ORDER BY definition::text)
        FROM (
          SELECT jsonb_build_array(
            contype, condeferrable, condeferred, convalidated, connoinherit,
            pg_get_constraintdef(oid)
          ) AS definition
          FROM pg_constraint WHERE conrelid = relation
        ) constraints
      ) AS constraints,
      (
        SELECT jsonb_agg(definition ORDER BY definition::text)
        FROM (
          SELECT jsonb_build_array(
            indisunique, indnullsnotdistinct, indisprimary, indisexclusion,
            indimmediate, indisvalid, indisready, indkey::text, indclass::text,
            indcollation::text, indoption::text,
            pg_get_expr(indexprs, indrelid), pg_get_expr(indpred, indrelid)
          ) AS definition
          FROM pg_index WHERE indrelid = relation
        ) indexes
      ) AS indexes
    FROM unnest(ARRAY[actual, expected]) AS relations(relation)
  )
  SELECT
    (SELECT ROW(columns, constraints, indexes) FROM definitions WHERE relation = actual)
    IS DISTINCT FROM
    (SELECT ROW(columns, constraints, indexes) FROM definitions WHERE relation = expected)
  INTO mismatched;

  IF mismatched THEN
    RAISE EXCEPTION 'outbound approval schema mismatch; migration not recorded';
  END IF;
END;
$$;

DROP TABLE pg_temp.allrice_outbound_approvals_expected;
