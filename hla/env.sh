# Sourced by the hla/*.sh scripts: locates OHLA and builds the Java classpaths.
HLA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OHLA_HOME="${OHLA_HOME:-$HLA_DIR/vendor/ohla-0.6.1}"
HLA_BUILD="$HLA_DIR/build"

if [[ ! -f "$OHLA_HOME/ohla-rti.jar" ]]; then
  echo "OHLA not found in $OHLA_HOME; run hla/fetch-ohla.sh first (or set OHLA_HOME)" >&2
  exit 1
fi

# The standard IEEE 1516e API; the only thing the bridge is compiled against.
HLA_API_CP="$OHLA_HOME/ieee-1516e.jar"

# The OHLA runtime: RTI implementation plus its third-party libraries, preceded by
# the Java 9+ fix for the API's RTI factory lookup when build.sh has made it.
ohla_runtime_cp() {
  local cp="$OHLA_HOME/ohla-rti.jar:$OHLA_HOME/ieee-1516e.jar:$OHLA_HOME/ieee-1516.jar:$OHLA_HOME/hla-1.3.jar"
  [[ -f "$HLA_BUILD/ieee-1516e-java9.jar" ]] && cp="$HLA_BUILD/ieee-1516e-java9.jar:$cp"
  local jar
  for jar in "$OHLA_HOME"/thirdparty/{netty,protobuf,guava,slf4j,logback,cal10n}/lib/*.jar; do
    case "$jar" in *-sources.jar) continue ;; esac
    cp="$cp:$jar"
  done
  echo "$cp"
}
