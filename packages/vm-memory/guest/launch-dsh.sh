#!/bin/sh
# Guest runtime owner invokes this with its original DSH executable and argv.
set -eu
: "${ALLRICE_MEMORY_DSH_GROUP:?memory_setup_required}"
: "${ALLRICE_MEMORY_DSH_OOM_SCORE:?memory_setup_required}"
: "${ALLRICE_MEMORY_PROC_ROOT:?memory_setup_required}"
printf '%s\n' "$$" > "$ALLRICE_MEMORY_DSH_GROUP/cgroup.procs"
printf '%s\n' "$ALLRICE_MEMORY_DSH_OOM_SCORE" > "$ALLRICE_MEMORY_PROC_ROOT/$$/oom_score_adj"
exec "$@"
