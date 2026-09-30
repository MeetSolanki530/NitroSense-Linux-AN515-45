"""Optional group-restricted IPC for distro packages; legacy default is unchanged."""
import grp
import os


def configure_socket(path, group=None):
    if not group:
        os.chmod(path, 0o666)
        return
    # Resolve before changing access; a misspelled group must fail closed.
    gid = grp.getgrnam(group).gr_gid
    os.chown(path, 0, gid)
    os.chmod(path, 0o660)
