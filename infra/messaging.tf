# ============================================================================
# 事件层：EG 事件网格（自定义事件源 + 订阅）+ SMN 邮件通知
# ============================================================================

# 新故事邮件通知主题
resource "huaweicloud_smn_topic" "story" {
  name         = "${local.name_prefix}-story-generated"
  display_name = "New bedtime story notifications"
}

resource "huaweicloud_smn_subscription" "story_email" {
  # 未填收件邮箱时不创建订阅（SMN 会报 Missing input for argument [Endpoint]）
  count = var.notify_email == "" ? 0 : 1

  topic_urn = huaweicloud_smn_topic.story.id
  protocol  = "email"
  endpoint  = var.notify_email
}

# EG 目标代理：EG 投递事件到 FunctionGraph / SMN 时代为执行
#
# 这是「服务委托」（被委托方为云服务 EventGrid）。
#
# 关键结论（真机实测）：本账号/区域【不可用】huaweicloud_identity_service_agency
# （底层走 IAM v5 POST /v5/agencies，provider 自动构造的 trust_policy 恒被拒：
#   PAP5.0011 malformed policy document），
# 原生 API 换 Service 名（eg / service.EventGrid / eventgrid）亦全部同样报错。
#
# 可用配方（已在临时目录真实 apply 验证通过，创建耗时 12s）：
#   huaweicloud_identity_agency
#     + delegated_service_name = "op_svc_EG"   （华为云服务委托的服务名前缀）
#     + all_resources_roles    = [...]         （v3 风格的 all_resources 列表）
#   apply 后 trust_domain_name 自动解析为 "op_svc_EG"。
#
# 权限按华为云《事件网格 EG - 授权委托》表要求：
#   EG_TARGET_AGENCY 需要 functiongraph:function:invoke / invokeAsync、
#   eg:channels:get / list / putEvents、smn:topic:publish
resource "huaweicloud_identity_agency" "eg_target" {
  name                   = "${local.name_prefix}-eg-target-agency"
  description            = "Agency for EventGrid to deliver events to FunctionGraph and SMN"
  delegated_service_name = "op_svc_EG"

  all_resources_roles = [
    "FunctionGraph FullAccess",
    "SMN Publisher",
  ]
}

# EG 事件通道 + 自定义事件源：create-story 函数写入故事后显式发布 StoryGenerated 事件
resource "huaweicloud_eg_custom_event_channel" "story" {
  name        = "${local.name_prefix}-channel"
  description = "Story generation event channel"
}

resource "huaweicloud_eg_custom_event_source" "story" {
  name       = "${local.name_prefix}-story-created"
  channel_id = huaweicloud_eg_custom_event_channel.story.id
  type       = "APPLICATION"
}

# 事件订阅：StoryGenerated 一对二分发（语音合成函数 + 邮件主题）
resource "huaweicloud_eg_event_subscription" "story" {
  channel_id = huaweicloud_eg_custom_event_channel.story.id
  name       = "${local.name_prefix}-fanout"

  sources {
    id            = "a3f1c9d2-5b47-4e8a-9c21-6d0e84f5b1a0"
    provider_type = "CUSTOM"
    name          = huaweicloud_eg_custom_event_source.story.name
    filter_rule = jsonencode({
      source = [{
        op     = "StringIn"
        values = [huaweicloud_eg_custom_event_source.story.name]
      }]
    })
  }

  # 目标 1：FunctionGraph generate-audio（异步调用）
  targets {
    id            = "b7e2d0c8-9a34-4f56-8d17-2c9b05e3f7d4"
    provider_type = "OFFICIAL"
    name          = "HC.FunctionGraph"
    detail_name   = "detail"
    detail = jsonencode({
      urn         = huaweicloud_fgs_function.generate_audio.urn
      invoke_type = "ASYNC"
      agency_name = huaweicloud_identity_agency.eg_target.name
    })
    transform = jsonencode({
      type  = "ORIGINAL"
      value = ""
    })
  }

  # 目标 2：SMN 邮件主题（正文为原始事件内容，邮件中含故事 id）
  targets {
    id            = "c9d3e1b4-0a25-4c67-b928-3d1a16f4a8e5"
    provider_type = "OFFICIAL"
    name          = "HC.SMN"
    detail_name   = "smn_detail"
    detail = jsonencode({
      subject_transform = {
        type  = "CONSTANT"
        value = "New bedtime story generated"
      }
      urn         = huaweicloud_smn_topic.story.id
      agency_name = huaweicloud_identity_agency.eg_target.name
    })
    transform = jsonencode({
      type  = "ORIGINAL"
      value = ""
    })
  }
}
