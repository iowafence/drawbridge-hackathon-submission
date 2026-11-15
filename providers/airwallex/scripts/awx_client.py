#!/usr/bin/env python3
"""Sandbox-only Airwallex transport with a fixed permission boundary per client.

ReadOnlyClient: allowlisted GET endpoints; the login POST is the only POST.
SetupClient:    beneficiary schema generation and validation only. No provisioning, no payment execution.
Method, path and configuration are checked before any authentication or network access.
Each client reads only its own `.env.<role>` file (exact name, owner-only permissions).
No executor client exists and executor credentials are never loaded here.
Errors carry fixed codes only; caller-supplied strings are never echoed.
"""
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.sandbox.airwallex.com/api/v1"
LOGIN = "/authentication/login"

_ROLE_KEYS = {"read": ("AWX_READ_CLIENT_ID", "AWX_READ_API_KEY"),
              "setup": ("AWX_SETUP_CLIENT_ID", "AWX_SETUP_API_KEY")}
_ENV_NAMES = ("AWX_ENV", "AWX_BASE_URL")
_OTHER_ROLE_KEY = re.compile(r"AWX_(READ|SETUP|EXECUTOR)_")

_READ_ALLOW = (("GET", "/global_accounts"), ("GET", "/balances/current"), ("GET", "/beneficiaries"))
_SETUP_ALLOW = (("POST", "/beneficiary_api_schemas/generate"), ("POST", "/beneficiaries/validate"))

E_DENIED = "AWX_E_OPERATION_DENIED"
E_ENV = "AWX_E_CONFIG_ENVIRONMENT"
E_BASE = "AWX_E_CONFIG_BASE_URL"
E_CRED_NAME = "AWX_E_CRED_FILE_NAME"
E_CRED_MISSING = "AWX_E_CRED_FILE_MISSING"
E_CRED_PERMS = "AWX_E_CRED_FILE_PERMISSIONS"
E_CRED_MIX = "AWX_E_CRED_FILE_ROLE_MIX"
E_CRED_INCOMPLETE = "AWX_E_CRED_INCOMPLETE"
E_LOGIN = "AWX_E_LOGIN_FAILED"
E_NETWORK = "AWX_E_NETWORK"


class PermissionBoundaryError(PermissionError):
    """Policy refusal. str() is a fixed code; nothing caller-supplied is included."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class AwxRuntimeError(RuntimeError):
    """Operational failure. str() is a fixed code."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def role_env_path(role, root=None):
    return Path(root or ROOT) / f".env.{role}"


def load_role_env(env_path, role):
    """Load one role's credential file. Never opens any other file name.

    Refuses a wrong file name or group/other-accessible permissions before reading, and stops
    at the first line naming another role's key (key names only are inspected).
    """
    path = Path(env_path)
    if path.name != f".env.{role}":
        raise PermissionBoundaryError(E_CRED_NAME)
    try:
        mode = path.stat().st_mode
    except OSError:
        mode = None
    if mode is None:  # raised outside the handler so no OSError (which carries the path) is chained
        raise AwxRuntimeError(E_CRED_MISSING)
    if mode & 0o077:
        raise PermissionBoundaryError(E_CRED_PERMS)
    allowed = set(_ROLE_KEYS[role]) | set(_ENV_NAMES)
    found = {}
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                if key in allowed:
                    found[key] = value.strip().strip('"').strip("'")
                elif _OTHER_ROLE_KEY.match(key):
                    raise PermissionBoundaryError(E_CRED_MIX)
    return found


class _Base:
    _ROLE = ""
    _ALLOW = ()

    def __init__(self, env_path=None):
        env = load_role_env(env_path or role_env_path(self._ROLE), self._ROLE)
        if env.get("AWX_ENV") != "sandbox":
            raise PermissionBoundaryError(E_ENV)
        if env.get("AWX_BASE_URL", BASE).rstrip("/") != BASE:
            raise PermissionBoundaryError(E_BASE)
        cid, key = (env.get(n, "") for n in _ROLE_KEYS[self._ROLE])
        if not cid or not key:
            raise AwxRuntimeError(E_CRED_INCOMPLETE)
        self._creds = {"x-client-id": cid, "x-api-key": key}
        self._token = None

    def __repr__(self):
        return f"<{type(self).__name__} sandbox>"

    def _check(self, method, path):
        if not any(method == m and path == p for m, p in self._ALLOW):
            raise PermissionBoundaryError(E_DENIED)

    def _login(self):
        status, body = self._send("POST", LOGIN, None, dict(self._creds, **{"Content-Type": "application/json"}))
        token = body.get("token") if isinstance(body, dict) else None
        if not token:
            raise AwxRuntimeError(E_LOGIN)
        self._token = token

    def _request(self, method, path, payload=None):
        self._check(method, path)
        if self._token is None:
            self._login()
        headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
        return self._send(method, path, payload, headers)

    @staticmethod
    def _error_body(body):
        """Error responses keep only short provider code/source strings; messages and details are dropped."""
        if not isinstance(body, dict):
            return {}
        return {k: body[k][:100] for k in ("code", "source") if isinstance(body.get(k), str)}

    @classmethod
    def _send(cls, method, path, payload, headers):
        data = json.dumps(payload).encode() if payload is not None else (b"" if method == "POST" else None)
        req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            try:
                body = json.load(e)
            except Exception:
                body = {}
            return e.code, cls._error_body(body)
        except urllib.error.URLError:
            pass
        raise AwxRuntimeError(E_NETWORK)  # outside the handler: the URLError (host/reason text) is not chained


class ReadOnlyClient(_Base):
    _ROLE = "read"
    _ALLOW = _READ_ALLOW

    def global_accounts(self):
        return self._request("GET", "/global_accounts")

    def current_balances(self):
        return self._request("GET", "/balances/current")

    def beneficiaries(self):
        return self._request("GET", "/beneficiaries")


class SetupClient(_Base):
    _ROLE = "setup"
    _ALLOW = _SETUP_ALLOW

    def generate_beneficiary_schema(self, body):
        return self._request("POST", "/beneficiary_api_schemas/generate", body)

    def validate_beneficiary(self, body):
        return self._request("POST", "/beneficiaries/validate", body)
