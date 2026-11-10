# 部署指导

> 本指导以命令行方式完成全部部署。开始前请先阅读 [architecture.md](./architecture.md) 了解整体架构。
>
> **验证期请优先采用本文 §6「最小可用验证拓扑」**：默认配置已关闭前端、免建 NAT 网关。

## 0. 准备

| 项 | 说明 |
|---|---|
| 区域 | 默认 `cn-north-4`，需已开通 FunctionGraph / GeminiDB / OBS / SMN / EG / SIS / DEW |
| MaaS | 控制台 **ModelArts → 模型推理 → 在线推理 → 预置服务**，进入 `#/model-studio/homepage` 开通服务并领取额度；在「API Key 管理」创建 API Key（仅显示一次）。注意：MaaS 预置服务仅部分区域提供，推理走统一公网入口，与资源所在区域可以不同 |
| 工具 | Terraform >= 1.5、Node.js 18+（**无需 obsutil / zip**） |
| 凭据 | 在华为云『我的凭证』页面获取 Access Key；部署终端导出 `HW_ACCESS_KEY` / `HW_SECRET_KEY`，不要写入任何文件 |

## 1. 初始化 Terraform

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# 编辑 terraform.tfvars：至少填入 geminidb_password / maas_api_key / domain_name
terraform init
```

**预期输出**：`Terraform has been successfully initialized!`

## 2. 构建函数部署包

```bash
# 回到仓库根目录执行
node scripts/build-packages.js
```

**预期输出**：

```
==> building function packages
  create_story.zip: 9194 files, 9.02 MB
  generate_audio.zip: 6494 files, 6.48 MB
==> done. total 15.50 MB (FGS inline limit 50 MB per package)
```

> 部署包以 base64 内联上传（`code_type = "zip"` + `filebase64()`），
> **不需要 obsutil，也不需要"先建 OBS 桶再手工上传"的两次 apply**。
> 首次执行会自动 `npm install` 依赖（各约 1 分钟），之后会跳过。
>
> 限制：单个部署包压缩后须 ≤ 50MB（华为云接口上限）。当前约 9MB / 6.5MB，安全。

## 3.（可选）构建前端镜像并推送 SWR

仅当 `enable_frontend = true` 时需要。验证期建议跳过，见 §6。

```bash
cd src/frontend
docker build -t <swr-domain>/<org>/story-frontend:1.0.0 .
docker login <swr-domain>   # 用户名为区域名称，密码为『我的凭证』页面生成的 SWR 登录指令密钥
docker push <swr-domain>/<org>/story-frontend:1.0.0
```

将镜像地址填入 `infra/terraform.tfvars` 的 `swr_image`。

## 4. 部署

```bash
cd infra
export HW_ACCESS_KEY=<你的 Access Key>
export HW_SECRET_KEY=<你的 Secret Key>
terraform plan
terraform apply -auto-approve
```

**预期输出**：`Apply complete! Resources: N added, 0 changed, 0 destroyed.`

> ⚠️ 凭据只在当前终端 export，**不要写入 `terraform.tfvars` 或任何文件**。
> `terraform.tfvars` 里只放业务参数（数据库密码、MaaS Key、域名等）。

### 4.1 关键参数说明

| 参数 | 默认 | 说明 |
|---|---|---|
| `geminidb_node_num` | `3` | **不可降为 1**。GeminiDB 兼容 DynamoDB 接口仅支持集群形态，节点数硬性下限 3，写 `num=1` 服务端报 `DBS.280123` |
| `geminidb_flavor` | `geminidb.cassandra.large.4` | 2 vCPU / 8 GB，验证期最小可选规格 |
| `geminidb_storage_size` | `100` | 经典部署最小 100GB，须为 10 的倍数 |
| `geminidb_public_eip` | `true` | 给 GeminiDB 节点绑 EIP，函数走默认网卡直连公网端点，**免建 NAT 网关** |
| `fgs_vpc_enabled` | `false` | 是否把函数挂进 VPC。挂 VPC 后默认网卡被禁用 |
| `enable_nat_gateway` | `false` | NAT 网关按所选规格开通，仅在 `fgs_vpc_enabled=true` 且需访问公网 API 时才需要 |
| `enable_frontend` | `false` | CAE 起步规格为 8 核 32 GiB，开销较大时建议关闭 |
| `geminidb_data_port` | `0`（自动） | 探测脚本确认端口后可用 `-var` 覆盖，不会重建实例 |
| `geminidb_endpoint_override` | `""` | 手工指定 `host:port`，探测后回填 |

> ⚠️ **端口说明**：GeminiDB 兼容接口的**节点端口 8000** 与**高可用（负载均衡）端口 80** 是两个不同入口。
> 走 EIP 直连节点用 8000；走 VPC 内负载均衡地址用 80。部署后请用 §5.1 的探测脚本确认，
> 确认后用 `-var="geminidb_data_port=<端口>"` 或 `-var="geminidb_endpoint_override=<host:port>"` 回填（均不触发重建）。

## 5. 部署后收尾

### 5.1 探测数据面端口

```bash
cd ../scripts
./probe-geminidb.sh "$(cd ../infra && terraform output -raw geminidb_host_port | cut -d: -f1)"
```

**预期输出**：出现 `Content-Type: application/x-amz-json-1.0` 的端口即数据面（HTTP 500 是未签名的正常响应）。

### 5.2 确认邮件订阅

SMN 会向 `notify_email` 发送订阅确认邮件，点击确认后通知链路生效。

### 5.3 导入种子数据

```bash
cd scripts
npm install @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb
export GEMINIDB_ENDPOINT=$(cd ../infra && terraform output -raw geminidb_host_port)
export GEMINIDB_ACCESS_KEY=rwuser
export GEMINIDB_SECRET_KEY=<实例管理员密码，与 terraform 的 geminidb_password 相同>
export GEMINIDB_PROTOCOL=http
node seed-data.js
```

**预期输出**：`seed data inserted`

> 数据面只认实例管理员账号 `rwuser` + 实例密码，**不接受华为云 AK/SK，也不支持 securityToken**。
> 表在首次写入时自动创建。

### 5.4（可选）CAE 前端

仅当 `enable_frontend = true` 时：CAE 控制台为组件配置访问方式（绑定 EIP），获得前端地址，
回填至 `create-story` 函数环境变量 `STORY_FRONTEND_URL`。

## 6. 最小可用验证拓扑

### 6.1 默认配置即可跑通

`terraform.tfvars` 里除 `geminidb_password` / `maas_api_key` / `domain_name` 外**全部保持默认**，
即得资源占用最小的验证拓扑：

- ✅ GeminiDB 3 节点 `large.4` + 100GB —— 兼容 DynamoDB 接口的**硬性下限**，无法再降
- ✅ FGS 走默认网卡（共享公网带宽）—— 不挂 VPC
- ✅ GeminiDB 绑 EIP 直连 —— **免建 NAT 网关**
- ✅ 不部署 CAE 前端 —— 起步规格较大，非必需场景可关闭
- ✅ FGS / OBS / EG / SMN / CSMS 空闲时不产生计算负载

### 6.2 资源规格一览

| 资源 | 规格 | 说明 |
|---|---|---|
| GeminiDB | 3 节点 `large.4`（2C8G） | 兼容 DynamoDB 接口仅集群形态，节点数下限 3 |
| GeminiDB 存储 | 100 GB | 经典部署最小 100GB，须为 10 的倍数 |
| EIP（GeminiDB） | 5M 按流量 | 供函数走默认网卡直连数据面 |
| FGS 函数 | 1024MB | 按调用量结算，空闲时无负载 |
| OBS / EG / SMN / CSMS | — | 按实际用量 |
| MaaS 推理 | deepseek-v3.2 | 按 token 用量 |
| SIS 语音合成 | 短语音 | 按字符数 |
| CAE 前端 | 8 核 32 GiB | 起步规格，可通过 `enable_frontend=false` 关闭 |
| NAT 网关 | 小型规格 | 通过 `enable_nat_gateway=true` 开启 |

> 💡 **验证完及时 `terraform destroy`**：按需开通的资源会持续运行，误开的可选组件应及时关闭。

### 6.3 三步验证清单

| 层级 | 检查项 | 方式 |
|---|---|---|
| L1 基础设施 | GeminiDB 3 节点正常、OBS 桶存在 | `terraform output` + 控制台 |
| L2 服务配置 | FGS 两个函数、EG 通道/源、SMN 订阅、CSMS 密钥 | 控制台 + `terraform state list` |
| L3 端到端 | 定时触发 → MaaS 生成 → 写 stories → EG 分发 → SIS 合成 → OBS → 回写 audioURL | 手动触发 `create-story`，查 stories 表与 OBS |
| L4 安全 | 委托角色最小化、OBS 桶策略、密钥不落盘 | `terraform plan` 无敏感输出 |
| L5 数据落盘 | stories 表有记录、OBS 有 mp3 对象 | `node scripts/seed-data.js` 后查表 |

### 6.4 排错与切换

| 现象 | 处理 |
|---|---|
| 探测脚本报全端口不通 | 检查 EIP 是否绑定成功、安全组是否放行；必要时用 `-var="geminidb_endpoint_override=<host:port>"` |
| 端口 80 通但 8000 不通 | 这是集群 HA 端口差异，回填 `-var="geminidb_data_port=80"` |
| 函数报 `AccessDeniedException: auth failed` | 数据面必须用 `rwuser` + 实例密码，不能用 AK/SK |
| 函数报 `Cannot read properties of undefined (reading 'valueOf')` | SDK 区域枚举应为 `csms.CsmsRegion` / `sis.SisRegion`（不是 `csms.Region` / `sis.Region`） |
| 函数报请求签名相关错误 | 检查 `GEMINIDB_PROTOCOL` 与实例 `ssl_option` 是否一致 |
| 需要访问公网 MaaS/SIS 但函数在 VPC | 开 `enable_nat_gateway = true`，或改回 `geminidb_public_eip = true` |

## 6.5 坑位：账号欠费冻结导致 FGS 全面不可写（真机踩过）

**现象**：某次 apply 之后，FGS 的**创建 / 修改 / 调用**全部返回
`403 {"error_code":"FSS.0403","error_msg":"user restricted"}`，
而**读接口正常**（`list functions` / `get config` / `list triggers` 都 200）。

**别被"删除函数居然能成功"误导**——这正是欠费冻结的判定特征：

| 操作 | 欠费冻结后 | 说明 |
|---|---|---|
| 创建函数 | 禁止 | `FSS.0403` |
| 修改函数（config / code / alias） | 禁止 | `FSS.0403` |
| 调用函数（同步 / 异步） | 禁止 | `FSS.0403` |
| **删除函数** | **允许** | rc=0 —— 关键判别点 |
| **查看列表** | **允许** | 200 |

IAM 权限模型里删除与创建同属一档权限（`FunctionGraphFullAccess` 同时覆盖创建/修改/删除/调用），
**只禁创建而放行删除，只可能是账号状态类限制**。

**处置**：

1. 费用中心查看「欠费金额」→ **还清欠费**。
   注意：宽限期内的充值只恢复"开通新资源/新服务"的能力，
   **必须还清欠费才能解除资源冻结**（否则 apply 依旧 `FSS.0403`）。
2. 一键诊断（跑完判别矩阵直接给结论）：
   ```bash
   export HUAWEICLOUD_AK=xxx HUAWEICLOUD_SK=xxx
   python scripts/diagnose_fss0403.py <project_id> <region> [obs_bucket]
   ```
3. 冻结解除后 `terraform apply` 一次即可完整重建（冻结期间删除操作仍被允许，
   且代码包与定义都在本地）。

**提工单凭据**：报错里的 `request_id`（一串 32 位十六进制，形如 `0123456789abcdef0123456789abcdef`）必须附上。

## 6.6 坑位：GeminiDB 兼容接口不能降配到单节点

`geminidb_node_num = 1` 会在服务端被拒（`DBS.280123`）——兼容 DynamoDB 接口仅支持集群形态，
**节点数硬性下限为 3**。因此无法通过缩节点降低资源占用，唯一手段是及时 `terraform destroy` 释放实例。
存储也必须是 10 的倍数（经典部署最小 100 GB）。

## 7. 清理

```bash
cd infra
terraform destroy -auto-approve
```

**预期输出**：`Destroy complete! Resources: N destroyed.`

> 手工动作的残留需手动释放：SWR 镜像（在 SWR 控制台删除）、CSMS 密钥（随实例释放）、
> GeminiDB 绑定的 EIP（随实例释放，但如仍占用请在 VPC 控制台确认释放）。

### 7.1 清理必读：三个会卡住 destroy 的坑（真机踩过）

**坑 1：EG 资源有删除顺序依赖。**
必须按 **subscription → custom source → channel** 顺序删除；
source 尚在时删 channel 会报 `409 EGS.00514002 channel has source`。

**坑 2：FGS 挂 VPC 会残留端口占用子网。**
FGS 挂载 VPC 时会自动创建 `FunctionGraph-Access-VPC-Port` 端口，占用业务子网私有 IP。
不先删端口，删子网报 `VPC.0208 Subnet is used by private IP`。
正确顺序：**先删 EG 资源 → 再删 FGS 端口 → 最后删子网与 VPC**。

**坑 3：子网删除很慢。**
华为云侧子网异步释放，单个子网删除耗时可达约 18 分钟，
`terraform destroy` 建议**后台执行**，前台会因超时被中断。

清理完成后建议复核：

```bash
terraform state list                 # 应无输出
terraform plan -destroy -input=false # 应为 No changes
```

清理期间可用的核查脚本（均只读）：

```bash
python scripts/audit_resources.py  # 跨服务查询并筛选本项目残留资源
```
