import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"service"))
from socket_policy import configure_socket

class SocketPolicyTests(unittest.TestCase):
    @patch("socket_policy.os.chmod")
    @patch("socket_policy.os.chown")
    @patch("socket_policy.grp.getgrnam", return_value=SimpleNamespace(gr_gid=456))
    def test_restricted_group(self, lookup, chown, chmod):
        configure_socket("/example/socket","nitrosense")
        lookup.assert_called_once_with("nitrosense")
        chown.assert_called_once_with("/example/socket",0,456)
        chmod.assert_called_once_with("/example/socket",0o660)
    @patch("socket_policy.os.chmod")
    @patch("socket_policy.os.chown")
    def test_legacy_default(self,chown,chmod):
        configure_socket("/example/socket")
        chown.assert_not_called()
        chmod.assert_called_once_with("/example/socket",0o666)
    @patch("socket_policy.os.chmod")
    @patch("socket_policy.grp.getgrnam",side_effect=KeyError("missing"))
    def test_missing_group_fails_closed(self,lookup,chmod):
        with self.assertRaises(KeyError):configure_socket("/example/socket","missing")
        chmod.assert_not_called()
