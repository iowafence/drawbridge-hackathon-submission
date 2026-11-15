import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import awx_client
from awx_client import (BASE, AwxRuntimeError, PermissionBoundaryError, ReadOnlyClient, SetupClient)

SENT = {"read": ("rd-id-SENTINEL", "rd-key-SENTINEL"), "setup": ("su-id-SENTINEL", "su-key-SENTINEL")}
FIXED_CODES = {getattr(awx_client, n) for n in dir(awx_client) if n.startswith("E_")}


def env_file(directory, role, **over):
    prefix = "AWX_READ_" if role == "read" else "AWX_SETUP_"
    values = {"AWX_ENV": "sandbox", "AWX_BASE_URL": BASE,
              prefix + "CLIENT_ID": SENT[role][0], prefix + "API_KEY": SENT[role][1]}
    values.update(over)
    path = Path(directory) / f".env.{role}"
    path.write_text("\n".join(f"{k}={v}" for k, v in values.items()) + "\n")
    os.chmod(path, 0o600)
    return path


class FakeResponse:
    def __init__(self, status, body):
        self.status, self._body = status, json.dumps(body).encode()

    def read(self, *a):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env = env_file(self._tmp.name, "read")
        self.env_setup = env_file(self._tmp.name, "setup")
        self.calls = []

        def fake_urlopen(req, timeout=None):
            self.calls.append((req.get_method(), req.full_url))
            if req.full_url.endswith("/authentication/login"):
                return FakeResponse(201, {"token": "TOKEN-SENTINEL"})
            return FakeResponse(200, {"items": []})
        patcher = mock.patch("urllib.request.urlopen", fake_urlopen)
        patcher.start()
        self.addCleanup(patcher.stop)


COMMON_REJECTED = [("POST", "/transfers/create"), ("POST", "/beneficiaries/create"),
                   ("POST", "/simulation/deposit/create"), ("POST", "/global_accounts/create"),
                   ("POST", "/beneficiaries/verify_account"), ("POST", "/authentication/login"),
                   ("PUT", "/beneficiaries"), ("DELETE", "/beneficiaries"), ("PATCH", "/global_accounts"),
                   ("GET", "/transfers"), ("GET", "/beneficiaries?page=1"), ("GET", "/../transfers"),
                   ("GET", "https://api.airwallex.com/api/v1/global_accounts"),
                   ("POST", "https://api.airwallex.com/api/v1/transfers/create"),
                   ("GET", "//api.airwallex.com/global_accounts"), ("get", "/global_accounts"), ("GET", None),
                   ("GET", "/global_accounts/7559d432-0605-44bd-844e-d36708aeff7d")]


class ReadOnlyBoundary(Base):
    def test_rejects_before_any_network_request(self):
        client = ReadOnlyClient(self.env)
        for method, path in COMMON_REJECTED + [("POST", "/beneficiaries/validate"),
                                               ("POST", "/beneficiary_api_schemas/generate")]:
            with self.subTest(method=method, path=path):
                with self.assertRaises(PermissionBoundaryError):
                    client._request(method, path, {})
        self.assertEqual(self.calls, [])

    def test_allowed_gets_and_login_is_sole_post(self):
        client = ReadOnlyClient(self.env)
        client.global_accounts()
        client.current_balances()
        client.beneficiaries()
        self.assertEqual([m for m, _ in self.calls], ["POST", "GET", "GET", "GET"])
        self.assertTrue(self.calls[0][1].endswith("/authentication/login"))
        self.assertTrue(all(url.startswith(BASE) for _, url in self.calls))

    def test_existing_read_authentication_still_works(self):
        status, body = ReadOnlyClient(self.env).global_accounts()
        self.assertEqual((status, body), (200, {"items": []}))

    def test_no_general_or_write_interface(self):
        public = {n for n in dir(ReadOnlyClient) if not n.startswith("_")}
        self.assertEqual(public, {"global_accounts", "current_balances", "beneficiaries"})
        self.assertFalse(hasattr(awx_client, "Client"))

    def test_production_configuration_refused_before_network(self):
        for over in ({"AWX_ENV": "production"}, {"AWX_BASE_URL": "https://api.airwallex.com/api/v1"}):
            with self.assertRaises(PermissionBoundaryError):
                ReadOnlyClient(env_file(self._tmp.name, "read", **over))
        self.assertEqual(self.calls, [])


class SetupBoundary(Base):
    def test_account_creation_denied_in_ordinary_setup(self):
        client = SetupClient(self.env_setup)
        for method, path in (("POST", "/global_accounts/create"), ("GET", "/global_accounts"),
                             ("GET", "/global_accounts/7559d432-0605-44bd-844e-d36708aeff7d")):
            with self.subTest(method=method, path=path):
                with self.assertRaises(PermissionBoundaryError):
                    client._request(method, path, {})
        self.assertFalse(hasattr(client, "create_global_account"))
        self.assertEqual(self.calls, [])

    def test_rejects_everything_outside_schema_and_validate(self):
        client = SetupClient(self.env_setup)
        for method, path in COMMON_REJECTED + [("GET", "/balances/current"), ("GET", "/beneficiaries")]:
            with self.subTest(method=method, path=path):
                with self.assertRaises(PermissionBoundaryError):
                    client._request(method, path, {})
        self.assertEqual(self.calls, [])

    def test_allowed_setup_operations(self):
        client = SetupClient(self.env_setup)
        client.generate_beneficiary_schema({})
        client.validate_beneficiary({})
        self.assertEqual([u.removeprefix(BASE) for _, u in self.calls],
                         ["/authentication/login", "/beneficiary_api_schemas/generate", "/beneficiaries/validate"])

    def test_public_surface(self):
        public = {n for n in dir(SetupClient) if not n.startswith("_")}
        self.assertEqual(public, {"generate_beneficiary_schema", "validate_beneficiary"})


UNUSUAL = ["SECRET-PATH-SENTINEL", "/x/SECRET-PATH-SENTINEL", "https://user:pw-SENTINEL@evil.example/a?token=SENTINEL",
           "Bearer abc.SENTINEL.def", "line\nbreak-SENTINEL\r\n", "päth-ünï-SENTINEL-‮", "%2e%2e/SENTINEL",
           "A" * 5000 + "SENTINEL", "\x00SENTINEL", "{SENTINEL}", "${SENTINEL}", "x-api-key: SENTINEL", b"bytes-SENTINEL",
           ("tuple", "SENTINEL"), {"k": "SENTINEL"}, 123456789, None]


class DiagnosticsAreFixed(Base):
    def test_rejection_never_reflects_input(self):
        for client in (ReadOnlyClient(self.env), SetupClient(self.env_setup)):
            for bad in UNUSUAL:
                for method, path in ((bad, "/global_accounts"), ("GET", bad), (bad, bad), ("POST", bad)):
                    with self.subTest(client=type(client).__name__, method=repr(method)[:20], path=repr(path)[:20]):
                        with self.assertRaises(PermissionBoundaryError) as ctx:
                            client._request(method, path, {"body": "BODY-SENTINEL"})
                        self.assertEqual(str(ctx.exception), awx_client.E_DENIED)
                        self.assertEqual(ctx.exception.args, (awx_client.E_DENIED,))
                        self.assertNotIn("SENTINEL", repr(ctx.exception) + str(ctx.exception.__cause__))
        self.assertEqual(self.calls, [])

    def test_configuration_inputs_never_reflected(self):
        cases = {"AWX_ENV": "prod-SENTINEL", "AWX_BASE_URL": "https://user:pw-SENTINEL@prod.example/v1"}
        for key, value in cases.items():
            with self.assertRaises(PermissionBoundaryError) as ctx:
                ReadOnlyClient(env_file(self._tmp.name, "read", **{key: value}))
            self.assertIn(str(ctx.exception), FIXED_CODES)
            self.assertNotIn("SENTINEL", str(ctx.exception) + repr(ctx.exception))

    def test_path_arguments_never_reflected(self):
        for name in ("SECRET-PATH-SENTINEL", ".env", ".env.executor", ".env.setup"):
            with self.assertRaises(PermissionBoundaryError) as ctx:
                ReadOnlyClient(Path(self._tmp.name) / name)
            self.assertEqual(str(ctx.exception), awx_client.E_CRED_NAME)
        with self.assertRaises(AwxRuntimeError) as ctx:
            ReadOnlyClient(Path(self._tmp.name) / "SENTINEL-dir" / ".env.read")
        self.assertEqual(str(ctx.exception), awx_client.E_CRED_MISSING)
        self.assertIsNone(ctx.exception.__context__)

    def test_operational_errors_are_fixed_codes_without_secrets(self):
        secrets = [s for pair in SENT.values() for s in pair] + ["TOKEN-SENTINEL"]
        texts = [repr(ReadOnlyClient(self.env)), repr(SetupClient(self.env_setup))]
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError(ConnectionError("SENTINEL-host"))):
            with self.assertRaises(AwxRuntimeError) as ctx:
                ReadOnlyClient(self.env).global_accounts()
            self.assertEqual(str(ctx.exception), awx_client.E_NETWORK)
            self.assertIsNone(ctx.exception.__cause__)
            self.assertIsNone(ctx.exception.__context__)
            texts.append(repr(ctx.exception))
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(401, {"message": "bad SENTINEL"})):
            with self.assertRaises(AwxRuntimeError) as ctx:
                ReadOnlyClient(self.env).global_accounts()
            self.assertEqual(str(ctx.exception), awx_client.E_LOGIN)
            texts.append(repr(ctx.exception))
        for text in texts:
            for secret in secrets:
                self.assertNotIn(secret, text)
            self.assertNotIn("SENTINEL-host", text)

    def test_http_error_bodies_are_filtered(self):
        raw = {"code": "validation_failed", "source": "beneficiary.bank_details", "message": "echo SECRET-SENTINEL",
               "details": [{"value": "SECRET-SENTINEL"}], "trace": "SECRET-SENTINEL"}

        def urlopen(req, timeout=None):
            if req.full_url.endswith("/authentication/login"):
                return FakeResponse(201, {"token": "t"})
            raise urllib.error.HTTPError(req.full_url, 400, "bad", {}, __import__("io").BytesIO(json.dumps(raw).encode()))
        with mock.patch("urllib.request.urlopen", urlopen):
            status, body = SetupClient(self.env_setup).validate_beneficiary({})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"code": "validation_failed", "source": "beneficiary.bank_details"})

    def test_missing_credentials_message_has_no_values(self):
        with self.assertRaises(AwxRuntimeError) as ctx:
            ReadOnlyClient(env_file(self._tmp.name, "read", AWX_READ_API_KEY=""))
        self.assertEqual(str(ctx.exception), awx_client.E_CRED_INCOMPLETE)


if __name__ == "__main__":
    unittest.main()
