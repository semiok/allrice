#!/bin/sh

set -eu

PROGRAM='/Users/metasnowsky/Desktop/RiceBridge'
ACTION="${SSH_ORIGINAL_COMMAND:-${1:-status}}"

is_running() {
  /usr/bin/pgrep -f "^${PROGRAM}$" >/dev/null 2>&1
}

case "$ACTION" in
  status)
    if is_running; then
      printf 'running\n'
    else
      printf 'stopped\n'
    fi
    ;;
  start)
    if is_running; then
      printf 'already_running\n'
      exit 0
    fi
    if [ ! -x "$PROGRAM" ]; then
      printf 'program_unavailable\n' >&2
      exit 42
    fi
    /usr/bin/open "$PROGRAM"
    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if is_running; then
        printf 'started\n'
        exit 0
      fi
      attempt=$((attempt + 1))
      /bin/sleep 0.25
    done
    printf 'start_timeout\n' >&2
    exit 43
    ;;
  stop)
    if ! is_running; then
      printf 'already_stopped\n'
      exit 0
    fi
    /usr/bin/pkill -TERM -f "^${PROGRAM}$"
    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if ! is_running; then
        printf 'stopped\n'
        exit 0
      fi
      attempt=$((attempt + 1))
      /bin/sleep 0.25
    done
    printf 'stop_timeout\n' >&2
    exit 44
    ;;
  *)
    printf 'unsupported_action\n' >&2
    exit 64
    ;;
esac
