#!/usr/bin/env bash
set -euo pipefail
kernel=${1:?Pass the target kernel version}
build=/usr/lib/modules/$kernel/build
[[ -f $build/Makefile ]] || { echo "Missing headers for $kernel" >&2; exit 1; }
args=()
if grep -q '^CONFIG_CC_IS_CLANG=y' "$build/include/config/auto.conf"; then
  args+=(LLVM=1)
fi
# Direct Kbuild invocation avoids upstream sudo/sign/install targets.
exec make -C "$build" M="$PWD" "${args[@]}" modules
