# Same-person root cooperation only. Native bash sources this public BASH_ENV.
# No retry, sleep, second command runner, or guest-authoritative model admission.
allrice_memory_fail() {
  printf 'COMMAND_MEMORY_SETUP_FAILED: 命令内存保护未就绪，本次命令未执行，会话保留\n' >&2
  if [ "${allrice_memory_child_created:-0}" = 1 ]; then
    rmdir "$allrice_memory_child" 2>/dev/null || true
  fi
  exit 75
}
[ -n "${ALLRICE_MEMORY_COMMANDS_GROUP:-}" ] || allrice_memory_fail
[ -n "${ALLRICE_MEMORY_DSH_GROUP:-}" ] || allrice_memory_fail
[ -n "${ALLRICE_MEMORY_PROC_ROOT:-}" ] || allrice_memory_fail
[ -n "${ALLRICE_MEMORY_CGROUP_ROOT:-}" ] || allrice_memory_fail
allrice_memory_child_created=0
allrice_memory_child="$ALLRICE_MEMORY_COMMANDS_GROUP/command-$$"
# exec bash keeps the PID and sources BASH_ENV again. Verify this exact managed
# process before reusing its group; never mkdir -p or reset its first baseline.
allrice_memory_stat=$(cat "$ALLRICE_MEMORY_PROC_ROOT/$$/stat") || allrice_memory_fail
IFS=' ' read -r -a allrice_memory_fields <<< "${allrice_memory_stat##*) }"
allrice_memory_start=${allrice_memory_fields[19]:-}
case "$allrice_memory_start" in ''|*[!0-9]*) allrice_memory_fail;; esac
if [ "${ALLRICE_MEMORY_MANAGED_PID:-}" = "$$" ]; then
  [ "${ALLRICE_MEMORY_MANAGED_START:-}" = "$allrice_memory_start" ] || allrice_memory_fail
  [ "${ALLRICE_MEMORY_MANAGED_CHILD:-}" = "$allrice_memory_child" ] || allrice_memory_fail
  allrice_memory_relative=${allrice_memory_child#"$ALLRICE_MEMORY_CGROUP_ROOT"}
  [ "$allrice_memory_relative" != "$allrice_memory_child" ] || allrice_memory_fail
  allrice_memory_current=$(awk -F: '$1=="0" && $2=="" {print $3}' "$ALLRICE_MEMORY_PROC_ROOT/$$/cgroup") || allrice_memory_fail
  [ "$allrice_memory_current" = "$allrice_memory_relative" ] || allrice_memory_fail
  [ "$(cat "$allrice_memory_child/memory.high")" = "${ALLRICE_MEMORY_COMMAND_HIGH:?}" ] || allrice_memory_fail
  [ "$(cat "$allrice_memory_child/memory.max")" = "${ALLRICE_MEMORY_COMMAND_MAX:?}" ] || allrice_memory_fail
  [ "$(cat "$allrice_memory_child/memory.swap.max")" = "${ALLRICE_MEMORY_COMMAND_SWAP_MAX:?}" ] || allrice_memory_fail
  [ "$(cat "$allrice_memory_child/memory.oom.group")" = 0 ] || allrice_memory_fail
  allrice_memory_oom_before=${ALLRICE_MEMORY_OOM_BASELINE:-}
  allrice_memory_local_before=${ALLRICE_MEMORY_LOCAL_BASELINE:-}
else
  mkdir "$allrice_memory_child" || allrice_memory_fail
  allrice_memory_child_created=1
  printf '%s\n' "${ALLRICE_MEMORY_COMMAND_HIGH:?}" > "$allrice_memory_child/memory.high" || allrice_memory_fail
  printf '%s\n' "${ALLRICE_MEMORY_COMMAND_MAX:?}" > "$allrice_memory_child/memory.max" || allrice_memory_fail
  printf '%s\n' "${ALLRICE_MEMORY_COMMAND_SWAP_MAX:?}" > "$allrice_memory_child/memory.swap.max" || allrice_memory_fail
  printf '%s\n' 0 > "$allrice_memory_child/memory.oom.group" || allrice_memory_fail
  allrice_memory_oom_before=$(awk '$1=="oom_kill" {print $2}' "$allrice_memory_child/memory.events.local") || allrice_memory_fail
  allrice_memory_local_before=$(awk '$1=="oom" {print $2}' "$allrice_memory_child/memory.events.local") || allrice_memory_fail
fi
case "$allrice_memory_oom_before" in ''|*[!0-9]*) allrice_memory_fail;; esac
case "$allrice_memory_local_before" in ''|*[!0-9]*) allrice_memory_fail;; esac
allrice_memory_exit() {
  allrice_memory_status=$?
  trap - EXIT
  allrice_memory_oom_after=$(awk '$1=="oom_kill" {print $2}' "$allrice_memory_child/memory.events.local" 2>/dev/null)
  allrice_memory_local_after=$(awk '$1=="oom" {print $2}' "$allrice_memory_child/memory.events.local" 2>/dev/null)
  if [ "${allrice_memory_oom_after:-0}" -gt "$allrice_memory_oom_before" ]; then
    if [ "${allrice_memory_local_after:-0}" -gt "$allrice_memory_local_before" ]; then
      printf 'COMMAND_MEMORY_LIMIT: 该命令内存/交换额度不足，请分批处理，会话保留\n' >&2
    else
      printf 'COMMAND_OOM_KILLED: 该命令被内存回收终止，原因需核实，会话保留\n' >&2
    fi
    allrice_memory_status=137
  fi
  # Leave the child before rmdir. Surviving descendants keep their memcg;
  # never kill/replay a command merely to make cleanup look successful.
  printf '%s\n' "$$" > "$ALLRICE_MEMORY_DSH_GROUP/cgroup.procs" 2>/dev/null || true
  rmdir "$allrice_memory_child" 2>/dev/null || true
  exit "$allrice_memory_status"
}
trap allrice_memory_exit EXIT
printf '%s\n' "$$" > "$allrice_memory_child/cgroup.procs" || allrice_memory_fail
printf '%s\n' "${ALLRICE_MEMORY_COMMAND_OOM_SCORE:?}" > "$ALLRICE_MEMORY_PROC_ROOT/$$/oom_score_adj" || allrice_memory_fail
export ALLRICE_MEMORY_MANAGED_PID="$$"
export ALLRICE_MEMORY_MANAGED_START="$allrice_memory_start"
export ALLRICE_MEMORY_MANAGED_CHILD="$allrice_memory_child"
export ALLRICE_MEMORY_OOM_BASELINE="$allrice_memory_oom_before"
export ALLRICE_MEMORY_LOCAL_BASELINE="$allrice_memory_local_before"
