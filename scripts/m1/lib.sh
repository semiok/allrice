# Shared helpers for the M1 tools (sourced, not run). Absolute paths throughout: launchd
# jobs and agents run these tools with minimal PATHs (/usr/sbin is often missing).
M1_LAUNCHCTL=/bin/launchctl
M1_PY=/usr/bin/python3
M1_UID=$(/usr/bin/id -u)

# A refused recovery parks the plists outside LaunchAgents so login cannot start
# incompatible code. Keep their environment available for recovery and forward fixes.
dev_plist() { # web|worker -> active plist, or the parked configuration
  local p="$HOME/Library/LaunchAgents/ai.bplabs.allrice-dev-$1.plist"
  [ -f "$p" ] || p="$HOME/allrice-dev/qa/deploy-disabled/$1.plist"
  printf '%s\n' "$p"
}

# flock_fd <fd> [seconds]: take an exclusive kernel lock on the file open at <fd>, waiting
# up to [seconds] (default 0). Exit 0 = held, 1 = still busy. The lock belongs to the open
# file, so every child that inherits <fd> keeps it: it is released only when the last of
# them exits, never while a killed parent's child is still working.
flock_fd() {
  "$M1_PY" -c 'import fcntl,sys,time
fd,end=int(sys.argv[1]),time.time()+float(sys.argv[2])
while True:
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); sys.exit(0)
    except BlockingIOError:
        if time.time()>=end: sys.exit(1)
        time.sleep(0.5)' "$1" "${2:-0}"
}

# lock_held <file>: exit 0 when someone holds the lock on <file>, 1 when it is free.
lock_held() {
  "$M1_PY" -c 'import fcntl,sys
f=open(sys.argv[1],"a")
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
sys.exit(1)' "$1"
}

# job_state <label>: prints "running <pid>", "loaded" or "gone". Exit 2 when launchctl
# itself fails, so a failed query is never mistaken for a stopped service.
job_state() {
  local out rc=0
  out=$("$M1_LAUNCHCTL" print "gui/$M1_UID/$1" 2>&1) || rc=$?
  if [ "$rc" = 113 ]; then echo gone; return 0; fi # "Could not find service"
  [ "$rc" = 0 ] || { echo "launchctl print $1 failed (exit $rc)" >&2; return 2; }
  local pid; pid=$(printf '%s\n' "$out" | /usr/bin/awk '$1=="pid" && $2=="=" {print $3; exit}')
  if [ -n "$pid" ]; then echo "running $pid"; else echo loaded; fi
}

# port_open <port>: exit 0 when something accepts connections on 127.0.0.1:<port>.
port_open() {
  "$M1_PY" -c 'import socket,sys
try: socket.create_connection(("127.0.0.1",int(sys.argv[1])),0.5).close()
except OSError: sys.exit(1)' "$1"
}

# stop_job <label> [port]: boot the job out and wait (max 90s) until launchd no longer
# knows it, its last process has exited and the port is closed. launchd kills the job's
# whole process group when the job ends (AbandonProcessGroup is not set), so children go
# with it. Exit 1 on timeout or when the state cannot be read.
stop_job() {
  local label=$1 port=${2:-} state pid="" i
  state=$(job_state "$label") || return 1
  case "$state" in running*) pid=${state#running } ;; esac
  "$M1_LAUNCHCTL" bootout "gui/$M1_UID/$label" 2>/dev/null || true
  for i in $(seq 1 90); do
    state=$(job_state "$label") || return 1
    if [ "$state" = gone ] && { [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; } && { [ -z "$port" ] || ! port_open "$port"; }; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not stop within 90s (state: $state${pid:+, pid $pid})" >&2
  return 1
}

# migration_diff <release>: compare the migration names on stdin (what a database has
# applied) with the names <release> knows: its migrations/*.sql plus the archived names
# its built dist/migration-compatibility.js exports (as its db:verify does). Only that file is
# imported; dist/migrate.js would run the migrations as soon as it loads. Prints
# "unknown <name>" for each applied name the release does not know (its db:verify refuses
# such a database) and "pending <name>" for each file not applied yet (its db:prepare
# runs it). Exit 1, printing the reason, when the release's names cannot be read.
migration_diff() {
  local db="$1/packages/database" files archived applied
  files=$(ls "$db/migrations" 2>/dev/null | grep '\.sql$' | LC_ALL=C sort) || { echo "no migrations in $db/migrations"; return 1; }
  archived=$(node --input-type=module -e 'import { pathToFileURL } from "node:url";
const names = (await import(pathToFileURL(process.argv[1]).href)).archivedMigrationNames;
if (!Array.isArray(names) || !names.every((n) => /^[\w.-]+\.sql$/.test(n))) throw Error("no archivedMigrationNames list");
for (const n of names) console.log(n);' "$db/dist/migration-compatibility.js" 2>/dev/null) \
    || { echo "cannot read archivedMigrationNames from $db/dist/migration-compatibility.js"; return 1; }
  applied=$(LC_ALL=C sort -u)
  LC_ALL=C comm -23 <(printf '%s\n' "$applied") <(printf '%s\n%s\n' "$files" "$archived" | LC_ALL=C sort -u) | sed '/^$/d; s/^/unknown /'
  LC_ALL=C comm -13 <(printf '%s\n' "$applied") <(printf '%s\n' "$files") | sed '/^$/d; s/^/pending /'
}

# start_job <label> <plist>: load and start the job (bootstrap can briefly fail while a
# previous instance is still being torn down).
start_job() {
  local i
  for i in 1 2 3 4 5; do
    if "$M1_LAUNCHCTL" bootstrap "gui/$M1_UID" "$2" 2>/dev/null; then "$M1_LAUNCHCTL" kickstart "gui/$M1_UID/$1"; return 0; fi
    sleep 3
  done
  echo "could not load $1" >&2
  return 1
}
