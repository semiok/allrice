-- MET-210 (user 10-27): the employee's own agent preferences, frozen into each
-- Run. Question wait is DSH tool-ask-user `timeout` (default = DSH's own,
-- timed = seconds in DSH's range, forever = -1). Subagent limits are
-- dsh-subagent `maxDepth` / `maxActiveSubagents` with DSH's defaults, no cap.
alter table allrice_user_preferences
  add column question_wait_mode text not null default 'default'
    check (question_wait_mode in ('default', 'timed', 'forever')),
  add column question_wait_seconds integer
    check (question_wait_seconds between 1 and 2147483),
  add column subagent_max_depth bigint not null default 1
    check (subagent_max_depth >= 0 and subagent_max_depth <= 9007199254740991),
  add column subagent_max_active bigint not null default 8
    check (subagent_max_active >= 1 and subagent_max_active <= 9007199254740991),
  add constraint allrice_user_preferences_question_wait_seconds
    check ((question_wait_mode = 'timed') = (question_wait_seconds is not null));
