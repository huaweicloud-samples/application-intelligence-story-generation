#!/usr/bin/env bash
# ============================================================================
# GeminiDB 数据面探测脚本（只发几个包，不创建任何云资源）
#
# 用法：
#   ./scripts/probe-geminidb.sh <host> [ports...]
#   ./scripts/probe-geminidb.sh "$(terraform output -raw geminidb_host_port | cut -d: -f1)"
#
# 输出：
#   - 哪个端口是通的
#   - 该端口返回的 HTTP 头（出现 application/x-amz-json-1.0 即证明是 DynamoDB 数据面）
#
# 判读：
#   HTTP/1.1 500 + Content-Type: application/x-amz-json-1.0
#   = 数据面正常（500 只因为没做 SigV4 签名）
#   连接超时 = 端口不通或安全组未放行
# ============================================================================
set -uo pipefail

HOST="${1:?用法: probe-geminidb.sh <host> [ports...]}"
shift || true
PORTS=("${@:-80 8000}")

if [ -z "$HOST" ]; then
  echo "❌ host 为空" >&2
  exit 1
fi

echo "探测目标: $HOST  端口: ${PORTS[*]}"
echo "────────────────────────────────────────────"

FOUND=""
for p in "${PORTS[@]}"; do
  printf "端口 %-6s : " "$p"

  # 1) TCP 连通性（5 秒超时）
  if timeout 5 bash -c "</dev/tcp/$HOST/$p" 2>/dev/null; then
    echo -n "TCP OPEN  |  "
  else
    echo "TCP closed / 超时"
    continue
  fi

  # 2) HTTP 响应头（识别是否为 DynamoDB 数据面）
  HEAD_OUT=$(curl -s -i --max-time 6 "http://$HOST:$p/" 2>/dev/null | head -5)
  STATUS=$(printf '%s' "$HEAD_OUT" | grep -i '^HTTP/' | head -1 | tr -d '\r')
  CTYPE=$(printf '%s' "$HEAD_OUT" | grep -i '^content-type:' | head -1 | tr -d '\r' | cut -d' ' -f2-)

  echo "${STATUS:-HTTP 无响应}"
  if [ -n "$CTYPE" ]; then
    echo "            Content-Type: $CTYPE"
    case "$CTYPE" in
      *x-amz-json-*)
        echo "            ✅ 确认为 DynamoDB 兼容数据面"
        FOUND="$FOUND $p"
        ;;
      *)
        echo "            ⚠️  非 DynamoDB 数据面"
        ;;
    esac
  fi
done

echo "────────────────────────────────────────────"
if [ -n "$FOUND" ]; then
  echo "✅ 可用端口:$FOUND"
  echo "   若与默认端口不同，用 -var 覆盖后重新 apply（不会重建实例）："
  echo "   terraform apply -var=\"geminidb_data_port=<端口>\""
else
  echo "❌ 未找到开放的 DynamoDB 数据端口"
  echo "   排查顺序：1) 安全组是否放行该端口  2) 公网访问是否已绑 EIP  3) 端点是否选错"
fi
