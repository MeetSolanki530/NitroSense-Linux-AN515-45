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

## linuwu-sense-misc-setting-status.patch

Decodes misc-setting replies instead of comparing them to magic constants.

`boot_animation_sound` read its reply as `result == 0x100 ? 1 : result == 0 ? 0
: -1`. But the reply is a packed struct, not a scalar:

```c
STATUS_MASK = GENMASK_ULL(7, 0)    /* low byte  */
VALUE_MASK  = GENMASK_ULL(15, 8)   /* next byte */
```

So `0x100` is just "status 0, value 1", and a raw `1` is "status 1, value 0" —
the firmware *refusing the query*. Comparing against constants makes a refusal
indistinguishable from a value, and on hardware that refuses this setting it
displayed as **enabled**.

The write path had the matching bug: it checked only `ACPI_FAILURE` and ignored
the status byte, so a refused write still returned success. The toggle moved,
nothing changed, and nothing said so.

On AN515-45 both calls return status 1 and a write leaves the stored value
unchanged, so the setting is genuinely unsupported there — but this patch is
not model-specific: it is how the reply is defined for every model.

### Applying

```bash
cd Linuwu-Sense
patch -p1 < ../patches/linuwu-sense-an515-45-rgb.patch
patch -p1 < ../patches/linuwu-sense-misc-setting-status.patch
```

They touch different functions and apply cleanly in either order.

Then load it non-persistently:

```bash
sudo ./damx-electron/scripts/try-driver.sh
```

### Upstreaming

This is a real fix for a real model and belongs upstream rather than living
here. The same payload shape presumably affects every AN515-4x/5x with this
firmware, not just this one machine.
