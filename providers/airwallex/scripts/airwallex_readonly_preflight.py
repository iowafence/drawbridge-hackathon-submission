#!/usr/bin/env python3
"""Sandbox-only read access preflight; no banking writes except token login."""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://api.sandbox.airwallex.com/api/v1"
def call(path, method="GET", headers=None):
    req=urllib.request.Request(BASE+path, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{path}: HTTP {error.code}") from None

def main():
    client_id=os.environ.get("AWX_SANDBOX_CLIENT_ID","")
    api_key=os.environ.get("AWX_SANDBOX_API_KEY","")
    if not client_id or not api_key:
        print("BLOCKED: set both sandbox credentials in environment",file=sys.stderr)
        return 2
    try:
        status, auth=call("/authentication/login","POST",{
            "x-client-id":client_id,"x-api-key":api_key,"Content-Type":"application/json"})
        token=auth.get("token")
        if not token: raise RuntimeError("No token in response")
        headers={"Authorization":"Bearer "+token}
        version=os.environ.get("AWX_API_VERSION","")
        if version: headers["x-api-version"]=version
        print(json.dumps({"endpoint":"authentication/login","http_status":status,"token_returned":True}))
        for path in ("/global_accounts","/balances/current"):
            code, body=call(path,headers=headers)
            print(json.dumps({"endpoint":path,"http_status":code,
                              "response_type":type(body).__name__,
                              "top_level_keys":sorted(body.keys()) if isinstance(body,dict) else []}))
        print("READ-ONLY SANDBOX PREFLIGHT PASSED; NO BANKING WRITES")
        return 0
    except Exception as exc:
        print("PREFLIGHT BLOCKED: "+str(exc),file=sys.stderr)
        return 1
if __name__=="__main__": sys.exit(main())
