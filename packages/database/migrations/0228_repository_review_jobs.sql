-- Reviews are ordinary independent Jobs. Keep existing historical facts, but
-- their assistant report is no longer execution or merge authority.
alter table allrice_platform_repository_review_subjects
  drop constraint allrice_platform_repository_review_subjects_reviewer_run_id_fkey,
  add foreign key (reviewer_run_id) references allrice_runs(id);
alter table allrice_platform_repository_reviews
  drop constraint allrice_platform_repository_reviews_reviewer_run_id_fkey,
  add foreign key (reviewer_run_id) references allrice_runs(id);
-- 0101/0102 are the separate legacy development workflow; PR2b deletes that
-- closed dependency set. This migration does not change those tables.
