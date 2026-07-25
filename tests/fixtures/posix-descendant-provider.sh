#!/bin/sh
# Test-only provider fixture. It is executed directly by spawn(..., { shell: false })
# after the test copies it to an executable sandbox path.
set -eu

record_descendant() {
  printf '{"providerPid":%s,"descendantPid":%s}\n' "$$" "$1" > "${MIFTAH_FAKE_RECORD_PATH:?}"
}

keep_streams_open() {
  fifo="${MIFTAH_FAKE_RECORD_PATH:?}.fifo"
  mkfifo "$fifo"
  exec 3<>"$fifo"
  rm -f "$fifo"
  IFS= read -r _ <&3
}

case "${MIFTAH_FAKE_MODE:-}" in
  descendant)
    keep_streams_open &
    descendant_pid=$!
    record_descendant "$descendant_pid"
    wait "$descendant_pid"
    ;;
  early-exit-descendant)
    keep_streams_open &
    record_descendant "$!"
    exit 0
    ;;
  early-exit-stubborn-descendant)
    (
      ready_path="${MIFTAH_FAKE_DESCENDANT_READY_PATH:?}"
      signal_path="${MIFTAH_FAKE_DESCENDANT_SIGNAL_PATH:?}"
      trap 'printf "SIGTERM" > "$signal_path"' TERM
      printf 'ready' > "$ready_path"
      keep_streams_open
    ) &
    record_descendant "$!"
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
