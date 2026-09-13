#!/usr/bin/env python3
# NitroSense service - Manage Acer laptop features as root service communicating with Linuwu-sense drivers
# Compatible with Predator and Nitro laptops

import os
import subprocess
import sys
import json
import time
import argparse
import ctypes
import fcntl
import glob
import logging
import logging.handlers
import socket
import threading
import signal
import configparser
import traceback
from pathlib import Path
from enum import Enum
from PowerSourceDetection import PowerSourceDetector 
from typing import Dict, List, Optional, Tuple, Set
# from KeyboardMonitor import KeyboardMonitor

# Constants
VERSION = "0.5.2"
SOCKET_PATH = "/var/run/nitrosense.sock"
LOG_PATH = "/var/log/nitrosense.log"
CONFIG_PATH = "/etc/nitrosense/config.ini"
PID_FILE = "/var/run/nitrosense.pid"
MODPROBE_CONFIG_PATH = "/etc/modprobe.d/linuwu-sense.conf"

# Settings the hardware does not keep for itself, reapplied at startup.
#
# The keyboard controller keeps nothing across a power cycle: every boot it
# comes back reporting ffffff on all four zones, and the sysfs reads are real
# firmware queries rather than a cache, so there is no stored value anywhere to
# recover. Fan duty is the same story. Something has to write them back, and
# this is where they are written back from.
#
# /var/lib rather than /etc because it is state the daemon maintains, not
# configuration a user edits. One file per concern so a corrupt one only
# costs that one setting.
STATE_DIR = "/var/lib/nitrosense"
LIGHTING_STATE_PATH = os.path.join(STATE_DIR, "lighting.json")
FAN_STATE_PATH = os.path.join(STATE_DIR, "fan.json")
POWER_STATE_PATH = os.path.join(STATE_DIR, "power.json")

# What each power mode means, as CPU governor and energy performance
# preference. The kernel resets both to their defaults on every boot, so a
# mode the user chose is gone unless it is written back.
#
# MUST match MODE_TARGETS in app/electron/cpupower.ts, which is what applies
# the mode while the app is open. scripts/test-cpupower.ts compares the two
# tables so they cannot drift apart unnoticed. The fan side of a mode is not
# here because setting a mode also writes fan duty, which fan.json already
# remembers.
POWER_MODE_TARGETS = {
    "quiet":       {"governor": "powersave",   "epp": "power"},
    "balanced":    {"governor": "powersave",   "epp": "balance_performance"},
    "performance": {"governor": "performance", "epp": "performance"},
}
CPUFREQ_GLOB = "/sys/devices/system/cpu/cpu[0-9]*/cpufreq"

# Acer ENEK5130 HID RGB controller used by newer Nitro/Predator models where
# linuwu_sense exposes RGB sysfs files but color writes do not affect hardware.
ENEK5130_HID_ID = "HID_ID=0018:00000CF2:00005130"
ENEK5130_HID_NAME = "HID_NAME=ENEK5130:00 0CF2:5130"

_IOC_NRBITS = 8
_IOC_TYPEBITS = 8
_IOC_SIZEBITS = 14
_IOC_NRSHIFT = 0
_IOC_TYPESHIFT = _IOC_NRSHIFT + _IOC_NRBITS
_IOC_SIZESHIFT = _IOC_TYPESHIFT + _IOC_TYPEBITS
_IOC_DIRSHIFT = _IOC_SIZESHIFT + _IOC_SIZEBITS
_IOC_WRITE = 1
_IOC_READ = 2


def _IOC(direction, type_, nr, size):
    return (
        (direction << _IOC_DIRSHIFT)
        | (ord(type_) << _IOC_TYPESHIFT)
        | (nr << _IOC_NRSHIFT)
        | (size << _IOC_SIZESHIFT)
    )


def HIDIOCSFEATURE(length):
    # linux/hidraw.h: _IOC(_IOC_WRITE|_IOC_READ, 'H', 0x06, len)
    return _IOC(_IOC_WRITE | _IOC_READ, 'H', 0x06, length)

# Check if running as root
if os.geteuid() != 0:
    print("This daemon must run as root. Please use sudo or run as root.")
    sys.exit(1)

# Configure logging
log = logging.getLogger("NitroSenseDaemon")
log.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# Console handler
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
log.addHandler(console_handler)

# File handler with rotation
file_handler = logging.handlers.RotatingFileHandler(
    LOG_PATH, maxBytes=1024*1024*5, backupCount=5)
file_handler.setFormatter(formatter)
log.addHandler(file_handler)

def _write_state(path: str, payload: Dict) -> None:
    """Write one state file.

    Never raises. A daemon that dies because it could not write a convenience
    file is worse than a keyboard that forgets its colour.
    """
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        log.warning(f"Could not save {os.path.basename(path)}: {e}")


def _read_state(path: str) -> Optional[Dict]:
    """Read one state file, or None if it is absent or unreadable."""
    try:
        if not os.path.exists(path):
            return None
        with open(path) as f:
            saved = json.load(f)
    except Exception as e:
        log.warning(f"Could not read {os.path.basename(path)}: {e}")
        return None
    return saved if isinstance(saved, dict) else None


def save_lighting(kind: str, values: Dict) -> None:
    """Remember the lighting that was just applied.

    Only one kind is stored, never both. Per-zone colours and a four-zone
    effect are two ways of driving the same LEDs, so replaying both at startup
    would mean the second silently overwriting the first, and which one you got
    would depend on the order they happened to be written in. The last thing
    applied is the thing the user is looking at, so that is what comes back.

    Per-zone is never stored. On AN515-45 a per-zone write leaves the keyboard
    dark: the firmware accepts it, reports success, and lights nothing. Saving
    that meant replaying it at every boot, so the keyboard came up dark and
    stayed dark until an effect was applied by hand. A setting that cannot be
    seen is not worth restoring.
    """
    if kind == "per_zone":
        log.info("Not saving per-zone lighting; it does not light on this model")
        return
    _write_state(LIGHTING_STATE_PATH, {"kind": kind, "values": values})


def load_lighting() -> Optional[Dict]:
    """The last applied lighting, or None if there is nothing usable."""
    saved = _read_state(LIGHTING_STATE_PATH)
    if not saved:
        return None
    if saved.get("kind") not in ("per_zone", "four_zone"):
        return None
    if not isinstance(saved.get("values"), dict):
        return None
    # A file written by an earlier version may still hold per-zone. Replaying
    # it would blank the keyboard, so drop it rather than restore it.
    if saved["kind"] == "per_zone":
        log.info("Ignoring saved per-zone lighting; it does not light on this model")
        return None
    return saved


def save_fan(cpu: int, gpu: int) -> None:
    """Remember the fan duty that was just applied.

    0,0 is the firmware taking the fans back, which is a real choice and worth
    restoring like any other: a user who switched back to automatic should not
    find a manual duty waiting for them after a reboot.
    """
    _write_state(FAN_STATE_PATH, {"cpu": cpu, "gpu": gpu})


def load_fan() -> Optional[Dict]:
    """The last applied fan duty, or None if there is nothing usable."""
    saved = _read_state(FAN_STATE_PATH)
    if not saved:
        return None
    try:
        cpu, gpu = int(saved["cpu"]), int(saved["gpu"])
    except (KeyError, TypeError, ValueError):
        return None
    # Out of range means a file this version did not write. The setter would
    # reject it anyway; refusing here keeps the reason in the log.
    if not (0 <= cpu <= 100 and 0 <= gpu <= 100):
        log.warning(f"Saved fan duty out of range ({cpu},{gpu}), ignoring it")
        return None
    return {"cpu": cpu, "gpu": gpu}


def save_power_mode(mode: str) -> None:
    """Remember the power mode that was just applied."""
    if mode not in POWER_MODE_TARGETS:
        log.warning(f"Refusing to save unknown power mode: {mode}")
        return
    _write_state(POWER_STATE_PATH, {"mode": mode})


def load_power_mode() -> Optional[str]:
    """The last applied power mode, or None if there is nothing usable."""
    saved = _read_state(POWER_STATE_PATH)
    if not saved:
        return None
    mode = saved.get("mode")
    return mode if mode in POWER_MODE_TARGETS else None


def apply_power_mode(mode: str) -> bool:
    """Write a power mode's governor and EPP to every CPU.

    The app applies modes through pkexec, which needs a session and a user to
    authorise it. Neither exists during boot, so the daemon writes these
    itself: it already runs as root, which is the whole reason the restore can
    happen before anyone logs in.

    Partial success counts. energy_performance_preference is absent on
    non-EPP drivers such as acpi-cpufreq, where the governor alone is the
    whole setting.
    """
    target = POWER_MODE_TARGETS.get(mode)
    if not target:
        return False

    policies = sorted(glob.glob(CPUFREQ_GLOB))
    if not policies:
        log.warning("No cpufreq policies found; cannot apply a power mode")
        return False

    wrote = 0
    for policy in policies:
        for attr, value in (("scaling_governor", target["governor"]),
                            ("energy_performance_preference", target["epp"])):
            path = os.path.join(policy, attr)
            if not os.path.exists(path):
                continue
            try:
                with open(path, 'w') as f:
                    f.write(value)
                wrote += 1
            except Exception as e:
                log.warning(f"Could not write {path}: {e}")
    return wrote > 0


def restore_power_mode() -> None:
    """Put the remembered power mode back."""
    mode = load_power_mode()
    if not mode:
        return
    if apply_power_mode(mode):
        log.info(f"Restored power mode {mode}")
    else:
        log.warning(f"Could not restore power mode {mode}")


def restore_fan(manager) -> None:
    """Write the remembered fan duty back to the hardware."""
    saved = load_fan()
    if not saved:
        return
    try:
        ok = manager.set_fan_speed(saved["cpu"], saved["gpu"])
    except Exception as e:
        log.warning(f"Could not restore fan duty: {e}")
        return
    if ok:
        log.info(f"Restored fan duty {saved['cpu']},{saved['gpu']}")
    else:
        log.warning("Hardware refused the saved fan duty")


def restore_lighting(manager) -> None:
    """Write the remembered lighting back to the hardware.

    Called once at startup, after the driver has been found. Every failure is
    logged and swallowed: the setters validate their own arguments and return
    False rather than raising, and a file written by an older version may not
    carry the keys this one expects.
    """
    saved = load_lighting()
    if not saved:
        return

    kind = saved["kind"]
    v = saved["values"]
    try:
        if kind == "per_zone":
            ok = manager.set_per_zone_mode(
                v["zone1"], v["zone2"], v["zone3"], v["zone4"], v["brightness"])
        else:
            ok = manager.set_four_zone_mode(
                v["mode"], v["speed"], v["brightness"], v["direction"],
                v["red"], v["green"], v["blue"])
    except KeyError as e:
        log.warning(f"Saved lighting is missing {e}, ignoring it")
        return
    except Exception as e:
        log.warning(f"Could not restore lighting: {e}")
        return

    if ok:
        log.info(f"Restored {kind} lighting")
    else:
        log.warning(f"Hardware refused the saved {kind} lighting")


class LaptopType(Enum):
    UNKNOWN = 0
    PREDATOR = 1
    NITRO = 2

class HardwareManager:
    """Manages all the NitroSense service features"""

    MAX_RESTART_ATTEMPTS = 20
    RESTART_COUNTER_FILE = "/tmp/nitrosense_restart_attempts"

    def __init__(self):
        '''The initial init (i know very nice description)'''
        log.info(f"** Starting NitroSense service v{VERSION} **")

        # Check if linuwu_sense is installed
        if not os.path.exists("/sys/module/linuwu_sense"):
            log.error("linuwu_sense module not found. Please install the linuwu_sense driver first.")
        else:
            log.info("linuwu_sense module found. Proceeding with initialization.")
        
        self.laptop_type = self._detect_laptop_type()
        # self.keyboard_monitor = None

        #added a delay so that driver sets up properly first
        time.sleep(0.2)

        # If unknown laptop type detected, try restarting drivers (with limit)
        if self.laptop_type == LaptopType.UNKNOWN:
            current_attempts = self._get_restart_attempts()
            
            if current_attempts < self.MAX_RESTART_ATTEMPTS:
                attempts = self._increment_restart_attempts()
                log.warning(f"Unknown laptop type detected, attempting driver restart (attempt {attempts}/{self.MAX_RESTART_ATTEMPTS})...")
                
                if self._restart_drivers_and_daemon():
                    # The daemon will restart itself, so we should exit this instance
                    log.info("Driver restart initiated, daemon will restart automatically")
                    sys.exit(0)
                else:
                    log.error(f"Failed to restart drivers (attempt {attempts}), continuing with limited functionality")
            else:
                log.error(f"Maximum restart attempts ({self.MAX_RESTART_ATTEMPTS}) reached, giving up on driver restart")
                log.info("Continuing with unknown laptop type and limited functionality")
        else:
            # Reset counter on successful detection
            self._reset_restart_attempts()
        
        self.base_path = self._get_base_path()
        self.has_four_zone_kb = self._check_four_zone_kb()
        self.enek5130_hid_device = self._find_enek5130_hid_device()
        self.current_modprobe_param = self._detect_current_modprobe_param()

        # Available features set
        self.available_features = self._detect_available_features()

        log.info(f"Detected laptop type: {self.laptop_type.name}")
        log.info(f"Base path: {self.base_path}")
        log.info(f"Four-zone keyboard: {'Yes' if self.has_four_zone_kb else 'No'}")
        log.info(f"ENEK5130 HID RGB device: {self.enek5130_hid_device or 'Not found'}")
        log.info(f"Available features: {', '.join(self.available_features)}")

        # Check if paths exist
        if not os.path.exists(self.base_path) and self.laptop_type != LaptopType.UNKNOWN:
            log.error(f"Base path does not exist: {self.base_path}")
            raise FileNotFoundError(f"Base path does not exist: {self.base_path}")
        
        self.power_monitor = None

    def _get_restart_attempts(self) -> int:
        """Get current restart attempt count"""
        try:
            if os.path.exists(self.RESTART_COUNTER_FILE):
                with open(self.RESTART_COUNTER_FILE, 'r') as f:
                    return int(f.read().strip())
        except (ValueError, IOError):
            pass
        return 0

    def _increment_restart_attempts(self) -> int:
        """Increment and return restart attempt count"""
        attempts = self._get_restart_attempts() + 1
        try:
            with open(self.RESTART_COUNTER_FILE, 'w') as f:
                f.write(str(attempts))
        except IOError as e:
            log.error(f"Failed to write restart counter: {e}")
        return attempts

    def _reset_restart_attempts(self):
        """Reset restart attempt counter"""
        try:
            if os.path.exists(self.RESTART_COUNTER_FILE):
                os.unlink(self.RESTART_COUNTER_FILE)
        except IOError as e:
            log.error(f"Failed to reset restart counter: {e}")

    def _force_model_nitro(self):
        """Restart linuwu-sense driver and NitroSense service service with nitro_v4 parameter"""
        log.info("Forcing model detection to Nitro by restarting drivers and daemon")

        try:
            # Remove the module
            subprocess.run(['sudo', 'rmmod', 'linuwu_sense'], check=True)
            log.info("Successfully removed linuwu-sense module")
            
            # Wait a moment
            time.sleep(2)
            
            # Reload the module
            subprocess.run(['sudo', 'modprobe', 'linuwu_sense', 'nitro_v4'], check=True)
            log.info("Successfully reloaded linuwu-sense module")
            
            # Wait a moment for module to initialize
            time.sleep(3)
            
            # Restart the daemon service
            log.info("Restarting NitroSense service service (may produce an error)")
            subprocess.run(['sudo', 'systemctl', 'restart', 'nitrosense-daemon.service'], check=True)
            
            return True
        
        except Exception as e:
            log.error(f"Unexpected error while Forcing Nitro Model: {e}")
            return False
        

    def _force_model_predator(self):
        """Restart linuwu-sense driver and NitroSense service service with predator_v4 parameter"""
        log.info("Forcing model detection to Predator by restarting drivers and daemon")

        try:
            # Remove the module
            subprocess.run(['sudo', 'rmmod', 'linuwu_sense'], check=True)
            log.info("Successfully removed linuwu-sense module")
            
            # Wait a moment
            time.sleep(2)
            
            # Reload the module
            subprocess.run(['sudo', 'modprobe', 'linuwu_sense', 'predator_v4'], check=True)
            log.info("Successfully reloaded linuwu-sense module")

            # Wait a moment for module to initialize
            time.sleep(3)

            # Restart the daemon service
            log.info("Restarting NitroSense service service (may produce an error)")
            subprocess.run(['sudo', 'systemctl', 'restart', 'nitrosense-daemon.service'], check=True)

            return True

        except Exception as e:
            log.error(f"Unexpected error while Forcing Predator Model: {e}")
            return False

    def _force_enable_all(self):
        """Restart linuwu-sense driver and NitroSense service service with enable_all parameter"""
        log.info("Forcing all features by restarting daemon and drivers with parameter enable_all")

        try:
            # Remove the module
            subprocess.run(['sudo', 'rmmod', 'linuwu_sense'], check=True)
            log.info("Successfully removed linuwu-sense module")
            
            # Wait a moment
            time.sleep(2)
            
            # Reload the module
            subprocess.run(['sudo', 'modprobe', 'linuwu_sense', 'enable_all'], check=True)
            log.info("Successfully reloaded linuwu-sense module with enable_all parameter")
            
            # Wait a moment for module to initialize
            time.sleep(3)
            
            # Restart the daemon service
            log.info("Restarting NitroSense service service (may produce an error)")
            subprocess.run(['sudo', 'systemctl', 'restart', 'nitrosense-daemon.service'], check=True)
            
            return True
        
        except Exception as e:
            log.error(f"Unexpected error while Forcing All Features: {e}")
            return False
        
    def _detect_current_modprobe_param(self) -> str:
        """Detect which modprobe parameter is currently set"""
        try:
            if os.path.exists(MODPROBE_CONFIG_PATH):
                with open(MODPROBE_CONFIG_PATH, 'r') as f:
                    content = f.read().strip().lower()
                    if "nitro_v4" in content:
                        return "nitro_v4"
                    elif "predator_v4" in content:
                        return "predator_v4"
                    elif "enable_all" in content:
                        return "enable_all"
        except Exception as e:
            log.error(f"Failed to read modprobe config: {e}")
        return ""

    def _set_modprobe_parameter(self, param: str) -> bool:
        """Set modprobe parameter in config file"""
        try:
            # Create directory if it doesn't exist
            os.makedirs(os.path.dirname(MODPROBE_CONFIG_PATH), exist_ok=True)
            
            # Write the config file
            with open(MODPROBE_CONFIG_PATH, 'w') as f:
                f.write(f"options linuwu_sense {param}=1\n")
                f.flush()
                os.fsync(f.fileno())  # Force write to disk
            
            # Verify the write was successful
            time.sleep(0.1)  # Small delay to ensure file system sync
            if os.path.exists(MODPROBE_CONFIG_PATH):
                with open(MODPROBE_CONFIG_PATH, 'r') as f:
                    content = f.read().strip()
                    expected = f"options linuwu_sense {param}=1"
                    if expected in content:
                        log.info(f"Successfully set modprobe parameter: {param}")
                        self.current_modprobe_param = param
                        return True
                    else:
                        log.error(f"Verification failed. Expected '{expected}', got '{content}'")
                        return False
            else:
                log.error(f"Config file not found after write: {MODPROBE_CONFIG_PATH}")
                return False
                
        except Exception as e:
            log.error(f"Failed to set modprobe parameter: {e}")
            return False

    def _remove_modprobe_parameter(self) -> bool:
        """Remove modprobe parameter config file"""
        try:
            if os.path.exists(MODPROBE_CONFIG_PATH):
                os.unlink(MODPROBE_CONFIG_PATH)
                # Verify removal
                time.sleep(0.1)
                if not os.path.exists(MODPROBE_CONFIG_PATH):
                    log.info("Successfully removed modprobe parameter config")
                    self.current_modprobe_param = ""
                    return True
                else:
                    log.error("Failed to verify modprobe parameter removal")
                    return False
            else:
                self.current_modprobe_param = ""
                return True
        except Exception as e:
            log.error(f"Failed to remove modprobe parameter: {e}")
            return False

    def get_modprobe_parameter(self) -> str:
        """Get current modprobe parameter"""
        return self.current_modprobe_param

    def set_modprobe_parameter(self, param: str) -> bool:
        """Set modprobe parameter and restart drivers"""
        log.info(f"Attempting to set modprobe parameter: {param}")
        log.info(f"Current parameter: {self.current_modprobe_param}")
        log.info(f"Config path: {MODPROBE_CONFIG_PATH}")
        
        if param not in ["nitro_v4", "predator_v4", "enable_all", ""]:
            log.error(f"Invalid modprobe parameter: {param}")
            return False
        
        if param == "":
            # Remove parameter
            log.info("Removing modprobe parameter")
            if not self._remove_modprobe_parameter():
                log.error("Failed to remove modprobe parameter")
                return False
        else:
            # Set parameter
            log.info(f"Setting modprobe parameter to: {param}")
            if not self._set_modprobe_parameter(param):
                log.error(f"Failed to set modprobe parameter: {param}")
                return False
        
        # Verify the change
        if param != "":
            if not self._verify_modprobe_parameter(param):
                log.error(f"Verification failed for parameter: {param}")
                return False
        
        # Restart drivers and daemon
        log.info("Restarting drivers and daemon with new parameter")
        return self._restart_drivers_and_daemon()

    def _verify_modprobe_parameter(self, param: str) -> bool:
        """Verify that the modprobe parameter was written correctly"""
        try:
            if os.path.exists(MODPROBE_CONFIG_PATH):
                with open(MODPROBE_CONFIG_PATH, 'r') as f:
                    content = f.read().strip()
                    expected = f"options linuwu_sense {param}=1"
                    if expected in content:
                        log.info(f"Verification successful for parameter: {param}")
                        return True
                    else:
                        log.error(f"Verification failed. Expected '{expected}', got '{content}'")
                        return False
            else:
                log.error(f"Config file does not exist: {MODPROBE_CONFIG_PATH}")
                return False
        except Exception as e:
            log.error(f"Verification error: {e}")
            return False
        
    def _restart_daemon(self):
        """Restart NitroSense service service alone"""
        attempts = self._get_restart_attempts()
        log.info(f"Attempting to restart daemon")
        
        try:
            # Restart the daemon service
            log.info("Restarting NitroSense service service (may produce an error)")
            subprocess.run(['sudo', 'systemctl', 'restart', 'nitrosense-daemon.service'], check=True)
            
            return True
            
        except Exception as e:
            log.error(f"Unexpected error during restart (attempt {attempts}): {e}")
            return False
            

    def _restart_drivers_and_daemon(self):
        """Restart linuwu-sense driver and NitroSense service service"""
        attempts = self._get_restart_attempts()
        log.info(f"Attempting to restart drivers and daemon (attempt {attempts}/{self.MAX_RESTART_ATTEMPTS})...")
        
        try:
            # Remove the module
            subprocess.run(['sudo', 'rmmod', 'linuwu_sense'], check=True)
            log.info("Successfully removed linuwu-sense module")
            
            # Wait a moment
            time.sleep(2)
            
            # Reload the module
            subprocess.run(['sudo', 'modprobe', 'linuwu_sense'], check=True)
            log.info("Successfully reloaded linuwu-sense module")
            
            # Wait a moment for module to initialize
            time.sleep(3)
            
            # Restart the daemon service
            log.info("Restarting NitroSense service service (may produce an error)")
            subprocess.run(['sudo', 'systemctl', 'restart', 'nitrosense-daemon.service'], check=True)
            
            return True
            
        except Exception as e:
            log.error(f"Unexpected error during restart (attempt {attempts}): {e}")
            return False
            
    def _detect_laptop_type(self) -> LaptopType:
        """Detect whether this is a Predator or Nitro laptop"""
        predator_path = "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/predator_sense"
        nitro_path = "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/nitro_sense"

        if os.path.exists(predator_path):
            return LaptopType.PREDATOR
        elif os.path.exists(nitro_path):
            return LaptopType.NITRO
        else:
            return LaptopType.UNKNOWN

    def _get_base_path(self) -> str:
        """Get the base path for VFS access based on laptop type"""
        if self.laptop_type == LaptopType.PREDATOR:
            return "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/predator_sense"
        elif self.laptop_type == LaptopType.NITRO:
            return "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/nitro_sense"
        else:
            return ""

    def get_driver_version(self) -> str:
        """Get Driver version"""
        version_file = os.path.join(self.base_path, "version")
        if not os.path.isfile(version_file):
            return "Unknown Version"
        
        try:
            with open(version_file, "r") as f:
                return f.read().strip() or "Unknown Version"
        except (OSError, IOError):
            return "Unknown Version"
    

    def _detect_available_features(self) -> Set[str]:
        """Detect which features are available on the current laptop"""
        available = set()

        # Always check thermal profile since it's ACPI standard
        if os.path.exists("/sys/firmware/acpi/platform_profile"):
            available.add("thermal_profile")

        # Only check other features if laptop type is recognized
        if self.laptop_type != LaptopType.UNKNOWN and os.path.exists(self.base_path):
            feature_files = [
                ("backlight_timeout", "backlight_timeout"),
                ("battery_calibration", "battery_calibration"),
                ("battery_limiter", "battery_limiter"),
                ("boot_animation_sound", "boot_animation_sound"),
                ("fan_speed", "fan_speed"),
                ("lcd_override", "lcd_override"),
                ("usb_charging", "usb_charging"),
            ]

            for feature_name, file_name in feature_files:
                file_path = os.path.join(self.base_path, file_name)
                if os.path.exists(file_path):
                    available.add(feature_name)

        # Check keyboard features
        if self.has_four_zone_kb:
            kb_base = "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb"
            if os.path.exists(os.path.join(kb_base, "per_zone_mode")):
                available.add("per_zone_mode")
            if os.path.exists(os.path.join(kb_base, "four_zone_mode")):
                available.add("four_zone_mode")

        # Newer Acer keyboards can require direct ENEK5130 HID feature reports.
        # Do not advertise the existing linuwu_sense RGB feature names unless
        # their sysfs files exist; the ENEK backend is currently a static-color
        # supplement for devices where those sysfs writes are ineffective.
        if self.enek5130_hid_device:
            available.add("enek5130_hid_rgb")

        return available

    def _check_four_zone_kb(self) -> bool:
        """Check if four-zone keyboard is available"""
        if self.laptop_type != LaptopType.UNKNOWN:
            kb_path = "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb"
            return os.path.exists(kb_path)
        return False

    def _read_file(self, path: str) -> str:
        """Read from a VFS file"""
        try:
            with open(path, 'r') as f:
                return f.read().strip()
        except Exception as e:
            log.error(f"Failed to read from {path}: {e}")
            return ""

    def _write_file(self, path: str, value: str) -> bool:
        """Write to a VFS file"""
        try:
            with open(path, 'w') as f:
                f.write(str(value))
            return True
        except Exception as e:
            log.error(f"Failed to write to {path}: {e}")
            return False

    def _find_enek5130_hid_device(self) -> str:
        """Find the ENEK5130 RGB hidraw device by stable sysfs identity."""
        candidates = self._find_enek5130_hid_candidates()
        return candidates[0] if candidates else ""

    def _find_enek5130_hid_candidates(self) -> List[str]:
        """Find all ENEK5130 hidraw candidates by stable sysfs identity."""
        candidates = []
        for dev in sorted(glob.glob('/dev/hidraw*')):
            uevent_path = f"/sys/class/hidraw/{os.path.basename(dev)}/device/uevent"
            try:
                with open(uevent_path, 'r', encoding='utf-8') as f:
                    uevent = f.read()
            except OSError:
                continue

            if ENEK5130_HID_ID in uevent or ENEK5130_HID_NAME in uevent:
                candidates.append(dev)

        return candidates

    def _set_enek5130_hid_report(self, effect: int, red: int, green: int, blue: int,
                                  brightness: int, speed: int, direction: int,
                                  zone_mask: int) -> bool:
        """Send an ENEK5130 keyboard RGB HID feature report.

        Known packet format:
        a4 21 effect brightness speed direction rr gg bb zone_mask 00
        zone_mask 0x01/0x02/0x04/0x08 targets zones 1-4; 0x0f targets all zones.
        """
        candidates = self._find_enek5130_hid_candidates()
        if self.enek5130_hid_device and self.enek5130_hid_device not in candidates:
            candidates.insert(0, self.enek5130_hid_device)

        if not candidates:
            log.debug("ENEK5130 HID RGB device not found")
            return False

        if not all(0 <= value <= 255 for value in [effect, speed, direction]):
            log.error(f"Invalid ENEK5130 effect fields: effect={effect}, speed={speed}, direction={direction}")
            return False

        if not (0 <= brightness <= 100):
            log.error(f"Invalid ENEK5130 brightness. Must be between 0 and 100: {brightness}")
            return False

        if not all(0 <= color <= 255 for color in [red, green, blue]):
            log.error(f"Invalid ENEK5130 RGB values. Must be 0-255: {red},{green},{blue}")
            return False

        if not (0 <= zone_mask <= 0x0F):
            log.error(f"Invalid ENEK5130 zone mask. Must be 0x00-0x0f: {zone_mask:#x}")
            return False

        packet = bytes([
            0xA4, 0x21, effect, brightness,
            speed, direction,
            red, green, blue, zone_mask, 0x00
        ])

        for device in candidates:
            try:
                fd = os.open(device, os.O_RDWR | os.O_NONBLOCK)
                try:
                    buf = ctypes.create_string_buffer(packet, len(packet))
                    ret = fcntl.ioctl(fd, HIDIOCSFEATURE(len(packet)), buf, True)
                    log.info(
                        "Set ENEK5130 HID RGB via %s report=%s ret=%s",
                        device,
                        ' '.join(f'{b:02x}' for b in packet),
                        ret
                    )
                    self.enek5130_hid_device = device
                    return True
                finally:
                    os.close(fd)
            except Exception as e:
                log.warning(f"Failed ENEK5130 HID RGB candidate {device}: {e}")

        return False

    def _set_enek5130_zone_color(self, red: int, green: int, blue: int,
                                  brightness: int, zone_mask: int) -> bool:
        """Set a static color on one or more ENEK5130 keyboard zones."""
        return self._set_enek5130_hid_report(0x02, red, green, blue, brightness, 0x00, 0x00, zone_mask)

    def _set_enek5130_static_color(self, red: int, green: int, blue: int, brightness: int,
                                   speed: int = 0, direction: int = 0) -> bool:
        """Set static all-zone color using the Acer ENEK5130 HID feature report."""
        return self._set_enek5130_zone_color(red, green, blue, brightness, 0x0F)

    def _set_enek5130_per_zone_color(self, zones: List[str], brightness: int) -> bool:
        """Set four ENEK5130 zones using confirmed zone masks 0x01,0x02,0x04,0x08."""
        zone_masks = [0x01, 0x02, 0x04, 0x08]
        for zone, zone_mask in zip(zones, zone_masks):
            red = int(zone[0:2], 16)
            green = int(zone[2:4], 16)
            blue = int(zone[4:6], 16)
            if not self._set_enek5130_zone_color(red, green, blue, brightness, zone_mask):
                return False
        return True

    def _set_enek5130_effect(self, mode: int, speed: int, brightness: int,
                             direction: int, red: int, green: int, blue: int) -> bool:
        """Set a confirmed ENEK5130 dynamic lighting effect.

        UI modes:
        0 Static, 1 Breathing, 2 Neon, 3 Wave, 4 Shifting,
        5 Zoom, 6 Meteor, 7 Twinkling.

        Confirmed on Acer Nitro ANV16S-41 / ENEK5130:
        0x04 breathing, 0x05 neon-like, 0x07 wave/shifting,
        0x09 zoom, 0x0a snake/meteor-like, 0x0b random/twinkling-like.

        Unstable/unknown values are deliberately not mapped here:
        0x01/0x03 black/off, 0x06 short flash/returns to previous,
        0x08 glitch, 0x0c freezes previous lighting effect.
        """
        effect_map = {
            1: 0x04,  # Breathing Mode
            2: 0x05,  # Neon Mode
            3: 0x07,  # Wave Mode
            4: 0x07,  # Shifting Mode (same confirmed native wave/shifting effect)
            5: 0x09,  # Zoom Mode
            6: 0x0A,  # Meteor Mode (snake-like on ENEK5130)
            7: 0x0B,  # Twinkling Mode (random on ENEK5130)
        }

        effect = effect_map.get(mode)
        if effect is None:
            return False

        # The UI currently exposes speed as 0-9. Although ENEK5130 accepts larger
        # speed bytes for breathing/neon, direct UI values match the app's
        # expected speed feel better than scaling 0-9 to 0-100.
        if effect in [0x04, 0x05]:
            hid_speed = speed
        else:
            hid_speed = min(10, max(1, speed + 1))

        return self._set_enek5130_hid_report(
            effect, red, green, blue, brightness, hid_speed, direction, 0x0F
        )

    def get_thermal_profile(self) -> str:
        """Get current thermal profile"""
        if "thermal_profile" not in self.available_features:
            return ""
        return self._read_file("/sys/firmware/acpi/platform_profile")

    def set_thermal_profile(self, profile: str) -> bool:
        """Set thermal profile"""
        if "thermal_profile" not in self.available_features:
            return False

        available_profiles = self.get_thermal_profile_choices()
        if profile not in available_profiles:
            log.error(f"Invalid thermal profile: {profile}. Available profiles: {available_profiles}")
            return False

        return self._write_file("/sys/firmware/acpi/platform_profile", profile)

    def get_thermal_profile_choices(self) -> List[str]:
        """Get available thermal profiles"""
        if "thermal_profile" not in self.available_features:
            return []

        choices = self._read_file("/sys/firmware/acpi/platform_profile_choices")
        return choices.split() if choices else []

    def get_backlight_timeout(self) -> str:
        """Get backlight timeout status"""
        if "backlight_timeout" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "backlight_timeout"))

    def set_backlight_timeout(self, enabled: bool) -> bool:
        """Set backlight timeout status"""
        if "backlight_timeout" not in self.available_features:
            return False

        return self._write_file(
            os.path.join(self.base_path, "backlight_timeout"),
            "1" if enabled else "0"
        )

    def get_battery_calibration(self) -> str:
        """Get battery calibration status"""
        if "battery_calibration" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "battery_calibration"))

    def set_battery_calibration(self, enabled: bool) -> bool:
        """Start or stop battery calibration"""
        if "battery_calibration" not in self.available_features:
            return False

        return self._write_file(
            os.path.join(self.base_path, "battery_calibration"),
            "1" if enabled else "0"
        )

    def get_battery_limiter(self) -> str:
        """Get battery limiter status"""
        if "battery_limiter" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "battery_limiter"))

    def set_battery_limiter(self, enabled: bool) -> bool:
        """Set battery limiter status"""
        if "battery_limiter" not in self.available_features:
            return False

        return self._write_file(
            os.path.join(self.base_path, "battery_limiter"),
            "1" if enabled else "0"
        )

    def get_boot_animation_sound(self) -> str:
        """Get boot animation sound status"""
        if "boot_animation_sound" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "boot_animation_sound"))

    def set_boot_animation_sound(self, enabled: bool) -> bool:
        """Set boot animation sound status"""
        if "boot_animation_sound" not in self.available_features:
            return False

        return self._write_file(
            os.path.join(self.base_path, "boot_animation_sound"),
            "1" if enabled else "0"
        )

    def get_fan_speed(self) -> Tuple[str, str]:
        """Get CPU and GPU fan speeds"""
        if "fan_speed" not in self.available_features:
            return ("", "")

        file_path = os.path.join(self.base_path, "fan_speed")

        try:
            with open(file_path, 'r') as f:
                speeds = f.read().strip()

                if "," in speeds:
                    cpu, gpu = speeds.split(",", 1)
                    return (cpu.strip(), gpu.strip())
        except Exception as e:
            log.error(f"Error reading fan speed: {e}")

        return ("0", "0")  # Fallback

    def set_fan_speed(self, cpu: int, gpu: int) -> bool:
        """Set CPU and GPU fan speeds"""
        if "fan_speed" not in self.available_features:
            return False

        # Validate values
        if not (0 <= cpu <= 100 and 0 <= gpu <= 100):
            log.error(f"Invalid fan speeds. Values must be between 0 and 100: cpu={cpu}, gpu={gpu}")
            return False

        return self._write_file(
            os.path.join(self.base_path, "fan_speed"),
            f"{cpu},{gpu}"
        )


    def get_lcd_override(self) -> str:
        """Get LCD override status"""
        if "lcd_override" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "lcd_override"))

    def set_lcd_override(self, enabled: bool) -> bool:
        """Set LCD override status"""
        if "lcd_override" not in self.available_features:
            return False

        return self._write_file(
            os.path.join(self.base_path, "lcd_override"),
            "1" if enabled else "0"
        )

    def get_usb_charging(self) -> str:
        """Get USB charging status"""
        if "usb_charging" not in self.available_features:
            return ""

        return self._read_file(os.path.join(self.base_path, "usb_charging"))

    def set_usb_charging(self, level: int) -> bool:
        """Set USB charging level (0, 10, 20, 30)"""
        if "usb_charging" not in self.available_features:
            return False

        # Validate values
        if level not in [0, 10, 20, 30]:
            log.error(f"Invalid USB charging level. Must be 0, 10, 20, or 30: {level}")
            return False

        return self._write_file(
            os.path.join(self.base_path, "usb_charging"),
            str(level)
        )

    def get_per_zone_mode(self) -> str:
        """Get per-zone mode configuration"""
        if "per_zone_mode" not in self.available_features:
            return ""

        return self._read_file("/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb/per_zone_mode")

    def set_per_zone_mode(self, zone1: str, zone2: str, zone3: str, zone4: str, brightness: int) -> bool:
        """Set per-zone mode configuration
        
        Args:
            zone1-zone4: RGB hex values (e.g., "4287f5")
            brightness: 0-100
        """
        if "per_zone_mode" not in self.available_features:
            return False

        # Validate hex values
        for i, zone in enumerate([zone1, zone2, zone3, zone4], 1):
            try:
                # Check if valid hex color
                int(zone, 16)
                if len(zone) != 6:
                    log.error(f"Invalid hex color for zone {i}: {zone}. Must be 6 characters.")
                    return False
            except ValueError:
                log.error(f"Invalid hex color for zone {i}: {zone}")
                return False

        # Validate brightness
        if not (0 <= brightness <= 100):
            log.error(f"Invalid brightness. Must be between 0 and 100: {brightness}")
            return False

        value = f"{zone1},{zone2},{zone3},{zone4},{brightness}\n"

        if self.enek5130_hid_device:
            if self._set_enek5130_per_zone_color([zone1, zone2, zone3, zone4], brightness):
                return True

        return self._write_file(
            "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb/per_zone_mode",
            value
        )

    def get_four_zone_mode(self) -> str:
        """Get four-zone mode configuration"""
        if "four_zone_mode" not in self.available_features:
            return ""

        return self._read_file("/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb/four_zone_mode")

    def set_four_zone_mode(self, mode: int, speed: int, brightness: int,
                           direction: int, red: int, green: int, blue: int) -> bool:
        """Set four-zone mode configuration
        
        Args:
            mode: 0-7 (lighting effect type)
            speed: 0-9 (effect speed)
            brightness: 0-100 (light intensity)
            direction: 1-2 (1=right to left, 2=left to right)
            red, green, blue: 0-255 (RGB color values)
        """
        if "four_zone_mode" not in self.available_features:
            return False

        # Validate values
        if not (0 <= mode <= 7):
            log.error(f"Invalid mode. Must be between 0 and 7: {mode}")
            return False

        if not (0 <= speed <= 9):
            log.error(f"Invalid speed. Must be between 0 and 9: {speed}")
            return False

        if not (0 <= brightness <= 100):
            log.error(f"Invalid brightness. Must be between 0 and 100: {brightness}")
            return False

        if direction not in [1, 2]:
            log.error(f"Invalid direction. Must be 1 or 2: {direction}")
            return False

        if not all(0 <= color <= 255 for color in [red, green, blue]):
            log.error(f"Invalid RGB values. Must be between 0 and 255: {red},{green},{blue}")
            return False

        value = f"{mode},{speed},{brightness},{direction},{red},{green},{blue}\n"

        if self.enek5130_hid_device:
            if mode == 0:
                if self._set_enek5130_static_color(red, green, blue, brightness):
                    return True
            elif self._set_enek5130_effect(mode, speed, brightness, direction, red, green, blue):
                return True

        return self._write_file(
            "/sys/module/linuwu_sense/drivers/platform:acer-wmi/acer-wmi/four_zoned_kb/four_zone_mode",
            value
        )

    def get_all_settings(self) -> Dict:
        """Get all NitroSense service settings as a dictionary"""
        settings = {
            "laptop_type": self.laptop_type.name,
            "has_four_zone_kb": self.has_four_zone_kb,
            "available_features": list(self.available_features),
            "version": VERSION,
            "driver_version": self.get_driver_version(),
            "modprobe_parameter": self.current_modprobe_param
        }

        # Only include thermal profile if available
        if "thermal_profile" in self.available_features:
            settings["thermal_profile"] = {
                "current": self.get_thermal_profile(),
                "available": self.get_thermal_profile_choices()
            }
        else:
            # Include an empty entry for compatibility
            settings["thermal_profile"] = {
                "current": "",
                "available": []
            }

        # Add all other features if available
        if "backlight_timeout" in self.available_features:
            settings["backlight_timeout"] = self.get_backlight_timeout()

        if "battery_calibration" in self.available_features:
            settings["battery_calibration"] = self.get_battery_calibration()

        if "battery_limiter" in self.available_features:
            settings["battery_limiter"] = self.get_battery_limiter()

        if "boot_animation_sound" in self.available_features:
            settings["boot_animation_sound"] = self.get_boot_animation_sound()

        if "fan_speed" in self.available_features:
            cpu_fan, gpu_fan = self.get_fan_speed()
            settings["fan_speed"] = {
                "cpu": cpu_fan,
                "gpu": gpu_fan
            }

        if "lcd_override" in self.available_features:
            settings["lcd_override"] = self.get_lcd_override()

        if "usb_charging" in self.available_features:
            settings["usb_charging"] = self.get_usb_charging()

        if "per_zone_mode" in self.available_features:
            settings["per_zone_mode"] = self.get_per_zone_mode()

        if "four_zone_mode" in self.available_features:
            settings["four_zone_mode"] = self.get_four_zone_mode()

        return settings


class DaemonServer:
    """Unix Socket server for IPC with the GUI client"""

    def __init__(self, manager: HardwareManager):
        self.manager = manager
        self.socket = None
        self.running = False
        self.clients = []

    def start(self):
        """Start the Unix socket server"""
        # Remove socket if it already exists
        try:
            if os.path.exists(SOCKET_PATH):
                os.unlink(SOCKET_PATH)
        except OSError as e:
            log.error(f"Failed to remove existing socket: {e}")
            return False

        try:
            self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.socket.bind(SOCKET_PATH)
            # Ensure socket permissions allow non-root access
            os.chmod(SOCKET_PATH, 0o666)
            self.socket.listen(5)
            self.socket.settimeout(1)  # 1 second timeout for clean shutdown
            self.running = True

            log.info(f"Server listening on {SOCKET_PATH}")

            # Accept connections in a loop
            while self.running:
                try:
                    client, _ = self.socket.accept()
                    client_thread = threading.Thread(target=self.handle_client, args=(client,))
                    client_thread.daemon = True
                    client_thread.start()
                    self.clients.append((client, client_thread))
                except socket.timeout:
                    # This is expected due to the timeout
                    continue
                except Exception as e:
                    if self.running:  # Only log if not shutting down
                        log.error(f"Error accepting connection: {e}")

            return True

        except Exception as e:
            log.error(f"Failed to start server: {e}")
            return False

    def stop(self):
        """Stop the server and clean up"""
        log.info("Stopping server...")
        self.running = False
    
        # Close all client connections
        for client, _ in self.clients:
            try:
                client.close()
            except:
                pass
    
        # Close server socket
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
    
        # Clean up socket file
        self.cleanup_socket()

    def cleanup_socket(self):
        """Clean up the socket file"""
        try:
            if os.path.exists(SOCKET_PATH):
                os.unlink(SOCKET_PATH)
                log.info(f"Removed socket file: {SOCKET_PATH}")
        except Exception as e:
            log.error(f"Failed to remove socket file: {e}")


    def handle_client(self, client_socket):
        """Handle communication with a client"""
        try:
            while self.running:
                # Receive data from client
                data = client_socket.recv(4096)
                if not data:
                    break

                try:
                    # Parse JSON request
                    request = json.loads(data.decode('utf-8'))
                    command = request.get("command", "")
                    params = request.get("params", {})

                    # Process command
                    response = self.process_command(command, params)

                    # Send response
                    client_socket.sendall(json.dumps(response).encode('utf-8'))

                except json.JSONDecodeError:
                    log.error("Invalid JSON received")
                    client_socket.sendall(json.dumps({
                        "success": False,
                        "error": "Invalid JSON format"
                    }).encode('utf-8'))
                except Exception as e:
                    log.error(f"Error processing request: {e}")
                    log.error(traceback.format_exc())
                    client_socket.sendall(json.dumps({
                        "success": False,
                        "error": str(e)
                    }).encode('utf-8'))

        except Exception as e:
            if self.running:  # Only log if not shutting down
                log.error(f"Client connection error: {e}")
        finally:
            try:
                client_socket.close()
            except:
                pass

    def process_command(self, command: str, params: Dict) -> Dict:
        """Process a command from the client"""
        log.info(f"Processing command: {command} with params: {params}")

        try:
            if command == "get_all_settings":
                settings = self.manager.get_all_settings()
                return {
                    "success": True,
                    "data": settings
                }

            elif command == "get_thermal_profile":
                # Check if feature is available
                if "thermal_profile" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Thermal profile is not supported on this device"
                    }

                profile = self.manager.get_thermal_profile()
                choices = self.manager.get_thermal_profile_choices()
                return {
                    "success": True,
                    "data": {
                        "current": profile,
                        "available": choices
                    }
                }

            elif command == "set_thermal_profile":
                # Check if feature is available
                if "thermal_profile" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Thermal profile is not supported on this device"
                    }

                profile = params.get("profile", "")
                success = self.manager.set_thermal_profile(profile)
                return {
                    "success": success,
                    "data": {"profile": profile} if success else None,
                    "error": "Failed to set thermal profile" if not success else None
                }

            elif command == "set_backlight_timeout":
                # Check if feature is available
                if "backlight_timeout" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Backlight timeout is not supported on this device"
                    }

                enabled = params.get("enabled", False)
                success = self.manager.set_backlight_timeout(enabled)
                return {
                    "success": success,
                    "data": {"enabled": enabled} if success else None,
                    "error": "Failed to set backlight timeout" if not success else None
                }

            elif command == "set_battery_calibration":
                # Check if feature is available
                if "battery_calibration" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Battery calibration is not supported on this device"
                    }

                enabled = params.get("enabled", False)
                success = self.manager.set_battery_calibration(enabled)
                return {
                    "success": success,
                    "data": {"enabled": enabled} if success else None,
                    "error": "Failed to set battery calibration" if not success else None
                }

            elif command == "set_battery_limiter":
                # Check if feature is available
                if "battery_limiter" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Battery limiter is not supported on this device"
                    }

                enabled = params.get("enabled", False)
                success = self.manager.set_battery_limiter(enabled)
                return {
                    "success": success,
                    "data": {"enabled": enabled} if success else None,
                    "error": "Failed to set battery limiter" if not success else None
                }

            elif command == "set_boot_animation_sound":
                # Check if feature is available
                if "boot_animation_sound" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Boot animation sound is not supported on this device"
                    }

                enabled = params.get("enabled", False)
                success = self.manager.set_boot_animation_sound(enabled)
                return {
                    "success": success,
                    "data": {"enabled": enabled} if success else None,
                    "error": "Failed to set boot animation sound" if not success else None
                }

            elif command == "set_fan_speed":
                # Check if feature is available
                if "fan_speed" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Fan speed control is not supported on this device"
                    }

                cpu = params.get("cpu", 0)
                gpu = params.get("gpu", 0)
                success = self.manager.set_fan_speed(cpu, gpu)
                if success:
                    save_fan(cpu, gpu)
                return {
                    "success": success,
                    "data": {"cpu": cpu, "gpu": gpu} if success else None,
                    "error": "Failed to set fan speed" if not success else None
                }

            elif command == "remember_power_mode":
                # The app has already applied the mode through pkexec; this
                # only records it so the daemon can put it back at boot, when
                # there is no session for pkexec to ask.
                mode = params.get("mode", "")
                if mode not in POWER_MODE_TARGETS:
                    return {"success": False, "error": f"Unknown power mode: {mode}"}
                save_power_mode(mode)
                return {"success": True, "data": {"mode": mode}}

            elif command == "set_lcd_override":
                # Check if feature is available
                if "lcd_override" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "LCD override is not supported on this device"
                    }

                enabled = params.get("enabled", False)
                success = self.manager.set_lcd_override(enabled)
                return {
                    "success": success,
                    "data": {"enabled": enabled} if success else None,
                    "error": "Failed to set LCD override" if not success else None
                }

            elif command == "set_usb_charging":
                # Check if feature is available
                if "usb_charging" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "USB charging control is not supported on this device"
                    }

                level = params.get("level", 0)
                success = self.manager.set_usb_charging(level)
                return {
                    "success": success,
                    "data": {"level": level} if success else None,
                    "error": "Failed to set USB charging" if not success else None
                }

            elif command == "set_per_zone_mode":
                # Check if feature is available
                if "per_zone_mode" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Per-zone keyboard mode is not supported on this device"
                    }

                zone1 = params.get("zone1", "000000")
                zone2 = params.get("zone2", "000000")
                zone3 = params.get("zone3", "000000")
                zone4 = params.get("zone4", "000000")
                brightness = params.get("brightness", 100)
                success = self.manager.set_per_zone_mode(zone1, zone2, zone3, zone4, brightness)
                if success:
                    save_lighting("per_zone", {
                        "zone1": zone1, "zone2": zone2, "zone3": zone3,
                        "zone4": zone4, "brightness": brightness,
                    })
                return {
                    "success": success,
                    "data": {
                        "zone1": zone1,
                        "zone2": zone2,
                        "zone3": zone3,
                        "zone4": zone4,
                        "brightness": brightness
                    } if success else None,
                    "error": "Failed to set per-zone mode" if not success else None
                }

            elif command == "set_four_zone_mode":
                # Check if feature is available
                if "four_zone_mode" not in self.manager.available_features:
                    return {
                        "success": False,
                        "error": "Four-zone keyboard mode is not supported on this device"
                    }

                mode = params.get("mode", 0)
                speed = params.get("speed", 0)
                brightness = params.get("brightness", 100)
                direction = params.get("direction", 1)
                red = params.get("red", 0)
                green = params.get("green", 0)
                blue = params.get("blue", 0)
                success = self.manager.set_four_zone_mode(mode, speed, brightness, direction, red, green, blue)
                if success:
                    save_lighting("four_zone", {
                        "mode": mode, "speed": speed, "brightness": brightness,
                        "direction": direction,
                        "red": red, "green": green, "blue": blue,
                    })
                return {
                    "success": success,
                    "data": {
                        "mode": mode,
                        "speed": speed,
                        "brightness": brightness,
                        "direction": direction,
                        "red": red,
                        "green": green,
                        "blue": blue
                    } if success else None,
                    "error": "Failed to set four-zone mode" if not success else None
                }

            elif command == "get_supported_features":
                return {
                    "success": True,
                    "data": {
                        "available_features": list(self.manager.available_features),
                        "laptop_type": self.manager.laptop_type.name,
                        "has_four_zone_kb": self.manager.has_four_zone_kb
                    }
                }

            elif command == "get_version":
                return {
                    "success": True,
                    "data": {
                        "version": VERSION
                    }
                }
            
            # Force Models and Features
            elif command == "force_nitro_model":
                # Force Nitro model into driver
                success = self.manager._force_model_nitro()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully forced Nitro model into driver"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to force Nitro model into driver"
                    }
                
            elif command == "force_predator_model":
                # Force Predator model into driver
                success = self.manager._force_model_predator()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully forced Predator model into driver"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to force Predator model into driver (Model may not support it)"
                    }

            elif command == "force_enable_all":
                # Force Enable All Features into driver
                success = self.manager._force_enable_all()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully forced all features into driver"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to force all features into driver (Model may not support it)"
                    }
                
            elif command == "get_modprobe_parameter":
                print (self.manager.get_modprobe_parameter())
                return {
                    "success": True,
                    "data": {
                        "parameter": self.manager.get_modprobe_parameter()
                    }
                }

            # Force Model and Parameters Permanantly
            elif command == "set_modprobe_parameter_predator":
                # Don't get parameter from params, use the specific value
                success = self.manager.set_modprobe_parameter("predator_v4")
                if success:
                    return {
                        "success": True,
                        "data": {"parameter": "predator_v4"}
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to set modprobe parameter to predator_v4"
                    }

            elif command == "set_modprobe_parameter_nitro":
                success = self.manager.set_modprobe_parameter("nitro_v4")
                if success:
                    return {
                        "success": True,
                        "data": {"parameter": "nitro_v4"}
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to set modprobe parameter to nitro_v4"
                    }

            elif command == "set_modprobe_parameter_enable_all":
                success = self.manager.set_modprobe_parameter("enable_all")
                if success:
                    return {
                        "success": True,
                        "data": {"parameter": "enable_all"}
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to set modprobe parameter to enable_all"
                    }

            elif command == "remove_modprobe_parameter":
                success = self.manager._remove_modprobe_parameter()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully removed modprobe parameter"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to remove modprobe parameter"
                    }
            
            elif command == "restart_daemon":
                # Force Nitro model into driver
                success = self.manager._restart_daemon()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully restarted NitroSense service"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to Restart NitroSense service (Check logs for details)"
                    }           

            elif command == "restart_drivers_and_daemon":
                # Restart linuwu-sense driver and NitroSense service service
                success = self.manager._restart_drivers_and_daemon()
                if success:
                    return {
                        "success": True,
                        "message": "Successfully restarted drivers and daemon"
                    }
                else:
                    return {
                        "success": False,
                        "error": "Failed to restart drivers and daemon"
                    }
            else:
                return {
                    "success": False,
                    "error": f"Unknown command: {command}"
                }

        except Exception as e:
            log.error(f"Error processing command {command}: {e}")
            log.error(traceback.format_exc())
            return {
                "success": False,
                "error": str(e)
            }


class NitroSenseDaemon:
    """Main daemon class that manages the lifecycle"""

    def __init__(self):
        self.running = False
        self.manager = None
        self.server = None
        self.config = None

    def load_config(self):
        """Load configuration from file"""
        config = configparser.ConfigParser()

        # Create default config if it doesn't exist
        if not os.path.exists(CONFIG_PATH):
            log.info(f"Creating default config at {CONFIG_PATH}")
            config['General'] = {
                'LogLevel': 'INFO',
                'AutoDetectFeatures': 'True'
            }

            # Create config directory if it doesn't exist
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)

            # Write default config
            with open(CONFIG_PATH, 'w') as f:
                config.write(f)
        else:
            # Load existing config
            config.read(CONFIG_PATH)

        self.config = config

        # Set log level from config
        if 'General' in config and 'LogLevel' in config['General']:
            log_level = config['General']['LogLevel'].upper()
            if log_level in ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'):
                #log.setLevel(getattr(logging, log_level))
                log.setLevel(logging.DEBUG)
                
                log.info(f"Log level set to {log_level}")

        return config

    def setup(self):
        """Set up the daemon"""
        # Load configuration first
        self.load_config()

        try:
            # Initialize HardwareManager
            self.manager = HardwareManager()
            log.info(f"Driver Version: {self.manager.get_driver_version()}")

            # Initialize keyboard monitor early
            # self.keyboard_monitor = KeyboardMonitor(
            #     target_keycode=425, 
            #     command_to_run="nitrosense",  # Updated command
            #     logger=log
            # )
            # kb_success = self.keyboard_monitor.start_monitoring()
            
            # if not kb_success:
            #     log.error("Failed to start keyboard monitoring")
            #     # Don't return False here - continue with reduced functionality

            # Initialize power monitor (started in run())
            self.power_monitor = PowerSourceDetector(self.manager)

            # Log detected features
            features_str = ", ".join(sorted(self.manager.available_features))
            log.info(f"Detected features: {features_str}")

            # After the features are known, so the setters can refuse cleanly
            # on a machine where the hardware is not there at all.
            restore_lighting(self.manager)
            restore_fan(self.manager)
            # Governor and EPP only. The fan duty that came with the mode was
            # written through set_fan_speed at the time, so fan.json already
            # holds it and restore_fan above has put it back.
            restore_power_mode()

            return True
        except Exception as e:
            log.error(f"Failed to set up daemon: {e}")
            log.error(traceback.format_exc())
            return False
    


    def run(self):
        """Run the daemon"""
        # Write PID file
        with open(PID_FILE, 'w') as f:
            f.write(str(os.getpid()))

        # Set up signal handlers
        signal.signal(signal.SIGTERM, self.signal_handler)
        signal.signal(signal.SIGINT, self.signal_handler)

        # if self.keyboard_monitor:
        #     success = self.keyboard_monitor.start_monitoring()
        #     if success:
        #         log.info("Keyboard monitoring started successfully")
        #     else:
        #         log.warning("Failed to start keyboard monitoring")

        # Set up and run the server
        try:
            self.running = True
            self.server = DaemonServer(self.manager)
            self.power_monitor.start_monitoring()
            self.server.start()
            # Start keyboard monitoring
            
        except Exception as e:
            log.error(f"Error running daemon: {e}")
            log.error(traceback.format_exc())
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        log.info("Cleaning up resources...")
    
        # Stop server and clean up socket
        if self.server:
            self.server.stop()
            self.server.cleanup_socket()  # Additional cleanup
            # Stop keyboard monitoring
        # if hasattr(self, 'keyboard_monitor') and self.keyboard_monitor:
        #     self.keyboard_monitor.stop_monitoring()
        #     log.info("Keyboard monitoring stopped")
    
        if self.power_monitor:
            self.power_monitor.stop_monitoring()
    
        # Remove PID file
        try:
            if os.path.exists(PID_FILE):
                os.unlink(PID_FILE)
        except:
            pass
    
        log.info("Daemon stopped")

    def signal_handler(self, sig, frame):
        """Handle termination signals"""
        log.info(f"Received signal {sig}, shutting down...")
        self.running = False
        if self.server:
            self.server.running = False

def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(description="NitroSense service")
    parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose logging")
    parser.add_argument('--version', action='version', version=f"NitroSense service v{VERSION}")
    parser.add_argument('--debug', action='store_true', help="Enable debug mode")
    parser.add_argument('--config', type=str, help=f"Path to config file (default: {CONFIG_PATH})")
    return parser.parse_args()

def signal_handler(self, sig, frame):
    """Handle termination signals"""
    log.info(f"Received signal {sig}, shutting down...")
    self.running = False
    if self.server:
        self.server.running = False
    # Ensure socket is cleaned up
    if hasattr(self, 'server') and self.server:
        self.server.cleanup_socket()

def main():
    """Main function"""
    args = parse_args()

    # Set log level based on verbosity
    if args.verbose:
        log.setLevel(logging.DEBUG)
        log.debug("Debug logging enabled")

    # Use custom config path if provided
    global CONFIG_PATH
    if args.config:
        CONFIG_PATH = args.config

    daemon = NitroSenseDaemon()
    if daemon.setup():
        daemon.run()
    else:
        log.error("Failed to set up daemon, exiting...")
        sys.exit(1)

    


if __name__ == "__main__":
    main()