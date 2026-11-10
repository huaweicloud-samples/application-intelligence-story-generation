"""FGS 函数调用助手（Python urllib 直发，绕开 curl 的 URL 解析问题）。

与 cloud_call.py 的区别：不用 curl，直接 urllib.request 发请求，
因此 path 中的冒号（urn 里的 :）不会被 Windows curl 判为 "Malformed input to a URL"。

AK/SK 只从环境变量读取，不落盘。

用法：
    export HUAWEICLOUD_AK=xxx
    export HUAWEICLOUD_SK=xxx
    python scripts/fgs_call.py list
    python scripts/fgs_call.py show ai-story-generation-create-story
    python scripts/fgs_call.py invoke ai-story-generation-create-story '{}'
    python scripts/fgs_call.py invoke-async ai-story-generation-create-story '{}'
"""
import json
import os
import sys
import urllib.error
import urllib.request

from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkcore.sdk_request import SdkRequest
from huaweicloudsdkcore.signer.signer import Signer

PID = os.environ.get("HW_PROJECT_ID", "REPLACE_WITH_YOUR_PROJECT_ID")
HOST = "functiongraph.cn-north-4.myhuaweicloud.com"
BASE = f"https://{HOST}"


def urn_of(name):
    return f"urn:fss:cn-north-4:{PID}:function:default:{name}:latest"


def _signed(method, path, body=None, query=None, host=None):
    ak = os.environ["HUAWEICLOUD_AK"]
    sk = os.environ["HUAWEICLOUD_SK"]
    signer = Signer(BasicCredentials(ak, sk))
    payload = json.dumps(body) if body is not None else None
    query_params = [(k, str(v)) for k, v in (query or {}).items()]
    host = host or HOST
    req = SdkRequest(
        method=method,
        schema="https",
        host=host,
        resource_path=path,
        uri=path,
        header_params={"Content-Type": "application/json"},
        query_params=query_params,
        body=payload,
        stream=False,
    )
    signed = signer.sign(req)
    uri = signed.uri or path
    return f"https://{host}{uri}", signed.header_params, payload


def request(method, path, body=None, query=None, timeout=180, host=None):
    url, headers, payload = _signed(method, path, body, query, host)
    data = payload.encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def pretty(raw, limit=20000):
    try:
        j = json.loads(raw)
    except Exception:
        return raw[:limit]
    b = j.get("body") if isinstance(j, dict) else None
    if isinstance(b, str):
        try:
            b = json.loads(b)
        except Exception:
            pass
    if b is not None:
        return json.dumps(b, ensure_ascii=False, indent=1)[:limit]
    return json.dumps(j, ensure_ascii=False, indent=1)[:limit]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]

    if cmd == "list":
        st, raw = request("GET", f"/v2/{PID}/fgs/functions", query={"limit": 50})
        print("status", st)
        try:
            j = json.loads(raw)
            for f in j.get("functions", []):
                print(f" - {f.get('func_name'):45} status={f.get('status')} "
                      f"code={f.get('code_size', 0)/1048576:.1f}MB")
        except Exception:
            print(raw[:3000])
        return

    if cmd in ("show", "invoke", "invoke-async"):
        name = sys.argv[2]
        body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        urn = urn_of(name)
        if cmd == "show":
            st, raw = request("GET", f"/v2/{PID}/fgs/functions/{urn}")
            print("status", st)
            print(pretty(raw, 4000))
            return
        suffix = "invocations" if cmd == "invoke" else "invocations-async"
        st, raw = request("POST", f"/v2/{PID}/fgs/functions/{urn}/{suffix}", body)
        print("status", st)
        print(pretty(raw))
        return

    print("unknown command:", cmd)


if __name__ == "__main__":
    main()
