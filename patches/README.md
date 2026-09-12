# Driver patches

`Linuwu-Sense/` is a third-party clone and is gitignored, so changes made to it
are not tracked. Anything that must survive a re-clone lives here as a patch.

## linuwu-sense-an515-45-rgb.patch

Makes keyboard RGB work on the Acer Nitro AN515-45. Against
[PXDiv/Div-Linuwu-Sense](https://github.com/PXDiv/Div-Linuwu-Sense).

Before this, every RGB write on this model was accepted by the firmware,
returned success, and did nothing at all — which is why the keyboard looked
like it had no addressable backlight. It does; the payloads were wrong.

Four changes, each found by diffing against
[facer](https://github.com/JafarAkhondali/acer-predator-turbo-and-rgb-keyboard-linux-module),
which lists AN515-45 as RGB-tested and drives the same WMI methods:

| | Div-Linuwu-Sense | facer / this patch |
|---|---|---|
| Per-zone colour payload | 8-byte `u64` | **4 bytes** `{zone, r, g, b}` |
| Mode-select byte 8 | `3` | **`0`** |
| Mode-select byte 3 | always `0` | **`8` for Wave** |
| Per-mode field zeroing | zeroes speed/colour/direction per mode | **passes through** (static excepted) |

The zeroing mattered as much as the payload size: a breathing effect forced to
speed 0 parks at the dark end of its cycle, and a neon effect forced to
rgb 0,0,0 is black — both indistinguishable from "the backlight does not work".

It also adds a DMI quirk entry for `Nitro AN515-45` (`nitro_v4` +
`four_zone_kb`). Without it the RGB node only appears under `enable_all`, which
additionally forces the predator quirks and changes how the Fn+F9/F10 backlight
keys are decoded.

Note that `find_quirks()` returns early when `nitro_v4=1` is passed as a module
parameter, *before* DMI matching runs — so the driver must be loaded with **no
parameters** for this entry to take effect. `scripts/try-driver.sh` does that by
default.

### Applying

```bash
cd Linuwu-Sense
patch -p1 < ../patches/linuwu-sense-an515-45-rgb.patch
```

Then load it non-persistently:

```bash
sudo ./damx-electron/scripts/try-driver.sh
```

### Upstreaming

This is a real fix for a real model and belongs upstream rather than living
here. The same payload shape presumably affects every AN515-4x/5x with this
firmware, not just this one machine.
