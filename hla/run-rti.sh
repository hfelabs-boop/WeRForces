#!/usr/bin/env bash
# Starts the OHLA central RTI process. Federates (such as the bridge) connect to it
# over TCP. Usage: hla/run-rti.sh [port]   (default 15000; OHLA_LOG_LEVEL=INFO for more output)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

PORT="${1:-15000}"
for jar in ieee-1516e-java9.jar ohla-rti-port.jar; do
  [[ -f "$HLA_BUILD/$jar" ]] || { echo "$HLA_BUILD/$jar missing; run hla/build.sh" >&2; exit 1; }
done

exec java -cp "$HLA_BUILD/ohla-rti-port.jar:$(ohla_runtime_cp)" \
  -Dlogback.configurationFile="$HLA_DIR/logback.xml" \
  -Dohla.log.level="${OHLA_LOG_LEVEL:-WARN}" \
  -Dohla.rti.port="$PORT" \
  net.sf.ohla.rti.RTI
