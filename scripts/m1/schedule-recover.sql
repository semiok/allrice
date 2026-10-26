-- Close proofs for schedule partitions whose owner is verified gone (MET-210 #3), run by
-- scripts/m1/schedule-recover with `psql -1 -v ON_ERROR_STOP=1` (one transaction) after
-- it has stopped the Worker and checked that no process or Worker session that could own
-- the partitions is left. psql variables:
--   targets   [{partitionId, ownerId, epoch, tokenDigest}] as the tool read them
--   evidence  the exit it verified (an object), kept in each proof
-- Writes what releaseClosedWriter writes after a clean shutdown
-- (packages/database/src/native-schedule-control-sql.ts): the audit row, then closed=true
-- with the same proof, so the next Worker's validClose accepts it. Owner, epoch and token
-- stay; occurrences, controls and journals are not touched. A partition that is not
-- exactly as read, still open with an expired lease and no proof yet raises, and nothing
-- of the transaction is written.
SELECT set_config('allrice.recover_targets', :'targets', true), set_config('allrice.recover_evidence', :'evidence', true);
DO $recover$
DECLARE
  targets jsonb := current_setting('allrice.recover_targets')::jsonb;
  evidence jsonb := current_setting('allrice.recover_evidence')::jsonb;
  t jsonb;
  p allrice_native_once_partitions%ROWTYPE;
  proof jsonb;
BEGIN
  IF jsonb_typeof(targets) IS DISTINCT FROM 'array' OR jsonb_array_length(targets) = 0
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'schedule-recover: targets or evidence missing';
  END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(targets) ORDER BY value->>'partitionId' LOOP
    SELECT * INTO p FROM allrice_native_once_partitions WHERE partition_id = t->>'partitionId' FOR UPDATE;
    IF NOT FOUND OR p.owner_id IS DISTINCT FROM t->>'ownerId' OR p.epoch IS DISTINCT FROM (t->>'epoch')::bigint
       OR p.token_digest IS DISTINCT FROM t->>'tokenDigest' OR p.closed OR p.close_proof <> 'null'::jsonb
       OR p.expires_at >= clock_timestamp()
       OR EXISTS (SELECT 1 FROM allrice_native_once_close_proofs f WHERE f.partition_id = p.partition_id AND f.epoch = p.epoch)
    THEN
      RAISE EXCEPTION 'schedule-recover: partition % is not as read (owner %, epoch %, closed %, lease until %); nothing written',
        t->>'partitionId', p.owner_id, p.epoch, p.closed, p.expires_at;
    END IF;
    proof := jsonb_build_object(
      'kind', 'verified_process_exit', 'proofId', gen_random_uuid()::text, 'partitionId', p.partition_id,
      'ownerId', p.owner_id, 'epoch', p.epoch, 'tokenDigest', p.token_digest,
      'evidence', evidence || jsonb_build_object('leaseExpiredAt', p.expires_at, 'verifiedBy', current_user,
                                                 'verifiedAt', clock_timestamp()));
    INSERT INTO allrice_native_once_close_proofs (partition_id, epoch, proof_id, proof)
    VALUES (p.partition_id, p.epoch, proof->>'proofId', proof);
    UPDATE allrice_native_once_partitions SET closed = true, close_proof = proof
    WHERE partition_id = p.partition_id AND epoch = p.epoch AND owner_id = p.owner_id
      AND token_digest = p.token_digest AND NOT closed;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'schedule-recover: partition % changed while closing; nothing written', p.partition_id;
    END IF;
    RAISE NOTICE 'schedule-recover: % epoch % closed with verified_process_exit %', p.partition_id, p.epoch, proof->>'proofId';
  END LOOP;
END
$recover$;
