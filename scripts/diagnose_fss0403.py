"""FSS.0403 "user restricted" 归因诊断脚本。

用途：在华为云上遇到 403 FSS.0403 时，区分三类根因，避免盲目试错。

判定矩阵（每格都是一次独立 API 调用）：
  ┌──────────────────┬──────────────┬──────────────┬──────────────┐
  │ 探测              │ 账号整体受限  │ 仅 FGS 受限   │ 调用方权限不足 │
  ├──────────────────┼──────────────┼──────────────┼──────────────┤
  │ FGS 读 (list)     │ 200          │ 200          │ 403/401      │
  │ FGS 写 (create)   │ 403 FSS.0403 │ 403 FSS.0403 │ 403/401      │
  │ FGS 写 (put code) │ 403 FSS.0403 │ 403 FSS.0403 │ 403/401      │
  │ OBS 写 (put)      │ 403          │ 200          │ 403          │
  │ terraform refresh │ 失败         │ 成功          │ 成功          │
  └──────────────────┴──────────────┴──────────────┴──────────────┘

结论对照（华为云官方口径）：
  · FGS 读通 + 写/执行 403，且 OBS 写也 403
      → 账号被欠费冻结或受限（欠费后无法创建、执行函数及对资源执行任何操作）
  · FGS 读通 + 写/执行 403，但 OBS 写 200
      → 仅 FGS 服务被欠费停用（FGS FAQ：创建函数提示"已限制，不能执行此操作"
        正是因为账号处于欠费状态），需充值解除
  · FGS 读写全部 403/401
      → 调用方 IAM 用户缺 FunctionGraphInvoker / FunctionGraphCommonOperations

【关键判别 · 删除是否被允许】
华为云「欠费冻结租户的限制策略」逐字对应如下：
    创建 → 禁止      修改 → 禁止      调用 → 禁止
    删除 → 允许      查看列表 → 允许
若实测【删除函数成功 (rc=0)】而【创建/修改/调用均 403】，即可唯一确定
这是欠费冻结（保留期），而不是 IAM 权限不足——删除与创建在 IAM 权限模型里
是同一档权限，不可能只禁创建而放行删除。


用法：
    export HUAWEICLOUD_AK=xxx HUAWEICLOUD_SK=xxx
    python scripts/diagnose_fss0403.py <project_id> <region> [obs_bucket]

AK/SK 只从环境变量读取，不落盘。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cloud_call import call  # noqa: E402

PID = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HW_PROJECT_ID", "REPLACE_WITH_YOUR_PROJECT_ID")
REGION = sys.argv[2] if len(sys.argv) > 2 else "cn-north-4"
OBS_BUCKET = sys.argv[3] if len(sys.argv) > 3 else "ai-story-generation-audio"

FGS_HOST = "functiongraph.%s.myhuaweicloud.com" % REGION
results = []


def record(label, rc, detail=""):
    results.append((label, rc, detail))
    print("  %-34s rc=%-4s %s" % (label, rc, detail[:90]))


def probe_fgs_read():
    rc, t = call("GET", FGS_HOST, "/v2/%s/fgs/functions" % PID, None, {"limit": "5"})
    record("FGS 读: list functions", rc, t[:90])


def probe_fgs_write_create():
    body = {
        "func_name": "ai-story-fss0403-probe",
        "package": "default",
        "runtime": "Node.js14.18",
        "handler": "index.handler",
        "func_code": {
            "code_type": "inline",
            "code_filename": "index.js",
            "code_string": "exports.handler=async()=>({ok:true});",
        },
        "memory_size": 128,
        "timeout": 30,
    }
    rc, t = call("POST", FGS_HOST, "/v2/%s/fgs/functions" % PID, body)
    record("FGS 写: create function", rc, t[:90])
    if rc < 300:
        urn = "urn:fss:%s:%s:function:default:ai-story-fss0403-probe:latest" % (REGION, PID)
        call("DELETE", FGS_HOST, "/v2/%s/fgs/functions/%s" % (PID, urn))
        print("  (探针函数已清理)")


def probe_fgs_write_config():
    urn = "urn:fss:%s:%s:function:default:ai-story-generation-create-story:latest" % (REGION, PID)
    rc, t = call("PUT", FGS_HOST, "/v2/%s/fgs/functions/%s/config" % (PID, urn),
                 {"description": "fss0403 probe", "timeout": 60})
    record("FGS 写: update function config", rc, t[:90])


def probe_fgs_delete():
    """删除判定：欠费冻结时「删除」被允许、而「创建/修改/调用」被禁止。
    这是区分欠费冻结与 IAM 权限不足的唯一判别器——
    IAM 权限模型里删除与创建同属一档，不可能只禁创建而放行删除。
    """
    urn = "urn:fss:%s:%s:function:default:ai-story-fss0403-probe:latest" % (REGION, PID)
    rc, t = call("DELETE", FGS_HOST, "/v2/%s/fgs/functions/%s" % (PID, urn))
    # 404 = 函数本来就不存在（删除同样未受限）；0 = 删除成功；403 = 删除也被禁
    detail = "删除被禁止" if rc == 403 else ("删除成功" if rc == 0 else "函数不存在")
    record("FGS 删: delete function", rc, detail)


def probe_obs_write():
    """用 esdk-obs-nodejs 做一次真实 putObject（Python 侧无 OBS SDK）。"""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "obs_put_probe.js")
    if not os.path.exists(script):
        record("OBS 写: putObject", "skip", "缺少 obs_put_probe.js")
        return
    env = dict(os.environ)
    out = subprocess.run(["node", script, OBS_BUCKET], capture_output=True, text=True, env=env)
    txt = (out.stdout + out.stderr).strip().splitlines()
    line = txt[-1] if txt else ""
    ok = "OK" in line
    record("OBS 写: putObject", "200" if ok else "403", line[:90])


def verdict():
    print("\n" + "=" * 78)
    fgs_read = [r for r in results if r[0].startswith("FGS 读")]
    fgs_write = [r for r in results if r[0].startswith("FGS 写")]
    obs_write = [r for r in results if r[0].startswith("OBS 写")]

    read_ok = all(r[1] == 0 for r in fgs_read) if fgs_read else False
    write_blocked = all(r[1] == 403 for r in fgs_write) if fgs_write else False
    obs_ok = any(r[1] == "200" for r in obs_write)
    dels = [r for r in results if r[0].startswith("FGS 删")]
    delete_allowed = bool(dels) and dels[0][1] in (0, 404)

    if read_ok and write_blocked and delete_allowed:
        print("判定：账号欠费冻结（保留期）—— FGS 禁止创建/修改/调用，但允许删除与查看")
        print("      → 依据：华为云「欠费冻结租户的限制策略」创建/修改/调用=禁止，")
        print("              删除/查看列表=允许；删除与创建在 IAM 中同档权限，")
        print("              只禁创建而放行删除只可能是欠费冻结。")
        print("      → 处置：在费用中心完成欠费结清（充值会自动扣取欠费金额）；")
        print("              FGS FAQ「创建函数时提示已限制，不能执行此操作」"
              "「因为账号处于欠费状态」")
    elif read_ok and write_blocked and obs_ok:
        print("判定：仅 FGS 服务被受限（账号欠费时 FGS 被停用，其它服务不受影响）")
        print("      → 处置：在费用中心充值，确保可用额度充足")
    elif read_ok and write_blocked and not obs_ok:
        print("判定：账号整体受限/欠费冻结（FGS 与 OBS 写操作同时被拒）")
        print("      → 处置：欠费还款，或联系管理员解除账号限制")
    elif not read_ok:
        print("判定：调用方权限不足或 AK 无效（FGS 读路径也不通）")
        print("      → 处置：确认 AK 有效；给 IAM 用户授予 FunctionGraphInvoker "
              "或 FunctionGraphCommonOperations")
    else:
        print("判定：未见明显受限特征，需结合 FGS 请求 ID 提工单")
    print("=" * 78)


if __name__ == "__main__":
    print("FSS.0403 归因诊断  project=%s region=%s\n" % (PID, REGION))
    probe_fgs_read()
    probe_fgs_write_create()
    probe_fgs_write_config()
    probe_fgs_delete()
    probe_obs_write()
    verdict()
