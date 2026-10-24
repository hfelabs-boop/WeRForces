#!/usr/bin/env bash
# Builds, with plain javac:
#   hla/build/werforces-hla-bridge.jar   the bridge, compiled against the standard IEEE
#                                        1516e API jar only, so it runs on any 1516e Java RTI;
#   hla/build/ieee-1516e-java9.jar       OHLA's IEEE 1516e API factories rebuilt to find
#                                        RTIs with java.util.ServiceLoader (the shipped jar
#                                        uses javax.imageio.spi.ServiceRegistry, which Java 9+
#                                        restricts to ImageIO classes);
#   hla/build/ohla-rti-port.jar          OHLA's RTI server with a configurable port (stock
#                                        OHLA always listens on 15000).
# The two patches are compiled from OHLA's own sources in hla/vendor.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

rm -rf "$HLA_BUILD/classes" "$HLA_BUILD/patches"
mkdir -p "$HLA_BUILD/classes" "$HLA_BUILD/patches/api" "$HLA_BUILD/patches/rti"

mapfile -t SOURCES < <(find "$HLA_DIR/src" -name '*.java' | sort)
javac --release 17 -Xlint:-options -cp "$HLA_API_CP" -d "$HLA_BUILD/classes" "${SOURCES[@]}"
jar --create --file "$HLA_BUILD/werforces-hla-bridge.jar" --main-class org.werforces.hla.Main -C "$HLA_BUILD/classes" .
echo "built $HLA_BUILD/werforces-hla-bridge.jar"

patch_source() { # <source> <output> <marker> <sed args...>
  local src="$1" out="$2" marker="$3"
  shift 3
  sed "$@" "$src" > "$out"
  if ! grep -q "$marker" "$out"; then
    echo "could not patch $src (unexpected OHLA version?)" >&2
    exit 1
  fi
}

API_SRC="$OHLA_HOME/ieee-1516e/src/java/hla/rti1516e"
for f in RtiFactoryFactory LogicalTimeFactoryFactory; do
  patch_source "$API_SRC/$f.java" "$HLA_BUILD/patches/$f.java" 'ServiceLoader.load' \
    -e 's|import javax.imageio.spi.ServiceRegistry;|import java.util.ServiceLoader;|' \
    -e 's|ServiceRegistry.lookupProviders(\([A-Za-z]*\)\.class)|ServiceLoader.load(\1.class).iterator()|g'
done
javac --release 17 -nowarn -cp "$HLA_API_CP" -d "$HLA_BUILD/patches/api" "$HLA_BUILD/patches/RtiFactoryFactory.java" "$HLA_BUILD/patches/LogicalTimeFactoryFactory.java"
jar --create --file "$HLA_BUILD/ieee-1516e-java9.jar" -C "$HLA_BUILD/patches/api" .
echo "built $HLA_BUILD/ieee-1516e-java9.jar"

patch_source "$OHLA_HOME/rti/src/java/net/sf/ohla/rti/RTI.java" "$HLA_BUILD/patches/RTI.java" 'ohla.rti.port' \
  -e 's|new InetSocketAddress(DEFAULT_PORT)|new InetSocketAddress(Integer.getInteger("ohla.rti.port", DEFAULT_PORT))|' \
  -e 's|Paths.get("c:\\\\Temp")|Paths.get(System.getProperty("java.io.tmpdir"))|'
javac --release 17 -nowarn -cp "$(ohla_runtime_cp)" -d "$HLA_BUILD/patches/rti" "$HLA_BUILD/patches/RTI.java"
jar --create --file "$HLA_BUILD/ohla-rti-port.jar" -C "$HLA_BUILD/patches/rti" .
echo "built $HLA_BUILD/ohla-rti-port.jar"
