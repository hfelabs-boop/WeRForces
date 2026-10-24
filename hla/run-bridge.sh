#!/usr/bin/env bash
# Runs the DIS/HLA bridge federate on the OHLA RTI libraries. Arguments are passed to
# the bridge (--help lists them). To use another IEEE 1516e RTI, set HLA_RTI_CLASSPATH
# to its jars (and their resources) instead.
set -euo pipefail
HLA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$HLA_DIR/build/werforces-hla-bridge.jar"
[[ -f "$JAR" ]] || { echo "$JAR missing; run hla/build.sh" >&2; exit 1; }

if [[ -n "${HLA_RTI_CLASSPATH:-}" ]]; then
  CP="$JAR:$HLA_RTI_CLASSPATH"
else
  source "$HLA_DIR/env.sh"
  # OHLA looks HLAstandardMIM.xml up on the classpath.
  CP="$JAR:$(ohla_runtime_cp):$OHLA_HOME/ieee-1516e/resources"
fi

exec java -cp "$CP" \
  -Dlogback.configurationFile="$HLA_DIR/logback.xml" \
  -Dohla.log.level="${OHLA_LOG_LEVEL:-WARN}" \
  org.werforces.hla.Main "$@"
