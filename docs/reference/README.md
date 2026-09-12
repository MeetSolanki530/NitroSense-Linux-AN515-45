# Reference checkouts

Other people's drivers, kept only for comparison. Nothing here is built,
shipped or loaded — they are reading material.

They earn their place: twice, reading a working implementation settled a
question that inference had got wrong.

## acer-turbo

[JafarAkhondali/acer-predator-turbo-and-rgb-keyboard-linux-module](https://github.com/JafarAkhondali/acer-predator-turbo-and-rgb-keyboard-linux-module)
(the `facer` module).

Its compatibility table lists **AN515-45 as RGB tested**, which contradicted the
conclusion that this machine had no working keyboard backlight. Diffing it
against Linuwu-Sense found the reason: both drive the same WMI method 6, but
with different payloads.

| | Linuwu-Sense | facer |
|---|---|---|
| Per-zone colour | 8-byte `u64` | **4 bytes** `{zone, r, g, b}` |
| Mode-select byte 8 | `3` | **`0`** |
| Per-mode field zeroing | zeroes speed/colour/direction | passes through |

The firmware accepted the 8-byte form, returned success, and did nothing —
indistinguishable from absent hardware. See `patches/` for the fix.

## Not checked in here

Two more were read during the same investigation and are easy to re-fetch:

- [0x7375646F/Linuwu-Sense](https://github.com/0x7375646F/Linuwu-Sense) —
  upstream of the driver this project patches. Its README states only PHN16-71
  is fully supported; AN515-45 has no DMI quirk entry in either it or the Div
  fork, which is why `patches/` adds one.
- [PXDiv/Div-Linuwu-Sense](https://github.com/PXDiv/Div-Linuwu-Sense) — the
  fork actually used, and the baseline the patches apply against.

## The other lesson

`../../scripts/nitro-key-detection.sh` — shipped with this very repo — already
had the NitroSense key figured out:

```bash
NITRO_KEY=425
DEVICE=$(grep ... "AT Translated Set 2 keyboard" ...)
evtest "$DEVICE" | grep "code $NITRO_KEY.*value 1"
```

The key is `KEY_PRESENTATION` (425) on the **AT keyboard**, not on the Acer WMI
hotkeys device. Hours went into testing the wrong device and reading `dmesg`,
which is blind to a recognised key — only unknown scancodes log anything.
Read the working implementation first.
