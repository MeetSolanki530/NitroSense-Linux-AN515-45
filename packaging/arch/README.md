# Arch / CachyOS source packaging (AN515-45)

These recipes package the existing upstream app and driver; they do not implement
new hardware protocols. Tested local integration: Nitro AN515-45, BIOS V1.11,
Ryzen 7 5800H / RTX 3050 Ti, CachyOS 7.2.8, KDE Plasma X11. The user reported fan,
battery and keyboard controls working. Reboot verification confirmed services,
auto fan mode, limiter enabled and unchanged lighting readback. Physical charge
cutoff at 80% and suspend/resume are not yet verified. LTS 6.18.52 compilation and
DKMS installation passed; no LTS runtime claim is made.

The generalized packaging in this PR is a new build of that integration. Do not
confuse local runtime evidence with validation of the new group-access package.

## Build

Install Arch base-devel, git, nodejs >=22.12 and npm. Driver compilation also
needs DKMS, headers for every target kernel and its compiler toolchain (CachyOS
main uses Clang/LLD; the tested LTS uses GCC). Build as an unprivileged user.

    cd packaging/arch/driver
    makepkg -s

The driver recipe pins Div-Linuwu-Sense, applies all three AN515-45 patches, and
adds the bounded-copy compatibility patch proposed separately to the fork.
Once that change lands, update the pin and drop the duplicate patch. The primary
0x7375646F repository is not the base of these RGB patches.

For the GUI/service, commit the desired source changes, then:

    cd packaging/arch/app
    ./export-source.sh
    makepkg -s

export-source.sh exports tracked HEAD to a source archive and generates PKGBUILD
with checksums from PKGBUILD.in. For a published Arch/AUR package, replace the
local archive with a fixed release URL and checksum after upstream assigns a
revision. The GUI build downloads lockfile dependencies and the checksummed
Electron runtime; it is not a fully offline build. Lifecycle scripts are disabled
except the reviewed Electron downloader. Electron keeps its renderer sandbox;
no --no-sandbox launcher flag or setuid permission is added. Dependency downloads
need a writable build tree. npm audit has upstream build-only advisories; this
recipe does not silently change the dependency lockfile.

## Configure (explicit administrator actions)

Install the two built packages with pacman -U. Installation builds DKMS modules
but does not enable services or change the currently loaded driver. Create the
packaged access group if the system's sysusers hook has not done so:

    sudo systemd-sysusers /usr/lib/sysusers.d/nitrosense.conf
    sudo usermod -aG nitrosense YOUR_LOGIN

Replace YOUR_LOGIN with the intended local account, then log out and back in so
the desktop session receives the group. Group membership grants hardware control;
do not add every account. The system service owns its /run directory and exposes
a root:nitrosense 0660 socket. A missing group fails closed. The legacy upstream
socket behavior is unchanged unless NITROSENSE_SOCKET_GROUP is set.

On the tested AN515-45 only, activate:

    sudo systemctl enable --now nitrosense-driver.service
    sudo systemctl enable --now nitrosense-daemon.service

The driver unit checks model and module availability, loads dependencies before
the custom driver, initializes fans to firmware auto and attempts stock-driver
recovery on activation failure. It adds no blacklist or forced model parameters.
The app can then be opened from the menu as NitroSense Linux. Its Start Service
button starts only the daemon; activate the driver unit explicitly first.

The Arch unit opts out of saved-setting restores, automatic AC power-mode changes
and driver reconfiguration. These choices avoid writes on daemon startup; the
driver itself can perform firmware initialization. Normal GUI feature controls
remain available. Unsupported firmware features remain unsupported. CPU power
modes use the existing Linux backend and are not a promise of Windows parity.

## KDE

Use System Settings > Keyboard > Shortcuts to assign the desktop launcher.
GNOME key setup is disabled when XDG_CURRENT_DESKTOP contains KDE, even if
GNOME schemas happen to be installed. No guessed keycode or hwdb override ships.

## Update and recovery

Arch's DKMS hooks rebuild on kernel/header updates. Keep matching headers and
compiler packages installed, and inspect DKMS failures before rebooting. A new
kernel API may still need a source change. Secure Boot signing must be configured
through DKMS where required; this recipe does not disable Secure Boot.

Restore stock driver and disable NitroSense startup with:

    sudo /usr/lib/nitrosense/restore-stock-driver.sh

For a boot failure, select a known-good kernel and temporarily append:

    module_blacklist=linuwu_sense systemd.mask=nitrosense-driver.service systemd.mask=nitrosense-daemon.service

Then disable the services and remove the packages with pacman. Never force-unload
a busy module. Firmware-persistent lighting/charge settings are not necessarily
reset by unloading a driver. Reboot and suspend/resume tests remain necessary on
each new hardware/firmware combination.

## Licensing

Keep upstream attribution. App/packaging are MIT and service is GPL-3.0 under the
repository LICENSE. Driver source says GPL-2.0-or-later; its LICENSE file contains
GPLv3 and NitroSense describes its patches as GPL-2.0. Driver metadata follows the
source SPDX provisionally; maintainers should resolve these notices before public
binary distribution. This contribution proposes recipes, not redistributed binaries.
