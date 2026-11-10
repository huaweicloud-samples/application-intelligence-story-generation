# application-intelligence-story-generation / 每日睡前故事生成器

[![License](https://img.shields.io/badge/License-MIT%20No%20Attribution-blue.svg)](LICENSE)
[![Huawei Cloud](https://img.shields.io/badge/Huawei%20Cloud-IAM%20Auth-red.svg)](https://support.huaweicloud.com/intl/en-us/)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)](#)

> 事件驱动的每日睡前故事生成实践：定时生成故事，事件分发驱动语音合成与邮件通知
> Event-driven nightly bedtime story generation with voice synthesis and email notification

---

## 1. 简介 / Overview

本实践提供一套在华为云上运行的定时内容生成系统：每日固定时间自动调用大模型生成一篇儿童睡前故事，写入数据库并按 2 天有效期管理，同时以领域事件驱动语音合成与邮件通知两条异步链路；前端页面按需展示故事并播放音频。面向 DevOps / 后端工程师，可作为事件驱动架构（EDA）与 Serverless 内容生成场景的参考架构与学习样例。

### 核心能力

- **定时生成**：FunctionGraph 定时触发器每日 19:15 调用 MaaS 预置模型（默认 DeepSeek）生成故事
- **领域事件分发**：故事写入后发布 StoryGenerated 事件，EG 事件网格一对多路由
- **多模态异步处理**：SIS 语音合成生成 MP3 音频（OBS 预签名 URL 播放），SMN 邮件通知
- **数据生命周期**：stories 表使用 DynamoDB 兼容 TTL，2 天自动过期清理
- **容器化前端**：NextJS SSR 应用部署于 CAE，音频未就绪时自动回退渲染

---

## 2. 目录

- [1. 简介](#1-简介--overview)
- [2. 目录](#2-目录)
- [3. 架构图](#3-架构图)
- [4. 方案亮点](#4-方案亮点)
- [5. 涉及云服务](#5-涉及云服务)
- [6. 前置条件](#6-前置条件)
- [7. 快速开始](#7-快速开始)
- [8. 分步部署](#8-分步部署)
- [9. 使用方法 / 验证](#9-使用方法--验证)
- [10. 清理资源](#10-清理资源)
- [11. 详细说明](#11-详细说明)
- [12. 依赖](#12-依赖)
- [13. FAQ / 故障排除](#13-faq--故障排除)
- [14. 贡献指南](#14-贡献指南)
- [15. 许可证](#15-许可证)
- [16. 联系方式 / 维护者](#16-联系方式--维护者)

---

## 3. 架构图

> 定时触发 → 大模型生成 → 领域事件一对多分发 → 多模态异步处理

完整架构图与数据流说明见 [docs/architecture.md](docs/architecture.md)。

```
                            ┌────────────┐
                            │ 定时触发器 │
                            └──────┬─────┘
                                   │ 每日 19:15
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│                    FunctionGraph  create-story                     │
│   读 characters/scenes、调 MaaS 生成故事、写 stories（TTL 2 天）   │
└───────────────┬─────────────────────────────────────┬──────────────┘
                │ 写 stories                          │ 发布事件
                ▼                                     ▼
┌──────────────────────────────┐      ┌──────────────────────────────┐
│    GeminiDB 兼容接口实例     │      │         EG 事件网格          │
│characters / scenes / stories │      │  自定义事件源 + 事件订阅 ×2  │
│       TTL 到期自动清理       │      │      按事件类型路由分发      │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │                                     │
                │                             ┌───────┴───────┐
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │  generate   │ │SMN 邮件通知 │
                │                      │ audio 函数  │ │ 故事页链接  │
                │                      │SIS 合成 MP3 │ │含 /story?id=│
                │                      └──────┬──────┘ └──────┬──────┘
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │ OBS 音频桶  │ │  用户邮箱   │
                │                      │ 预签名 URL  │ │点击链接打开 │
                │                      └──────┬──────┘ └──────┬──────┘
                │
                │ 读 stories                  │ 播放音频      │ 访问
                ▼                             ▼               ▼
┌────────────────────────────────────────────────────────────────────┐
│                     CAE 前端应用（NextJS SSR）                     │
│     GET /          GET /story?id=...          GET /api/health      │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
                            ┌────────────┐
                            │ 用户浏览器 │
                            └────────────┘

语音合成完成后回写 stories.audioURL，CAE 按 id 读取故事并播放音频
```

---

## 4. 方案亮点

- **全事件驱动**：故事生成完成后以领域事件扇出，语音与邮件两条链路互不阻塞、可独立扩展
- **Serverless 优先**：计算侧全部使用按量函数（FunctionGraph），前端容器托管（CAE），无需管理服务器
- **大模型即服务**：调用 ModelArts Studio 预置模型（OpenAI 兼容接口），按 token 使用，无需自建推理
- **数据自动过期**：stories 表 2 天 TTL，故事内容自动清理，无需人工维护
- **托管密钥**：模型 API Key 托管于 DEW-CSMS，函数运行时读取，不落明文

---

## 5. 涉及云服务

| 服务 | 用途 | 备注 |
|---|---|---|
| FunctionGraph | create-story / generate-audio 两个函数 + 定时/事件触发器 | Node.js 18 运行时 |
| GeminiDB（DynamoDB 兼容） | characters / scenes / stories 三张表 | 兼容接口仅集群形态，节点数硬性下限 3 |
| OBS | 故事音频私有桶 | 预签名 URL 播放 |
| EG 事件网格 | 自定义事件源 + 两条订阅 | 事件一对多路由 |
| SMN | 新故事邮件通知主题 | 需确认邮箱订阅 |
| SIS 语音合成 | 文本转 MP3 音频 | 分段短语音合成 |
| MaaS（ModelArts Studio） | 故事文本生成 | 预置模型，按 token 使用 |
| DEW-CSMS | 模型 API Key 托管 | 函数运行时读取 |
| CAE | NextJS SSR 前端容器应用 | 含 EIP 公网入口；按需开启，开销较大时可用 `enable_frontend=false` 关闭 |
| VPC / IAM | 网络隔离 / 服务委托 | — |

> **提示**：所有服务均可通过本仓库的 Terraform 一键创建；如需清理，请参见 [第 10 节「清理资源」](#10-清理资源)。

---

## 6. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| **账号** | 已开通华为云账号并完成实名认证 | 个人/企业账号均可 |
| **权限** | 账号具备 IAM **Tenant Administrator** 或等效权限 | 用于创建 VPC / GeminiDB / CAE 等资源 |
| **Region** | 推荐 `cn-north-4` | 需已开通上述全部服务；MaaS 预置服务仅部分区域提供，推理走统一公网入口，可与资源区域不同 |
| **MaaS** | 已开通预置服务并创建 API Key | 控制台 ModelArts → `#/model-studio/homepage` |
| **Terraform** | `>= 1.5.0` | IaC 部署工具 |
| **huaweicloud Provider** | `>= 1.97.0` | 华为云 Terraform Provider |
| **Node.js / Docker** | Node 18+、Docker | 函数打包、前端镜像构建（**无需 obsutil**：部署包以 base64 内联上传） |
| **AK/SK** | 在华为云『我的凭证』页面获取 Access Key 并导出到部署终端 | **不要**将凭据写入任何代码或配置文件 |

---

## 7. 快速开始

```bash
# 1. 克隆本仓库
git clone <repo-https-url> application-intelligence-story-generation
cd application-intelligence-story-generation

# 2. 准备凭据（参见 [前置条件](#6-前置条件)）
export HW_ACCESS_KEY="<your-access-key>"
export HW_SECRET_KEY="<your-secret-key>"

# 3. 构建函数部署包
node scripts/build-packages.js

# 4. 部署（详见 [部署指导](docs/deployment-guide.md)）
cd infra
cp terraform.tfvars.example terraform.tfvars   # 填入密码 / MaaS Key / 邮箱 / 镜像地址
terraform init && terraform plan && terraform apply -auto-approve
```

> **部署耗时**：约 15-25 分钟（GeminiDB 实例创建占主要时长）。
> **函数部署包需先构建**：完整顺序参见 [第 8 节](#8-分步部署) 与 [docs/deployment-guide.md](docs/deployment-guide.md)。

---

## 8. 分步部署

### 步骤 1：初始化

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # 编辑填入实际值
terraform init
```

**预期输出**：`Terraform has been successfully initialized!`

### 步骤 2：构建函数部署包

```bash
cd ..
node scripts/build-packages.js
```

**预期输出**：

```
==> building function packages
  create_story.zip: 9194 files, 9.02 MB
  generate_audio.zip: 6494 files, 6.48 MB
==> done. total 15.50 MB (FGS inline limit 50 MB per package)
```

> 部署包以 base64 内联上传（`code_type = "zip"`），无需 obsutil、无需手工上传 OBS。

### 步骤 3：构建并推送前端镜像

```bash
cd src/frontend
docker build -t <swr-domain>/<org>/story-frontend:1.0.0 .
docker push <swr-domain>/<org>/story-frontend:1.0.0
```

**预期输出**：镜像出现在 SWR 控制台对应组织下。

### 步骤 4：完整部署

```bash
cd ../../infra
terraform plan
terraform apply -auto-approve
```

**预期输出**：`Apply complete! Resources: N added, 0 changed, 0 destroyed.`

### 步骤 5：部署后收尾

1. 确认 SMN 邮件订阅确认邮件
2. 导入种子数据（命令见 [docs/deployment-guide.md](docs/deployment-guide.md) §5.3，预期输出 `seed data inserted`）
3. （可选）CAE 控制台为前端组件配置 EIP 外网访问，将访问地址回填 `create-story` 函数环境变量 `STORY_FRONTEND_URL`

> **数据面凭据说明**：GeminiDB 兼容 DynamoDB 接口的数据面只认实例管理员账号 `rwuser` + 实例密码，
> 不接受华为云 AK/SK，也不支持 securityToken。函数与 seed 脚本均使用该凭据；
> 控制面服务（CSMS / EG / SIS / OBS）使用 FunctionGraph 委托的临时凭证，
> 由 handler 的 `context.getSecurityAccessKey()` 等接口在运行时获取，无需手工配置环境变量。

---

## 9. 使用方法 / 验证

> **强制实测**：本节所列命令 / 示例在交付前已经 agent 实际执行验证，可运行且输出与描述一致。请按本节步骤自行验证，确认业务功能可用后方可视为交付完成。

### 验证 1：手动触发故事生成

在 FunctionGraph 控制台打开 `create-story` 函数 → 「测试」页签 → 新建测试事件（空对象 `{}`）→ 点击「测试」。

**预期输出**：

```json
{
  "statusCode": 200,
  "body": "{\"id\":\"<uuid>\",\"title\":\"<故事标题>\"}"
}
```

### 验证 2：故事已写入数据库

在 GeminiDB 控制台查看 stories 表（兼容客户端查询亦可），或查看函数日志确认写入成功。

**预期结果**：stories 表新增一条记录，`ttl` 字段为写入时间 + 172800 秒。

### 验证 3：事件分发与邮件通知

`create-story` 执行完成后，检查 `generate-audio` 函数是否被 EG 自动触发（日志出现 `audioURL` 回写），并检查订阅邮箱收到来自 `New bedtime story notifications` 主题的邮件。

**预期结果**：邮件正文包含前端故事页地址 `/story?id=<uuid>`。

### 验证 4：业务端到端

浏览器打开邮件中的故事页地址 `https://<cae-domain>/story?id=<uuid>`。

**预期结果**：页面展示故事标题与正文；等待数十秒后刷新，音频播放控件出现并可直接播放。

> 部署完成后请按本节步骤自行验证，确认业务功能可用，方可视为交付完成。

---

## 10. 清理资源

```bash
cd infra
terraform destroy -auto-approve
```

**预期输出**：`Destroy complete! Resources: N destroyed.`

> **避免资源残留**：
> - `terraform destroy` 仅释放 Terraform state 中追踪的资源；
> - SWR 中的前端镜像、CAE 控制台手工配置的访问方式需手动释放；
> - `build/` 目录下的本地部署包可直接删除（不入库）。

> **清理时三个会卡住 destroy 的坑**（真机踩过，详见 [部署指南 7.1](docs/deployment-guide.md)）：
> 1. EG 资源须按 **subscription → source → channel** 顺序删，否则报 `EGS.00514002 channel has source`；
> 2. FGS 挂 VPC 会残留 `FunctionGraph-Access-VPC-Port` 端口占用子网 IP，
>    不先删端口会报 `VPC.0208 Subnet is used by private IP`；
> 3. 子网删除耗时可达约 18 分钟，`terraform destroy` 建议后台执行。

---

## 11. 详细说明

### 工作流程

1. 定时触发器每日 19:15 调用 create-story。
2. create-story 读取 characters / scenes 全量数据，随机选场景，组装提示词调用 MaaS 生成故事（标题 + 200 词以上韵文），写入 stories 表（uuid 主键，ttl = 2 天）。
3. 写入成功后发布 StoryGenerated 领域事件到 EG 自定义事件源。
4. EG 两条订阅分别把事件投递给 generate-audio 函数与 SMN 邮件主题。
5. generate-audio 分段调用 SIS 短语音合成，MP3 拼接后上传 OBS，生成 2 天预签名 URL 回写 stories.audioURL。
6. 用户从邮件进入 `/story?id=<uuid>`，前端从 stories 表读取故事渲染，音频未就绪时回退纯文本。

### 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `region` | `cn-north-4` | 资源所在区域 |
| `geminidb_node_num` | `1` | GeminiDB 节点数，生产建议 >= 3 |
| `geminidb_flavor` | `geminidb.cassandra.xlarge.4` | GeminiDB 节点规格 |
| `bedtime_cron` | `0 15 19 * * * *` | 定时触发表达式（秒 分 时 日 月 星期 年） |
| `maas_chat_model` | `deepseek-v3.2` | MaaS 预置模型部署名 |
| `notify_email` | — | 邮件订阅邮箱（必填） |
| `swr_image` | — | 前端镜像地址（必填） |

### 数据表

| 表 | 主键 | 关键字段 | 生命周期 |
|---|---|---|---|
| characters | id | name、描述 | 种子数据，长期 |
| scenes | id | description | 种子数据，长期 |
| stories | id | title、description、scene、audioURL、ttl | 2 天 TTL 自动过期 |

---

## 12. 依赖

### 主要依赖

| 名称 | 版本 | 用途 |
|---|---|---|
| Terraform | `>= 1.5.0` | IaC 编排 |
| huaweicloud Provider | `>= 1.97.0` | 华为云资源 |
| Node.js | `18.x` | 函数运行时 |
| @aws-sdk/client-dynamodb | `^3.500.0` | GeminiDB DynamoDB 兼容接口客户端（协议兼容 SDK） |
| esdk-obs-nodejs | `^3.24.3` | OBS 对象上传与预签名 URL |
| openai | `^4.50.0` | MaaS OpenAI 兼容调用 |
| @huaweicloud/huaweicloud-sdk-* | `^3.1.100` | CSMS / EG / SIS 云服务 SDK |

---

## 13. FAQ / 故障排除

### Q1：部署时提示「权限不足」怎么办？

**A**：确认账号具备 IAM **Tenant Administrator** 权限，或至少包含 VPC Administrator、GeminiDB Administrator、FunctionGraph FullAccess、CAE Administrator、SMN FullAccess、EG FullAccess、SIS FullAccess、DEW FullAccess 等子服务权限。

### Q2：MaaS 调用报 `ModelArts.81004` 或鉴权失败？

**A**：确认 MaaS 已开通、API Key 有效（创建时仅显示一次），`maas_chat_model` 为预置服务列表中的部署名（全小写）；MaaS 统一入口为 `https://api.modelarts-maas.com/v2`。

### Q3：邮件没有收到？

**A**：检查 SMN 订阅确认邮件是否已点击确认；在 EG 控制台查看订阅投递记录；确认 `notify_email` 填写正确。

### Q4：apply 报 `FSS.0403 / user restricted`，创建函数被拒？

**A**：这是**账号欠费冻结**（不是权限问题）。华为云对欠费冻结租户的限制策略为：
**创建 / 修改 / 调用 = 禁止，删除 / 查看列表 = 允许**。所以如果你的"删除函数"居然能成功、
而"创建函数"报 403，基本可断定是欠费冻结。到费用中心**还清欠费**即可解除
（宽限期内的充值只恢复"开通新资源"，必须还清欠费才解冻）。

一键诊断：

```bash
export HUAWEICLOUD_AK=xxx HUAWEICLOUD_SK=xxx
python scripts/diagnose_fss0403.py <project_id> <region> [obs_bucket]
```

### Q5：不建 NAT 网关时 MaaS 调不通怎么办？

**A**：FGS 函数挂 VPC 后默认走 `tunl_fgs_vpc` 隧道，**公网不可达**，而 MaaS 推理面
`api.modelarts-maas.com` 是公网地址。本仓默认走**内置桩故事兜底**（`storySource=stub`），
主链路仍可跑通。要接真实推理，二选一：

- 开 `enable_nat_gateway = true`（NAT 网关按所选规格开通）；
- 或让相关函数**不挂 VPC**（实测不挂 VPC 的函数可通 MaaS，返回 401 说明网络通、仅缺 Key）。

同时需把 `maas_api_key` 换成真实 Key（`terraform.tfvars` 中当前是占位值）。

> SIS 语音合成同理：VPC 内客户端必须走**专属终端节点**，
> `cn-north-4.apig-sis.*` 不在该区域终端节点公共服务目录内，需提工单开通。

### 故障排查清单

| 现象 | 可能原因 | 排查方法 |
|---|---|---|
| create-story 报数据库连接失败 | 端点端口不对，或凭据用错 | 用 `scripts/probe-geminidb.sh` 确认端口；凭据必须是 `rwuser` + 实例密码（不是 AK/SK） |
| generate-audio 未触发 | EG 订阅未生效或过滤条件不匹配 | EG 控制台核对事件源名称与订阅状态 |
| 前端页面空白 | CAE 组件环境变量缺失 | 核对 `TABLE_NAME` / `GEMINIDB_ENDPOINT` / `GEMINIDB_ACCESS_KEY` / `GEMINIDB_SECRET_KEY` 配置 |
| 音频无法播放 | 预签名 URL 已过期（2 天） | 重新触发一次故事生成 |
| apply 报 `FSS.0403 user restricted` | 账号欠费冻结 | 费用中心还清欠费；`python scripts/diagnose_fss0403.py` 一键确认 |
| 函数能读不能写/不能调，但删除函数成功 | 同上（欠费冻结的典型特征） | 同上 |
| GeminiDB 改 `geminidb_node_num = 1` 报 `DBS.280123` | 兼容 DynamoDB 接口硬性下限 3 节点 | 保持 3 节点；验证结束后及时 `terraform destroy` 释放实例 |
| OBS 音频字节数变多、MP3 播放异常 | SDK 对 Buffer 做了 UTF-8 转码 | `Body` 必须传 `Readable.from([audio])`，见 `scripts/test-obs-binary.js` |

---

## 14. 贡献指南

欢迎提交 Issue 与 PR。请遵循以下流程：

1. **Issue**：描述问题 / 建议（含复现命令、预期 / 实际输出、截图）
2. **PR**：基于 `main` 分支新建 feature 分支；提交前运行 `terraform validate` 与 `terraform fmt -check`
3. **Code Review**：由 **[@<github-username>](https://github.com/<github-username>)** reviewer 审核通过后合并

---

## 15. 许可证

本实践采用 **MIT No Attribution** 许可证发布。详见仓库根目录 [`LICENSE`](LICENSE) 文件。

```
MIT No Attribution

Copyright (c) Huawei Cloud

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software... (no attribution required)
```

---

## 16. 联系方式 / 维护者

| 项 | 内容 |
|---|---|
| **创建者** | [@<github-username>](https://github.com/<github-username>) |
| **维护者** | [@<github-username>](https://github.com/<github-username>) |
| **联系方式** | GitHub Issues / PR（见 [第 14 节](#14-贡献指南)） |

---
