# NitroSense for Linux

NitroSense on Windows does fan control, power modes and keyboard lighting.
On Linux you get none of it. This brings it back.

> ⚠️ **Built and tested on the Acer Nitro AN515-45 only.**
> Ryzen 7 5800H, RTX 3050 Ti, Zorin OS (GNOME), kernel 7.0.
> Other Nitro models may work but nothing here is tested on them.

![app icon](app/build/icons/128x128.png)

## ✨ What works

| Feature | Status |
|---|---|
| 🌀 Fan control (auto and manual) | works |
| ⚡ Power modes (Quiet / Balanced / Performance) | works |
| 🔋 Battery limit at 80% | works |
| 🔌 USB charging while the lid is shut | works |
| ⌨️ Keyboard RGB, per zone and 6 effects | works |
| 🌡️ Live temps, fan RPM, CPU and GPU usage | works |
| 🎹 NitroSense key opens the app | works |

## 🚫 What does not work on this model

These were tested properly and they are firmware limits, not bugs in the app.
The app shows them as unavailable instead of pretending.

- **Thermal profiles** through ACPI. The firmware accepts the write and ignores
  it. Power modes use the CPU governor instead, which does work.
- **LCD override.** Writes report success, the value never changes.
- **Boot animation and sound.** The firmware refuses both reading and writing.

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

## 📄 Third party components

This ships two GPL licensed pieces that are not mine, kept under their own
licence:

- **Linuwu-Sense**, the kernel driver, patched for this model. See `patches/`
  for exactly what changed and why.
- The Python hardware service, used unmodified.

Everything else, the app and the packaging, is mine. GPL-3.0, same as the parts
it builds on.
