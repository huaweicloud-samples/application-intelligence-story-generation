"""把本地 zip 更新到指定 FGS 函数的代码（绕过命令行长度限制）。"""
import base64, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cloud_call import sign

PID = os.environ.get("HW_PROJECT_ID", "REPLACE_WITH_YOUR_PROJECT_ID")
HOST = "functiongraph.cn-north-4.myhuaweicloud.com"


def update(func_name, zip_path):
    urn = "urn:fss:cn-north-4:%s:function:default:%s:latest" % (PID, func_name)
    with open(zip_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = {"func_code": {"file": b64}, "code_filename": os.path.basename(zip_path), "code_type": "zip"}
    url, headers, payload = sign("PUT", HOST, "/v2/%s/fgs/functions/%s/code" % (PID, urn), body)
    bf = os.path.join(os.path.dirname(zip_path), ".payload.json")
    with open(bf, "w") as fh:
        fh.write(payload)
    cmd = ["curl", "-sS", "-m", "300", "-X", "PUT", url, "--data-binary", "@" + bf]
    for k, v in headers.items():
        cmd += ["-H", "%s: %s" % (k, v)]
    env = dict(os.environ, MSYS_NO_PATHCONV="1", MSYS2_ARG_CONV_EXCL="*")
    out = subprocess.run(cmd, capture_output=True, text=True, env=env)
    os.unlink(bf)
    txt = out.stdout + out.stderr
    try:
        j = json.loads(txt)
        return {"ok": "func_urn" in j, "size": j.get("code_size"), "err": j.get("error_msg")}
    except Exception:
        return {"ok": False, "raw": txt[:300]}


if __name__ == "__main__":
    print(json.dumps(update(sys.argv[1], sys.argv[2]), ensure_ascii=False))
