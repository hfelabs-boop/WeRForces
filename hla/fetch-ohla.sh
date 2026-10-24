#!/usr/bin/env bash
# Downloads OHLA 0.6.1 (an Apache-2.0 HLA RTI with the IEEE 1516e Java API) from
# SourceForge into hla/vendor/ and unpacks it. The jars are not committed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
VERSION="0.6.1"
URL="${OHLA_URL:-https://downloads.sourceforge.net/project/ohla/ohla/ohla-$VERSION.zip}"
SHA256="4b7d957eebe7fe19a6c0a81ccafa057661e71672e5b06fbd72a985d15ff7984d"
ZIP="$VENDOR/ohla-$VERSION.zip"

mkdir -p "$VENDOR"
if [[ -f "$VENDOR/ohla-$VERSION/ohla-rti.jar" ]]; then
  echo "OHLA $VERSION already in $VENDOR/ohla-$VERSION"
  exit 0
fi

if [[ ! -f "$ZIP" ]]; then
  echo "Downloading $URL"
  curl -fL --retry 3 --progress-bar -o "$ZIP.part" "$URL"
  mv "$ZIP.part" "$ZIP"
fi

actual="$(sha256sum "$ZIP" | cut -d' ' -f1)"
if [[ "$actual" != "$SHA256" ]]; then
  echo "Checksum mismatch for $ZIP: expected $SHA256, got $actual" >&2
  exit 1
fi

unzip -q -o "$ZIP" -d "$VENDOR"
echo "OHLA $VERSION unpacked to $VENDOR/ohla-$VERSION"
