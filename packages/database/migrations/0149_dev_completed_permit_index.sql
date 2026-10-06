-- Completed scope metadata may be compacted. Unfinished/unknown permits are
-- never expired or removed by age; they remain a durable release barrier.
CREATE INDEX allrice_dev_producer_permits_completed_idx
  ON allrice_dev_producer_permits (finished_at)
  WHERE finished_at IS NOT NULL;
