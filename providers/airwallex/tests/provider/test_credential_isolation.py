import builtins
import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import awx_client
import run_readonly_preflight
from awx_client import (BASE, AwxRuntimeError, PermissionBoundaryError, ReadOnlyClient, SetupClient,
                        load_role_env, role_env_path)

S = {"read": ("R-ID-SENT", "R-KEY-SENT"), "setup": ("S-ID-SENT", "S-KEY-SENT"), "exec": ("X-ID-SENT", "X-KEY-SENT")}
COMMON = {"AWX_ENV": "sandbox", "AWX_BASE_URL": BASE}


def write(path, mode=0o600, **kv):
    path.write_text("\n".join(f"{k}={v}" for k, v in kv.items()) + "\n")
    os.chmod(path, mode)


def role_files(directory):
    d = Path(directory)
    write(d / ".env.read", **COMMON, AWX_READ_CLIENT_ID=S["read"][0], AWX_READ_API_KEY=S["read"][1])
    write(d / ".env.setup", **COMMON, AWX_SETUP_CLIENT_ID=S["setup"][0], AWX_SETUP_API_KEY=S["setup"][1])
    write(d / ".env.executor", AWX_EXECUTOR_CLIENT_ID=S["exec"][0], AWX_EXECUTOR_API_KEY=S["exec"][1])
    write(d / ".env", **COMMON, AWX_READ_CLIENT_ID=S["read"][0], AWX_READ_API_KEY=S["read"][1],
          AWX_SETUP_CLIENT_ID=S["setup"][0], AWX_SETUP_API_KEY=S["setup"][1],
          AWX_EXECUTOR_CLIENT_ID=S["exec"][0], AWX_EXECUTOR_API_KEY=S["exec"][1])


class Spy:
    """Record every file name opened under the credential directory while `build` runs."""

    def __init__(self, directory):
        self.dir, self.opened = str(directory), []

    def run(self, build):
        real_open, real_read_text, real_stat = builtins.open, Path.read_text, Path.stat

        def note(p):
            if str(p).startswith(self.dir):
                self.opened.append(Path(str(p)).name)

        def spy_open(file, *a, **k):
            note(file)
            return real_open(file, *a, **k)

        def spy_read_text(path, *a, **k):
            note(path)
            return real_read_text(path, *a, **k)
        with mock.patch("builtins.open", spy_open), mock.patch.object(Path, "read_text", spy_read_text):
            try:
                build()
            except Exception as exc:  # outcome asserted by caller via opened-files only
                self.error = exc
        return set(self.opened)


class RoleIsolation(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        role_files(self.dir)
        patch = mock.patch.object(awx_client, "ROOT", self.dir)
        patch.start()
        self.addCleanup(patch.stop)

    def test_read_client_opens_only_read_file(self):
        self.assertEqual(Spy(self.dir).run(ReadOnlyClient), {".env.read"})

    def test_setup_client_opens_only_setup_file(self):
        self.assertEqual(Spy(self.dir).run(SetupClient), {".env.setup"})

    def test_read_mode_never_touches_setup_or_executor_or_combined(self):
        opened = Spy(self.dir).run(lambda: (ReadOnlyClient(), ReadOnlyClient(self.dir / ".env.read")))
        self.assertTrue(opened <= {".env.read"})
        self.assertFalse(opened & {".env.setup", ".env.executor", ".env"})

    def test_setup_mode_never_touches_executor_or_combined(self):
        opened = Spy(self.dir).run(lambda: SetupClient())
        self.assertFalse(opened & {".env.executor", ".env", ".env.read"})

    def test_wrong_file_names_refused_before_any_open(self):
        for role, cls in (("read", ReadOnlyClient), ("setup", SetupClient)):
            for name in (".env", ".env.executor", ".env.setup" if role == "read" else ".env.read", "other"):
                spy = Spy(self.dir)
                opened = spy.run(lambda: cls(self.dir / name))
                self.assertEqual(opened, set(), (role, name))
                self.assertIsInstance(spy.error, PermissionBoundaryError)
                self.assertEqual(str(spy.error), awx_client.E_CRED_NAME)

    def test_loader_has_no_executor_role_or_default_combined_path(self):
        self.assertEqual(set(awx_client._ROLE_KEYS), {"read", "setup"})
        self.assertEqual([role_env_path(r).name for r in ("read", "setup")], [".env.read", ".env.setup"])
        source = Path(awx_client.__file__).read_text()
        self.assertNotIn("EXECUTOR_CLIENT_ID", source)
        self.assertNotIn("EXECUTOR_API_KEY", source)
        with self.assertRaises(PermissionBoundaryError):
            load_role_env(self.dir / ".env.executor", "read")

    def test_contaminated_role_file_refused(self):
        write(self.dir / ".env.read", AWX_ENV="sandbox", AWX_READ_CLIENT_ID="a", AWX_READ_API_KEY="b", AWX_SETUP_CLIENT_ID="c")
        with self.assertRaises(PermissionBoundaryError) as ctx:
            ReadOnlyClient()
        self.assertEqual(str(ctx.exception), awx_client.E_CRED_MIX)
        write(self.dir / ".env.setup", AWX_ENV="sandbox", AWX_SETUP_CLIENT_ID="a", AWX_SETUP_API_KEY="b", AWX_EXECUTOR_API_KEY="c")
        with self.assertRaises(PermissionBoundaryError) as ctx:
            SetupClient()
        self.assertEqual(str(ctx.exception), awx_client.E_CRED_MIX)

    def test_loose_permissions_refused_before_read(self):
        for mode in (0o640, 0o604, 0o644, 0o660):
            os.chmod(self.dir / ".env.read", mode)
            spy = Spy(self.dir)
            self.assertEqual(spy.run(ReadOnlyClient), set(), oct(mode))
            self.assertEqual(str(spy.error), awx_client.E_CRED_PERMS)

    def test_missing_role_file_does_not_fall_back(self):
        (self.dir / ".env.read").unlink()
        spy = Spy(self.dir)
        self.assertEqual(spy.run(ReadOnlyClient), set())
        self.assertIsInstance(spy.error, AwxRuntimeError)
        self.assertEqual(str(spy.error), awx_client.E_CRED_MISSING)

    def test_loaded_values_belong_to_role_only(self):
        read = load_role_env(self.dir / ".env.read", "read")
        setup = load_role_env(self.dir / ".env.setup", "setup")
        self.assertEqual(read["AWX_READ_CLIENT_ID"], S["read"][0])
        self.assertEqual(setup["AWX_SETUP_CLIENT_ID"], S["setup"][0])
        self.assertFalse(any(k.startswith(("AWX_SETUP_", "AWX_EXECUTOR_")) for k in read))
        self.assertFalse(any(k.startswith(("AWX_READ_", "AWX_EXECUTOR_")) for k in setup))
        for client in (ReadOnlyClient(), SetupClient()):
            self.assertNotIn("X-ID-SENT", json.dumps(vars(client), default=str))
            self.assertNotIn("X-KEY-SENT", json.dumps(vars(client), default=str))

    def test_preflight_wrapper_child_env_is_read_only_scoped(self):
        with mock.patch.dict(os.environ, {"AWX_SETUP_API_KEY": "leak", "AWX_EXECUTOR_API_KEY": "leak",
                                          "AWX_READ_API_KEY": "leak", "KEEP_ME": "1"}):
            env = run_readonly_preflight.child_env(self.dir / ".env.read")
        self.assertEqual(env["AWX_SANDBOX_CLIENT_ID"], S["read"][0])
        self.assertEqual(env["KEEP_ME"], "1")
        self.assertEqual({k for k in env if k.startswith("AWX_")}, {"AWX_SANDBOX_CLIENT_ID", "AWX_SANDBOX_API_KEY"})
        self.assertNotIn("leak", json.dumps(env))

    def test_preflight_wrapper_refuses_other_files(self):
        for name in (".env", ".env.setup", ".env.executor"):
            with self.assertRaises(PermissionBoundaryError):
                run_readonly_preflight.child_env(self.dir / name)


class ZeroNetworkOnRejection(unittest.TestCase):
    CASES = [("POST", "/transfers/create"), ("POST", "/beneficiaries/create"), ("POST", "/simulation/deposit/create"),
             ("POST", "/global_accounts/create"), ("POST", "/beneficiaries/verify_account"),
             ("POST", "https://api.airwallex.com/api/v1/transfers/create"), ("GET", "/transfers"),
             ("DELETE", "/beneficiaries"), ("GET", "https://api.airwallex.com/api/v1/global_accounts")]

    def test_no_urlopen_no_login_on_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            role_files(tmp)
            clients = (ReadOnlyClient(Path(tmp) / ".env.read"), SetupClient(Path(tmp) / ".env.setup"))
            with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network used")) as net:
                for client in clients:
                    for method, path in self.CASES:
                        with self.subTest(client=type(client).__name__, method=method, path=path):
                            with self.assertRaises(PermissionBoundaryError):
                                client._request(method, path, {})
                self.assertEqual(net.call_count, 0)
                for over in ({"AWX_ENV": "production"}, {"AWX_BASE_URL": "https://api.airwallex.com/api/v1"}):
                    write(Path(tmp) / ".env.read", **{**COMMON, **over}, AWX_READ_CLIENT_ID="a", AWX_READ_API_KEY="b")
                    with self.assertRaises(PermissionBoundaryError):
                        ReadOnlyClient(Path(tmp) / ".env.read")
                self.assertEqual(net.call_count, 0)


class ProjectCredentialFiles(unittest.TestCase):
    """Checks the real project files by mode and key NAMES only; values are never read into assertions."""

    @staticmethod
    def key_names(path):
        names = set()
        for line in Path(path).read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                names.add(line.partition("=")[0].strip())
        return names

    def test_modes_and_key_separation(self):
        for role in ("read", "setup", "executor"):
            path = ROOT / f".env.{role}"
            if not path.exists():
                self.skipTest(f".env.{role} not present in this checkout")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, role)
        read, setup = self.key_names(ROOT / ".env.read"), self.key_names(ROOT / ".env.setup")
        self.assertEqual(read, {"AWX_ENV", "AWX_BASE_URL", "AWX_READ_CLIENT_ID", "AWX_READ_API_KEY"})
        self.assertEqual(setup, {"AWX_ENV", "AWX_BASE_URL", "AWX_SETUP_CLIENT_ID", "AWX_SETUP_API_KEY"})
        mode = stat.S_IMODE((ROOT / ".env.executor").stat().st_mode)
        executor_names = self.key_names(ROOT / ".env.executor")
        self.assertEqual(executor_names, {"AWX_EXECUTOR_CLIENT_ID", "AWX_EXECUTOR_API_KEY"})
        self.assertEqual(mode, 0o600)

    def test_scripts_do_not_reference_combined_file_or_executor_names(self):
        for path in (ROOT / "scripts").glob("*.py"):
            text = path.read_text()
            self.assertNotRegex(text, r'["\']\.env["\']', path.name)
            self.assertNotIn("_env()", text, path.name)
            self.assertNotIn("EXECUTOR_CLIENT_ID", text, path.name)
            self.assertNotIn("EXECUTOR_API_KEY", text, path.name)


if __name__ == "__main__":
    unittest.main()
