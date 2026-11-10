# ============================================================================
# 存储层：OBS 桶 + GeminiDB（DynamoDB 兼容接口）+ CSMS 密钥
# ============================================================================

# 故事音频文件桶（音频对象经预签名 URL 供前端播放）
resource "huaweicloud_obs_bucket" "audio" {
  bucket        = var.obs_bucket_name
  acl           = "private"
  force_destroy = true

  tags = {
    project = local.name_prefix
  }
}

# ---------------------------------------------------------------------------
# OBS 桶策略 —— 需要
# ---------------------------------------------------------------------------
# 真机实测：仅在委托上授予 "OBS OperateAccess" 不够，
# 函数内 obs.putObject 仍返回 403 Access Denied。
# 华为云 OBS 的桶级鉴权要求：桶策略中显式声明谁可以读写该桶，
# 仅 IAM 侧的角色授权不足以让【委托】身份通过桶策略校验。
#
# Principal 用账号 ID（domain_id）：委托最终以账号域内主体身份发起请求。
#
# Resource 必须是 OBS 资源路径格式（不是 "obs:bucket:name:object:*"）：
#   桶级：obs:bucket:{bucket}
#   对象级：obs:object:{bucket}/*
# 之前报 Code=MalformedPolicy, Message=Policy has invalid resource 即因此。
resource "huaweicloud_obs_bucket_policy" "audio" {
  bucket = huaweicloud_obs_bucket.audio.bucket

  # policy_format = "obs"：使用 OBS 原生桶策略语法。
  #   此时 Action 不带 "obs:" 前缀（如 PutObject 而非 obs:PutObject），
  #   Resource 直接用桶名 / 桶名/*，
  #   否则服务端报 Code=MalformedPolicy, Message=Policy has invalid action.
  policy_format = "obs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccountFullAccess"
        Effect = "Allow"
        Principal = {
          ID = ["domain/${var.domain_id}"]
        }
        Action = [
          "PutObject",
          "GetObject",
          "DeleteObject",
          "ListBucket",
        ]
        Resource = [
          huaweicloud_obs_bucket.audio.bucket,
          "${huaweicloud_obs_bucket.audio.bucket}/*",
        ]
      },
    ]
  })
}

# GeminiDB DynamoDB 兼容实例：characters / scenes / stories 三张表
# stories 表使用 DynamoDB 兼容 TTL（字段 ttl，写入方按 2 天过期时间计算）
#
# 规格约束（依据华为云《GeminiDB 兼容 DynamoDB 接口 实例规格》与官方 provider example）：
#   - datastore.type   必须是 "dynamodb"（全小写），version 必须是空字符串
#   - datastore.storage_engine 固定 "rocksDB"
#   - mode             必须是 "Cluster"（兼容接口仅支持集群形态）
#   - flavor.storage   固定 "ULTRAHIGH"（全大写）
#   - flavor.num       硬性 ≥3，集群形态没有单节点档（num=1 报 DBS.280123）
#   - flavor.size      经典部署最小 100GB；须为 10 的倍数
#   - port             不支持自定义（仅 GeminiDB Redis 可自定义）
resource "huaweicloud_geminidb_instance" "main" {
  name              = "${local.name_prefix}-db"
  mode              = "Cluster"
  password          = var.geminidb_password
  availability_zone = join(",", var.geminidb_az)
  vpc_id            = huaweicloud_vpc.main.id
  subnet_id         = huaweicloud_vpc_subnet.main.id
  security_group_id = huaweicloud_networking_secgroup.main.id
  charging_mode     = "postPaid"
  ssl_option        = var.geminidb_ssl_option

  datastore {
    type           = "dynamodb"
    storage_engine = "rocksDB"
    version        = ""
  }

  flavor {
    num       = var.geminidb_node_num
    size      = var.geminidb_storage_size
    spec_code = var.geminidb_flavor
    storage   = "ULTRAHIGH"
  }

  lifecycle {
    # password / storage / ssl_option 创建后由服务端接管，忽略漂移避免无谓重建
    ignore_changes = [
      password,
      flavor.0.storage,
      ssl_option,
    ]
  }

  tags = {
    project = local.name_prefix
  }
}

# ---------------------------------------------------------------------------
# GeminiDB 公网访问 —— 已下线，代码保留说明
# ---------------------------------------------------------------------------
# 华为云自 2026 年 1 月起不再支持给 GeminiDB 兼容 DynamoDB 接口实例绑定
# 弹性公网 IP（绑定接口返回 DBS.216029 This operation is not allowed），
# 官方建议 DynamoDB 兼容实例不绑 EIP，改由同 VPC 内的客户端访问。
# 因此本项目走「FGS 挂 VPC + NAT 出网 + 实例负载均衡内网地址」方案。
# 相应地，不再创建 huaweicloud_vpc_eip.db 与 huaweicloud_geminidb_eip_bind.db。

# MaaS API Key 托管（DEW-CSMS），create-story 函数运行时读取
resource "huaweicloud_csms_secret" "maas_api_key" {
  name        = "${local.name_prefix}-maas-key"
  description = "ModelArts Studio API Key for story generation"
  # 变量语义是「纯 API Key 字符串」，而函数侧用 JSON.parse(secret_string).api_key 读取，
  # 因此这里统一包装成 {"api_key": "..."}，避免调用方手工拼 JSON。
  secret_text = jsonencode({ api_key = var.maas_api_key })
  secret_type = "COMMON"
}
