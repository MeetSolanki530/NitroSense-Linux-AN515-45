# Building and releasing

Notes to myself for next time. Everything here was done on Zorin OS with GNOME
on Wayland, on the Acer Nitro AN515-45.

## 🧰 One time setup

```bash
cd app
npm install
```

You also need these for the kernel driver to build at install time:

```bash
sudo apt install linux-headers-$(uname -r) build-essential
```

## ⚠️ Bump the version before rebuilding

`apt install` compares version strings and does nothing when they match, so a
rebuild at the same version installs silently as a no-op. You then test the old
binary and think the fix did not work. Bump `version` in `app/package.json`
first, or force it with:

```bash
sudo dpkg -i ./release/nitrosense_0.1.0_amd64.deb
```

## 🔨 Build

```bash
cd app
npm run build      # compiles electron + renderer, no packaging
npm run package    # the above, then makes the .deb
```

The package lands at `app/release/nitrosense_0.1.0_amd64.deb`, around 95 MB.

`npm run package` runs `electron-builder --linux dir deb`. The `dir` part
produces the unpacked tree in `app/release/linux-unpacked`, which is handy when
something is missing from the final package and you want to look inside.

## ✅ Before packaging

```bash
cd app
npm run typecheck
npm test           # 7 suites, all offline, no hardware needed
npm run test:e2e   # needs the daemon running, does real writes
```

## 🚀 Install and test

apt will not read a .deb out of your home folder because the `_apt` user cannot
get into it. Copy it to /tmp first and the warning goes away.

```bash
cp app/release/nitrosense_0.1.0_amd64.deb /tmp/
sudo apt install /tmp/nitrosense_0.1.0_amd64.deb
```

Check it came up properly:

```bash
dpkg -l nitrosense | tail -2                      # want ii
systemctl is-active nitrosense-daemon.service     # want active
lsmod | grep linuwu_sense                         # want a line
```

Uninstall:

```bash
sudo apt remove nitrosense
```

## 📤 Release

Tag and push:

```bash
git tag -a v0.1.0 -m "NitroSense for Linux v0.1.0"
git push origin v0.1.0
```

Then on GitHub, Releases, Draft a new release. Pick the tag that is already
there, attach the .deb, paste the notes, publish.

A git tag travels with `git push`. The release page and the attached .deb do
not, they live only in GitHub's database. So the binary always gets uploaded by
hand unless you install the gh CLI.

## 🔑 Resetting the NitroSense key, for testing first run

Two separate pieces of state, and you have to clear both or the app will not
prompt.

```bash
./app/scripts/setup-nitro-key.sh --uninstall   # the GNOME shortcut
rm -f ~/.config/nitrosense/nitro-key.json      # the app's saved decision
```

The config folder is `~/.config/nitrosense`, lowercase. Electron takes it from
the `name` field in package.json, not `productName`. That is why the install
path is `/opt/NitroSense` but the config is lowercase. I have deleted the wrong
folder more than once.

Check both are clear:

```bash
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
cat ~/.config/nitrosense/nitro-key.json
```

You want `@as []` and no such file. Then open the app, it should ask.

## 🌐 If git push hangs

Port 22 is blocked on a lot of networks. GitHub runs SSH on 443 as well.
`~/.ssh/config` already has this, mode 600 or ssh ignores it.

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
```

## 🧹 Clearing space

Safe to delete, all of it rebuilds or downloads again.

```bash
rm -rf app/release app/logs acer-turbo ref-dmm
rm -rf ~/.cache/electron
rm -rf ~/.var/app/com.visualstudio.code/cache/electron-builder
rm -rf app/node_modules    # costs you an npm install next time
```

`~/.cache/electron` is the big one at around 330 MB. electron-builder keeps a
full Electron runtime per version forever, so it grows every time the dependency
is bumped. Pure cache, nothing lives in there.

## 🩹 The driver patches

`Linuwu-Sense/` is gitignored because it is a third party checkout. The changes
live in `patches/` instead.

```bash
git clone https://github.com/0x7375646F/Linuwu-Sense Linuwu-Sense
cd Linuwu-Sense
git apply ../patches/linuwu-sense-an515-45-rgb.patch
git apply ../patches/linuwu-sense-misc-setting-status.patch
```

Both apply cleanly to a fresh checkout. If they stop applying after an upstream
change, that is the thing to fix before anything else, because the RGB will look
like it works and quietly do nothing.
