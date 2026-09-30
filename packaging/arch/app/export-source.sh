#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../../.." && pwd)
# Export tracked HEAD only; commit the review changes before building.
git -C "$root" archive --format=tar.gz --prefix=nitrosense/ HEAD > "$here/nitrosense-source.tar.gz"
cd "$here"
python - <<'PYCODE'
from pathlib import Path
import hashlib
names=['nitrosense-source.tar.gz','nitrosense-launcher','nitrosense.desktop','nitrosense-daemon.service','nitrosense.sysusers']
values='\n'.join("  '"+hashlib.sha256(Path(n).read_bytes()).hexdigest()+"'" for n in names)
p=Path('PKGBUILD');s=Path('PKGBUILD.in').read_text();a=s.index('sha256sums=(');b=s.index(')',a)
p.write_text(s[:a]+'sha256sums=(\n'+values+'\n'+s[b:])
PYCODE
