#!/usr/bin/env python3
"""One-time YouTube authorization for the faceless-video Worker.

Run from the worker/ folder (with Node/npx available):
    python3 ../tools/yt_auth.py

It asks for your OAuth client ID and secret (secret is hidden), opens a Google
sign-in on this machine, then stores YT_CLIENT_ID, YT_CLIENT_SECRET and
YT_REFRESH_TOKEN as Cloudflare Worker secrets. Nothing secret is printed.
"""
import getpass, http.server, json, secrets, subprocess, sys, threading, urllib.parse, urllib.request, webbrowser

SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"  # upload + read view/like/comment counts
client_id = input("OAuth client ID: ").strip()
client_secret = getpass.getpass("OAuth client secret (hidden): ").strip()

state = secrets.token_urlsafe(16)
result = {}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if q.get("state", [""])[0] == state and "code" in q:
            result["code"] = q["code"][0]
            msg = b"Authorized. You can close this tab and return to the terminal."
        else:
            result["error"] = q.get("error", ["unknown"])[0]
            msg = b"Authorization failed. Return to the terminal."
        self.send_response(200); self.send_header("content-type", "text/plain"); self.end_headers(); self.wfile.write(msg)
    def log_message(self, *a): pass

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
redirect = f"http://127.0.0.1:{srv.server_port}"
url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id": client_id, "redirect_uri": redirect, "response_type": "code",
    "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": state})
print("\nOpen this link if a browser does not open by itself:\n" + url + "\n")
webbrowser.open(url)
t = threading.Thread(target=srv.handle_request); t.start(); t.join(300)
if "code" not in result:
    sys.exit("No authorization received: " + result.get("error", "timed out"))

data = urllib.parse.urlencode({"code": result["code"], "client_id": client_id, "client_secret": client_secret,
                               "redirect_uri": redirect, "grant_type": "authorization_code"}).encode()
try:
    tok = json.load(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=data)))
except Exception as e:
    sys.exit(f"Token exchange failed: {e}")
if "refresh_token" not in tok:
    sys.exit("Google returned no refresh token. Remove the app at myaccount.google.com/permissions and run again.")

for name, value in (("YT_CLIENT_ID", client_id), ("YT_CLIENT_SECRET", client_secret), ("YT_REFRESH_TOKEN", tok["refresh_token"])):
    r = subprocess.run(["npx", "wrangler", "secret", "put", name], input=value, text=True, capture_output=True)
    print(("OK   " if r.returncode == 0 else "FAIL ") + name)
    if r.returncode: print(r.stderr[-400:])
print("Done. YouTube is now configured; the Worker skips it only when these are missing.")
