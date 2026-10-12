"""Exercise daemon methods without importing root-only logging or touching hardware."""
import ast
import logging
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

SOURCE = Path(__file__).resolve().parents[1] / 'service/nitrosense-daemon.py'


def load_class(name, **overrides):
    tree = ast.parse(SOURCE.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), cls], type_ignores=[])
    namespace = {'log': logging.getLogger('test'), **overrides}
    exec(compile(ast.fix_missing_locations(module), str(SOURCE), 'exec'), namespace)
    return namespace[name]


class ServiceOptionsTests(unittest.TestCase):
    def test_driver_commands_rejected_before_manager(self):
        cls = load_class('DaemonServer', ALLOW_DRIVER_RECONFIGURE=False)
        server = cls.__new__(cls)
        server.manager = Mock()
        for command in ('force_enable_all', 'set_modprobe_parameter_nitro', 'remove_modprobe_parameter', 'restart_drivers_and_daemon'):
            self.assertFalse(server.process_command(command, {})['success'])
        self.assertEqual(server.manager.mock_calls, [])

    def test_reads_still_work(self):
        cls = load_class('DaemonServer', ALLOW_DRIVER_RECONFIGURE=False)
        server = cls.__new__(cls)
        server.manager = Mock()
        server.manager.get_all_settings.return_value = {'battery_limiter': '1'}
        self.assertEqual(server.process_command('get_all_settings', {})['data'], {'battery_limiter': '1'})

    def test_startup_restore_is_opt_in_for_packaged_unit(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                manager = SimpleNamespace(get_driver_version=lambda: 'test', available_features=set())
                lighting, fan, power = Mock(), Mock(), Mock()
                cls = load_class('NitroSenseDaemon', RESTORE_SETTINGS=enabled,
                    HardwareManager=lambda: manager, PowerSourceDetector=lambda m: None,
                    restore_lighting=lighting, restore_fan=fan, restore_power_mode=power)
                daemon = cls.__new__(cls)
                daemon.load_config = lambda: None
                self.assertTrue(daemon.setup())
                self.assertEqual(lighting.call_count, int(enabled))
                self.assertEqual(fan.call_count, int(enabled))
                self.assertEqual(power.call_count, int(enabled))
