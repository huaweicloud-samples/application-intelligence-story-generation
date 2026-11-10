# ============================================================================
# Terraform 与 Provider 配置
# ============================================================================

terraform {
  required_version = ">= 1.5"

  required_providers {
    huaweicloud = {
      source  = "huaweicloud/huaweicloud"
      version = "~> 1.70"
    }
  }
}

provider "huaweicloud" {
  region = var.region
  # Access Key 从环境变量 HW_ACCESS_KEY / HW_SECRET_KEY 读取，
  # 请在华为云『我的凭证』页面获取后导出到部署终端，不要写入任何文件。
}

locals {
  name_prefix = var.project_name

  # -------------------------------------------------------------------------
  # GeminiDB 数据面端点推导
  # -------------------------------------------------------------------------
  # GeminiDB 兼容 DynamoDB 接口实例不支持绑定 EIP（2026年1月起下线），
  # 只能由同 VPC 内的客户端访问，因此端点固定为：
  #   负载均衡内网地址 + 高可用端口
  # 注意：provider 的 lb_port 字段虽声明为 Computed，但代码中并无 d.Set，
  # 实际永远为空串，不能用于拼接端点。
  #
  # 真机实测（cn-north-4，FGS 挂 VPC 函数内探测）：
  #   · 节点 IP:8000（10.0.1.86/193/244）      → TCP 通、DynamoDB 协议通
  #   · LB IP:80（10.0.1.184）                 → TCP 通、DynamoDB 协议通  ✅ 采用
  #   · LB IP:8000                             → TCP 不通（LB 只监听高可用端口 80）
  # 因此端点取「负载均衡内网地址 + 高可用端口 80」：
  # 既走 LB 做高可用与流量分发，又避开节点单点。
  geminidb_node_port = (
    var.geminidb_data_port != 0
    ? var.geminidb_data_port
    : (
      try(huaweicloud_geminidb_instance.main.port, 0) != 0
      ? huaweicloud_geminidb_instance.main.port
      : 8000
    )
  )
  geminidb_lb_port = 80

  geminidb_endpoint = (
    var.geminidb_endpoint_override != ""
    ? var.geminidb_endpoint_override
    : "${huaweicloud_geminidb_instance.main.lb_ip_address}:${local.geminidb_lb_port}"
  )

  # -------------------------------------------------------------------------
  # 函数部署包（base64 内联）
  # -------------------------------------------------------------------------
  # 部署包由 scripts/build-packages.py 生成到 build/ 目录。
  # filebase64 对不存在的文件会直接报错，这里用 fileexists 兜底，
  # 给出可操作的提示而不是难以理解的 "Invalid function argument"。
  create_story_zip   = "${path.module}/../build/create_story.zip"
  generate_audio_zip = "${path.module}/../build/generate_audio.zip"

  create_story_code = (
    fileexists(local.create_story_zip)
    ? filebase64(local.create_story_zip)
    : base64encode("throw new Error('缺少部署包：build/create_story.zip，请先执行 python3 scripts/build-packages.py')")
  )

  generate_audio_code = (
    fileexists(local.generate_audio_zip)
    ? filebase64(local.generate_audio_zip)
    : base64encode("throw new Error('缺少部署包：build/generate_audio.zip，请先执行 python3 scripts/build-packages.py')")
  )

  # -------------------------------------------------------------------------
  # 环境变量净化
  # -------------------------------------------------------------------------
  # FGS 对环境变量做严格校验：值为空字符串的环境变量会被判为
  # FSS.1009 Invalid function UserData / Invalid environment variable。
  # 因此统一过滤掉空值项后再 jsonencode。
  env_without_empty = {
    for k, v in {
      REGION              = var.region
      GEMINIDB_ENDPOINT   = local.geminidb_endpoint
      GEMINIDB_PROTOCOL   = var.geminidb_protocol
      GEMINIDB_ACCESS_KEY = "rwuser"
      GEMINIDB_SECRET_KEY = var.geminidb_password
      CHARACTERS_TABLE    = "characters"
      SCENES_TABLE        = "scenes"
      STORIES_TABLE       = "stories"
      STORY_TTL_SECONDS   = "172800"
      MAAS_CHAT_BASE_URL  = "https://api.modelarts-maas.com/v2"
      MAAS_CHAT_MODEL     = var.maas_chat_model
      MAAS_SECRET_NAME    = huaweicloud_csms_secret.maas_api_key.name
      EG_CHANNEL_ID       = huaweicloud_eg_custom_event_channel.story.id
      EG_SOURCE_NAME      = huaweicloud_eg_custom_event_source.story.name
      STORY_FRONTEND_URL  = var.story_frontend_url
      AUDIO_BUCKET        = huaweicloud_obs_bucket.audio.bucket
      PRESIGN_EXPIRES     = "172800"
      SIS_VOICE           = "english_amy_common"
      SIS_SAMPLE_RATE     = "16000"
      SIS_FORMAT          = "mp3"
      HW_PROJECT_ID       = var.project_id
    } : k => v if v != null && v != ""
  }
}
