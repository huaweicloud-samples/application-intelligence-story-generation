#!/usr/bin/env bash
# ============================================================================
# 函数打包脚本（兼容入口）
#
# 实际打包逻辑放在 scripts/build-packages.js —— 由 Node 实现 zip，
# 原因是 Windows Git Bash 通常没有 zip 命令，且 FGS 要求包内为 POSIX 路径。
#
# 部署方式：Terraform 以 code_type="zip" + filebase64() 内联上传，
# 不再需要 obsutil，也不需要"先建桶再上传"的两次 apply。
#
# 用法：bash scripts/package-functions.sh
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if ! command -v node >/dev/null 2>&1; then
  echo "!! 需要 Node.js 18+（未找到 node）" >&2
  exit 1
fi

node scripts/build-packages.js
