"""通用华为云 API 调用助手。

用 SDK 的 Signer 做 AK/SK 签名，通过 curl 发送请求（沙箱内走系统代理时
requests 的 CONNECT 隧道会 502，curl 更稳）。AK/SK 只从环境变量读取，不落盘。

用法：
    export HUAWEICLOUD_AK=xxx
    export HUAWEICLOUD_SK=xxx
    python scripts/cloud_call.py GET modelarts.cn-north-4.myhuaweicloud.com /v2/{project}/maas/api-auth/api-keys
    python scripts/cloud_call.py POST modelarts.cn-north-4.myhuaweicloud.com /path '{"label":"x"}'
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

from huaweicloudsdkcore.auth.credentials import BasicCredentials
from huaweicloudsdkcore.sdk_request import SdkRequest
from huaweicloudsdkcore.signer.signer import Signer


def sign(method, host, path, body=None, query=None):
    ak = os.environ["HUAWEICLOUD_AK"]
    sk = os.environ["HUAWEICLOUD_SK"]
    signer = Signer(BasicCredentials(ak, sk))
    payload = json.dumps(body) if body is not None else None
    # SDK 要求 query_params 为 (key, value) 元组列表（元组可排序，dict 不可）
    query_params = [(k, str(v)) for k, v in (query or {}).items()]
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
    # 注意：GET 且无 query 参数时 signer 不会回填 uri（为 None），必须回退到原始 path
    uri = signed.uri or path
    return f"https://{host}{uri}", signed.header_params, payload


def call(method, host, path, body=None, query=None):
    """发送请求。

    优先用 urllib 直发：Windows 下 curl 对带冒号的 path（如 FGS 的 urn）会报
    "Malformed input to a URL"，且 -X/--data-binary 组合在 Git Bash 下解析不稳。
    仅在 urllib 失败时回退 curl。
    """
    url, headers, payload = sign(method, host, path, body, query)
    data = payload.encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return 0, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        cmd = ["curl", "-sS", "-m", "60", "-X", method, url]
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
        if payload:
            cmd += ["--data-binary", payload]
        env = dict(os.environ, MSYS_NO_PATHCONV="1")
        out = subprocess.run(cmd, capture_output=True, text=True, env=env)
        return out.returncode, out.stdout + out.stderr


if __name__ == "__main__":
    method, host, path = sys.argv[1], sys.argv[2], sys.argv[3]
    body = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
    query = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
    rc, text = call(method, host, path, body, query)
    print(f"rc={rc}")
    print(text)
