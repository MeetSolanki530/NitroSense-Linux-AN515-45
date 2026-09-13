# Static lighting on AN515-45: solved

**The answer: the panel has to be switched on first.**

Two WMI calls at driver load, which Linuwu-Sense never made and facer does:

```c
WMI_gaming_execute_u64(ACER_WMID_GET_GAMING_SYS_INFO_METHODID, 0, &sysinfo);
WMI_gaming_execute_u64(ACER_WMID_SET_GAMING_LED_METHODID, 8ULL | (15ULL << 40), NULL);
```

Byte 0 is `ACER_GAMING_KBL_SET_ON`, `BIT(3)` in the mainline acer-wmi RFC.
Bits 40 to 43 are the zone mask, its `ACER_GAMING_KBL_SET_ALL_ZONES`. Both
halves matter: the 15 in byte 1 rather than byte 5 is accepted and does
nothing, which is how it was missed while probing.

Without these, every colour write succeeds at every layer, the colours land
correctly in the EC's `KB1R..KB4B` registers, `dmesg` is silent, and the
keyboard stays dark. Nothing about the payload is wrong; the panel was never
enabled.

Confirmed on AN515-45: static green, and four independent zone colours.

The rest of this file is what was ruled out on the way, kept so the same
ground is not covered twice. Note that almost all of it was testing payload
variations against a panel that was switched off, so a negative result there
means less than it appears.

---

## Original notes

## The hardware supports it

Acer's own NitroSense installer, `Plugs/Nitro AN515-45/HW_Support.ini`:

```ini
[LightingType]
Type:1
PerKey=0
[ZoneDefaultColor]
Zone1=#FF0000  Zone2=#FF0000  Zone3=#FF0000  Zone4=#FF0000
```

All 28 Nitro models in that package declare the same thing, including the
AN515-58 that mainline acer-wmi supports. So this is not a model limitation.

## Ruled out

Everything below was tested on real hardware, from a clean state: daemon
stopped, `/etc/four_zone_kb_state` and `/var/lib/nitrosense/lighting.json`
removed, module reloaded. Keyboard stayed dark in all of them.

| Tried | Result |
|---|---|
| byte 3 = 8 (`ACER_GAMING_KBL_SET_ON`) on every mode | dark |
| byte 8 = 0, 1, 2, 3, 4, 8 | dark |
| byte 9 = 0, 1, 2, 3 | dark |
| zone ids `1,2,3,4` instead of the `1,2,4,8` bitmask | dark |
| colours before mode switch, and mode switch before colours | dark |
| a real colour in the mode switch instead of zeros | dark |
| speed and direction unnormalised for mode 0 | dark |
| module params: none (DMI quirk), `enable_all=1` | dark |
| `nitro_v4=1`, `predator_v4=1` | no four_zoned_kb at all |
| backlight timeout off | dark |
| clean boot, nothing written to the panel first | dark |
| unpatched upstream driver, per-zone and static | dark |

`dmesg` is silent throughout: the firmware accepts every one of these writes
and reports success.

## The one real signal

`SetGamingLEDBehavior` is WMI method 2 on `WMID_GUID4`. Acer's app calls it;
this driver never has. Probing it through the `wmi_raw` debug attribute:

```
2 0         -> reply 2      rejected
2 1         -> reply 1      rejected
2 2         -> reply 1      rejected
2 3         -> reply 1      rejected
2 1 15      -> reply 1      rejected
2 1 1 2 4 8 -> reply 1      rejected
2 8         -> reply 0      ACCEPTED
2 8 1       -> reply 0      ACCEPTED
```

Only `8` is accepted, which is `BIT(3)`, matching `ACER_GAMING_KBL_SET_ON` in
the mainline acer-wmi RFC. This is the only call all session that
discriminates between payloads rather than accepting everything.

Calling it before a colour write does not light the keyboard. Calling it after
does not either, so it is not a commit flag on its own.

## What Acer's app calls

From `strings` on `NitroSense.exe` and `TsDotNetLib.dll`:

- `WMISetGamingKBBacklight`  — this driver uses it
- `WMISetGamingRgbKbSetting` — this driver uses it
- `WMISetGamingLEDBehavior`  — this driver does NOT use it
- `WMISetGamingMiscSetting`  — used elsewhere in this driver

## Next

Disassemble `TsDotNetLib.dll` and `NitroSense.exe` and read the actual payloads
rather than probing. The binaries are extracted under `ns-extract/`.

## References

- mainline acer-wmi 4-zone RFC: https://ratatoskr.run/platform-driver-x86/2026/05/3541436/t
- another AN515-45 owner, same symptom, different driver:
  https://github.com/JafarAkhondali/acer-predator-turbo-and-rgb-keyboard-linux-module/issues/63
