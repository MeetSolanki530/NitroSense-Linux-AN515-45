# NitroSense for Linux

NitroSense on Windows does fan control, power modes and keyboard lighting.
On Linux you get none of it. This brings it back.

![NitroSense running on Linux](screenshots/01-home.png)

> ⚠️ **Built and tested on the Acer Nitro AN515-45 only.**
> Other Nitro models may work but nothing here is tested on them.

## 💻 Tested on

| | |
|---|---|
| Laptop | Acer Nitro AN515-45 |
| BIOS | V1.14 |
| CPU | AMD Ryzen 7 5800H (Radeon integrated) |
| GPU | NVIDIA RTX 3050 Ti (hybrid, display runs off the AMD side) |
| Kernel | 7.0.0-31-generic |
| OS | Zorin OS |
| Desktop | GNOME on Wayland |
| Kernel driver | linuwu_sense 25.701, patched |

### Will it work on mine?

Check your model first:

```bash
cat /sys/class/dmi/id/product_name
```

- **Nitro AN515-45** 👉 should work exactly as described
- **Another AN515** 👉 likely works, the keyboard lighting may need a quirk
  entry adding (see `patches/`)
- **Predator or other Acer** 👉 untested, no idea

Two things decide whether the keyboard lighting works on a given model: the
driver needs a DMI entry for it, and the Fn key has to report a keycode the
desktop can see. Both are covered in `patches/` for the AN515-45.

### Needs

- a GNOME based desktop for the NitroSense key shortcut (the rest works
  anywhere)
- kernel headers, gcc and make, to build the driver at install time
- Secure Boot off, or the module signed yourself, since it is out of tree

![app icon](app/build/icons/128x128.png)

## ✨ What works

| Feature | Status |
|---|---|
| 🌀 Fan control (auto and manual) | works |
| ⚡ Power modes (Quiet / Balanced / Performance) | works |
| 🔋 Battery limit at 80% | works |
| 🔌 USB charging while the lid is shut | works |
| ⌨️ Keyboard RGB, per zone and 6 effects | works |
| 💾 Lighting comes back after a reboot | works |
| 🌡️ Live temps, fan RPM, CPU and GPU usage | works |
| 🎹 NitroSense key opens the app | works |

## 🚫 What does not work on this model

These were tested properly and they are firmware limits, not bugs in the app.
The app shows them as unavailable instead of pretending.

- **Thermal profiles** through ACPI. The firmware accepts the write and ignores
  it. Power modes use the CPU governor instead, which does work.
- **LCD override.** Writes report success, the value never changes.
- **Boot animation and sound.** The firmware refuses both reading and writing.
- **Reading the Fn brightness level.** Fn+F9 and Fn+F10 work, they are handled
  in the embedded controller. But the controller does not tell the firmware,
  and the firmware is all the driver can read, so the number in the app is the
  level it last set rather than what is lit. Setting brightness from the app
  still works.

## 📸 Screenshots

All taken on the AN515-45 with the daemon connected.

**Performance.** Power mode and fan control. Manual holds a fixed duty cycle,
automatic hands the fans back to the firmware.

![Performance tab](screenshots/02-performance.png)

**Battery.** Charge limiter, calibration and USB charging while the lid is shut.

![Battery tab](screenshots/03-battery.png)

**Keyboard.** Per zone colour across the four zones, with a preview and a
brightness slider.

![Keyboard tab](screenshots/04-keyboard.png)

**Keyboard effects.** Six effects with speed and direction. Direction only
applies to Wave and Shifting.

![Keyboard effects](screenshots/05-keyboard-effects.png)

**Monitoring.** Temperature and utilisation over time, plus every sensor the
machine exposes.

![Monitoring tab](screenshots/06-monitoring.png)

**Internals.** Driver status, which features the firmware actually offers, and
the modprobe parameter controls. Useful when something is not behaving.

![Internals tab](screenshots/07-internals.png)

**Splash.** What you see after pressing the NitroSense key, while it connects.

![Splash screen](screenshots/08-splash.png)

## 📦 Install

Grab the `.deb` from [Releases](../../releases) and install it:

```bash
sudo apt install ./nitrosense_*_amd64.deb
```

That is all. The installer builds the kernel driver for your kernel, sets the
background service to start at boot, and adds the app to your menu.

You need kernel headers, gcc and make. On Ubuntu based systems:

```bash
sudo apt install linux-headers-$(uname -r) build-essential
```

### First launch

1. Open **NitroSense** from your app menu
2. It asks if you want your NitroSense key to open the app
3. Press the key once, it remembers, done
4. It never asks again

### Uninstall

```bash
sudo apt remove nitrosense
```

This puts the stock `acer_wmi` driver back so your hotkeys keep working.

## 🔨 Build it yourself

```bash
cd app
npm install
npm run package
```

The `.deb` lands in `app/release/`.

To run from source without installing:

```bash
cd app
./scripts/start-all.sh
```

One command, brings up the driver, the service and the app together. Nothing
persists, a reboot clears it. Good for testing.

Full build, test, release and cleanup steps are in [BUILDING.md](BUILDING.md).

## 🐛 Something broken?

Logs live here:

```bash
journalctl -u nitrosense-daemon -n 50     # background service
cat app/logs/launch.log                   # when the key does nothing
```

Check the driver loaded and found your keyboard:

```bash
ls /sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/
```

You should see `nitro_sense` and `four_zoned_kb` in there.

## 🔧 About the keyboard lighting

RGB did not work at first. The driver was sending an 8 byte payload where this
firmware wants 4, so every write came back successful and did nothing at all.
Fixed in `patches/`, along with a model entry so the lighting shows up without
forcing flags that break the Fn keys.

Six effects, which is all the firmware actually has: static, breathing, neon,
wave, shifting, zoom.

## 📄 Licence

The app and the packaging are MIT. See `LICENSE`.

Two pieces it builds on keep their own licences, because they are not mine to
relicense:

- the `linuwu_sense` kernel driver, GPL-2.0, patched for this model
  (see `patches/` for what changed)
- the Python hardware service, GPL-3.0
