# ============================================================================
# 变量定义
# ============================================================================

variable "region" {
  description = "华为云区域"
  type        = string
  default     = "cn-north-4"
}

variable "project_name" {
  description = "项目名称，用于资源命名前缀"
  type        = string
  default     = "ai-story-generation"
}

variable "obs_bucket_name" {
  description = "OBS 桶名（全局唯一），存放故事音频文件"
  type        = string
  default     = "ai-story-generation-audio"
}

variable "geminidb_password" {
  description = "GeminiDB 实例管理员密码（数据面账号固定为 rwuser，密码即此值）"
  type        = string
  sensitive   = true
}

# ---------------------------------------------------------------------------
# GeminiDB 规格
# ---------------------------------------------------------------------------
# 硬性约束（官方《GeminiDB 兼容 DynamoDB 接口》）：
#   - 兼容接口仅支持集群形态，节点数下限 3，没有单节点档；
#     写 num=1 会被服务端拒绝（DBS.280123）。
#   - 规格码族为 geminidb.cassandra.*（不存在 geminidb.dynamodb.*）。
#   - 存储必须是 10 的倍数：经典部署最小 100GB。
# 因此验证期「降配」的空间只有节点规格（xlarge.4 → large.4），
# 无法把节点数降到 1。
variable "geminidb_node_num" {
  description = "GeminiDB 节点数（兼容接口硬性下限 3，不支持单节点）"
  type        = number
  default     = 3
}

variable "geminidb_az" {
  description = "GeminiDB 可用区列表（单 AZ 可行，验证期保持单 AZ）"
  type        = list(string)
  default     = ["cn-north-4a"]
}

variable "geminidb_flavor" {
  description = "GeminiDB 节点规格（large.4 = 2 vCPU / 8 GB，验证期最小可选）"
  type        = string
  default     = "geminidb.cassandra.large.4"
}

variable "geminidb_storage_size" {
  description = "GeminiDB 存储空间 GB（经典部署最小 100，须为 10 的倍数）"
  type        = number
  default     = 100
}

variable "geminidb_ssl_option" {
  description = "GeminiDB 数据面 SSL 开关（on/off），需与 geminidb_protocol 保持一致"
  type        = string
  default     = "off"
}

variable "geminidb_protocol" {
  description = "GeminiDB 数据面协议：http 或 https。官方 Java 示例用 http；若实例开启 SSL 需改为 https"
  type        = string
  default     = "http"
}

variable "geminidb_data_port" {
  description = <<-EOT
    GeminiDB 数据端口。0 = 自动（取 provider 返回的节点端口，兼容接口为 8000）。
    若探测脚本发现实际端口不同，可用 -var 覆盖后重新 apply（不会重建实例）。
  EOT
  type        = number
  default     = 0
}

variable "geminidb_endpoint_override" {
  description = "手工指定 GeminiDB 端点 host:port（探测脚本确认后回填），留空则自动推导"
  type        = string
  default     = ""
}

variable "geminidb_public_eip" {
  description = <<-EOT
    是否给 GeminiDB 节点绑定 EIP 开通公网访问。
    注意：华为云自 2026 年 1 月起不再支持给 GeminiDB 兼容 DynamoDB 接口实例绑定弹性公网IP
    （接口返回 DBS.216029 This operation is not allowed），
    因此本项目固定走内网访问模式（false）：FGS 挂 VPC，直连实例负载均衡内网地址。
    保留该变量仅为兼容旧 tfvars，实际恒为 false。
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# 网络 / 出网
# ---------------------------------------------------------------------------
variable "fgs_vpc_enabled" {
  description = <<-EOT
    是否把 FunctionGraph 函数挂进 VPC。
    GeminiDB 兼容 DynamoDB 接口实例不支持绑定 EIP，必须由同 VPC 内的客户端访问，
    因此默认 true。挂 VPC 后函数默认网卡被禁用，访问公网 API（MaaS/SIS/EG）依赖 NAT 网关出网。
  EOT
  type        = bool
  default     = true
}

variable "enable_nat_gateway" {
  description = "是否创建 NAT 网关。fgs_vpc_enabled=true 时必需，否则函数无法访问公网 API"
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# 可选组件（按需关闭以降低资源占用）
# ---------------------------------------------------------------------------
variable "enable_frontend" {
  description = "是否部署 CAE 前端。CAE 起步规格为 8 核 32 GiB，非必需场景建议关闭"
  type        = bool
  default     = false
}

variable "swr_image" {
  description = "前端容器镜像地址（SWR），形如 swr.{region}.myhuaweicloud.com/{org}/{image}:{tag}（enable_frontend=true 时必填）"
  type        = string
  default     = ""
}

variable "swr_org" {
  description = "SWR 组织名（CAE 环境绑定使用）"
  type        = string
  default     = "ai-story-generation"
}

# ---------------------------------------------------------------------------
# 通知 / 密钥
# ---------------------------------------------------------------------------
variable "notify_email" {
  description = "新故事通知邮箱（SMN 邮件订阅，需在邮箱中确认订阅）"
  type        = string
  default     = ""
}

variable "maas_api_key" {
  description = "ModelArts Studio 预置模型服务 API Key（控制台『API Key 管理』创建）"
  type        = string
  sensitive   = true
  default     = ""
}

variable "maas_chat_model" {
  description = "MaaS 预置模型部署名（对话生成）。需先在 MaaS『预置服务』中开通该模型，且 API Key 有该模型访问权限。"
  type        = string
  default     = "qwen3-32b"
}

variable "bedtime_cron" {
  description = "每日生成故事的时间，FunctionGraph 定时触发器 cron 表达式（6 段：秒 分 时 日 月 周）"
  type        = string
  default     = "0 15 19 * * ?"
}

variable "story_frontend_url" {
  description = "前端访问地址（CAE 部署后回填），用于邮件中的故事页链接"
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------
variable "domain_name" {
  description = "华为云账号域名（IAM 委托归属域）"
  type        = string
}

variable "domain_id" {
  description = "华为云账号 ID（OBS 桶策略里的 Principal 需要 domain/<domain_id>）。留空则不创建桶策略"
  type        = string
  default     = ""
}

variable "project_id" {
  description = "华为云项目 ID，注入函数环境变量用于控制面 SDK 的 projectId"
  type        = string
  default     = ""
}
