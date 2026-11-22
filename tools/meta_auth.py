#!/usr/bin/env python3
"""Turn a short-lived Graph Explorer user token into a never-expiring Page token
and store it as the Worker secret META_TOKEN. Nothing secret is printed.

Run from worker/:  python3 ../tools/meta_auth.py
"""
import getpass, json, subprocess, sys, urllib.parse, urllib.request

APP_ID = "1849989316134935"
PAGE_ID = "1494309847093140"
G = "https://graph.facebook.com/v21.0"

def get(path, **q):
    try:
        return json.load(urllib.request.urlopen(f"{G}/{path}?" + urllib.parse.urlencode(q)))
    except urllib.error.HTTPError as e:
        sys.exit(f"Graph error on {path}: {e.read().decode()[:300]}")

user_tok = getpass.getpass("Short-lived user token (hidden): ").strip()
app_secret = getpass.getpass("App secret (hidden): ").strip()

ll = get("oauth/access_token", grant_type="fb_exchange_token", client_id=APP_ID,
         client_secret=app_secret, fb_exchange_token=user_tok)["access_token"]
pages = get("me/accounts", fields="id,name,access_token", access_token=ll)["data"]
page = next((p for p in pages if p["id"] == PAGE_ID), None)
if not page:
    sys.exit("Page not found for this token. Re-generate the token and select the Page.")
dbg = get("debug_token", input_token=page["access_token"], access_token=f"{APP_ID}|{app_secret}")["data"]
exp = dbg.get("expires_at", 0)
print("Page token expiry:", "never" if exp == 0 else exp)
r = subprocess.run(["npx", "wrangler", "secret", "put", "META_TOKEN"], input=page["access_token"],
                   text=True, capture_output=True)
print(("OK   " if r.returncode == 0 else "FAIL ") + "META_TOKEN")
if r.returncode: print(r.stderr[-400:])
