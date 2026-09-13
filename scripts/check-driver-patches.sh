#!/bin/bash
#
# Refuse to package a driver that has not been patched.
#
# Linuwu-Sense/ is a third-party clone and is gitignored, so nothing in git
# records whether the patches in patches/ have been applied to it. The .deb
# copies that directory verbatim, which means a fresh re-clone followed by a
# build would ship an unpatched driver and look completely normal doing it:
# it compiles, it loads, and then the keyboard stays dark and the backlight
# timeout reads as unknown on every machine that installs it.
#
# So check for a marker from each patch before packaging, and stop if one is
# missing. Cheap here, very expensive to discover after a release.
#
set -u

SRC="$(dirname "$0")/../Linuwu-Sense/src/linuwu_sense.c"

if [ ! -f "$SRC" ]; then
  echo "error: driver source not found at $SRC" >&2
  echo "       clone it, then apply the patches in patches/" >&2
  exit 1
fi

fail=0

# marker <description> <patch file> <string that only exists once patched>
marker() {
  if ! grep -q "$3" "$SRC"; then
    echo "error: $1 is missing from the driver source" >&2
    echo "       apply:  patch -p1 -d Linuwu-Sense < patches/$2" >&2
    fail=1
  fi
}

marker "the AN515-45 RGB fix" \
       "linuwu-sense-an515-45-rgb.patch" \
       "enable_four_zone_kb"

marker "the AN515-45 DMI quirk" \
       "linuwu-sense-an515-45-rgb.patch" \
       "Nitro AN515-45"

marker "the misc-setting status decode" \
       "linuwu-sense-misc-setting-status.patch" \
       "boot_animation_sound get refused"

marker "the backlight timeout decode" \
       "linuwu-sense-backlight-timeout-decode.patch" \
       "ACER_BACKLIGHT_TIMEOUT_SECONDS_MASK"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Packaging stopped. The driver in the package would not work on the" >&2
  echo "hardware this app is for." >&2
  exit 1
fi

echo "driver patches: all present"
exit 0
