import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cloud_call import sign

pid = os.environ.get("HW_PROJECT_ID", "REPLACE_WITH_YOUR_PROJECT_ID")
name = sys.argv[1] if len(sys.argv) > 1 else "ai-story-diag-tf"
urn = "urn:fss:cn-north-4:%s:function:default:%s:latest" % (pid, name)
host = "functiongraph.cn-north-4.myhuaweicloud.com"
payload = sys.argv[2] if len(sys.argv) > 2 else "{}"
body = json.loads(payload)
url, headers, signed_payload = sign("POST", host, "/v2/%s/fgs/functions/%s/invocations" % (pid, urn), body)
cmd = ["curl", "-sS", "-m", "110", "-X", "POST", url]
for k, v in headers.items():
    cmd += ["-H", f"{k}: {v}"]
cmd += ["--data-binary", signed_payload]
env = dict(os.environ, MSYS_NO_PATHCONV="1")
out = subprocess.run(cmd, capture_output=True, text=True, env=env)
txt = out.stdout + out.stderr
print("rc=", out.returncode)
try:
    j = json.loads(txt)
    b = j.get("body")
    if isinstance(b, str):
        try:
            b = json.loads(b)
        except Exception:
            pass
    if b:
        print(json.dumps(b, ensure_ascii=False, indent=1)[:20000])
    else:
        print("NO_BODY keys=", list(j.keys()))
        print(txt[:3000])
except Exception as e:
    print("RAW:", txt[:3000])
