#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HELPER="$ROOT/android/tiny-snapshot-helper-v2"
OUT="$ROOT/android/tiny-snapshot-helper-v2-build"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"
export PATH

if [ ! -x "$JAVA_HOME/bin/javac" ]; then
  echo "javac not found at $JAVA_HOME/bin/javac; set JAVA_HOME to an Android-compatible JDK." >&2
  exit 1
fi
if [ ! -d "$SDK" ]; then
  echo "Android SDK not found at $SDK; set ANDROID_HOME or ANDROID_SDK_ROOT." >&2
  exit 1
fi
if [ ! -d "$SDK/build-tools" ]; then
  echo "Android SDK build-tools not found under $SDK/build-tools; install Android build-tools." >&2
  exit 1
fi

BUILD_TOOLS="$(find "$SDK/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -n 1)"
if [ -z "$BUILD_TOOLS" ]; then
  echo "No Android build-tools versions found under $SDK/build-tools." >&2
  exit 1
fi

ANDROID_PLATFORM="${ANDROID_PLATFORM:-android-36}"
ANDROID_JAR="$SDK/platforms/$ANDROID_PLATFORM/android.jar"
if [ ! -f "$ANDROID_JAR" ]; then
  echo "Android platform jar not found at $ANDROID_JAR; install $ANDROID_PLATFORM or set ANDROID_PLATFORM." >&2
  exit 1
fi

KEYSTORE="${TINY_DEBUG_KEYSTORE:-$ROOT/android/tiny-debug.keystore}"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname -- "$KEYSTORE")"
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

"$JAVA_HOME/bin/javac" --release 11 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find "$HELPER/src/main/java" -name '*.java' | sort)

"$BUILD_TOOLS/d8" --min-api 23 --classpath "$ANDROID_JAR" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class' | sort)

"$BUILD_TOOLS/aapt2" link \
  --manifest "$HELPER/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  --min-sdk-version 23 \
  --target-sdk-version 36 \
  --version-code 1 \
  --version-name 0.2.0 \
  -o "$OUT/tiny-v2-unsigned.apk"

zip -q -j "$OUT/tiny-v2-unsigned.apk" "$OUT/dex/classes.dex"
"$BUILD_TOOLS/zipalign" -f 4 "$OUT/tiny-v2-unsigned.apk" "$OUT/tiny-v2-aligned.apk"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$OUT/tiny-snapshot-helper-v2.apk" \
  "$OUT/tiny-v2-aligned.apk"
"$BUILD_TOOLS/apksigner" verify --min-sdk-version 23 "$OUT/tiny-snapshot-helper-v2.apk"

# Sync the bundled/shipped helper. This is the APK the CLI installs on-device
# (`assets/tiny-snapshot-helper.apk`, packed via package.json#files); keeping it
# in step here prevents the build artifact and the shipped asset from drifting.
BUNDLED="$ROOT/assets/tiny-snapshot-helper.apk"
mkdir -p "$(dirname -- "$BUNDLED")"
cp "$OUT/tiny-snapshot-helper-v2.apk" "$BUNDLED"

printf '%s\n' "$OUT/tiny-snapshot-helper-v2.apk"
printf 'bundled: %s\n' "$BUNDLED"
