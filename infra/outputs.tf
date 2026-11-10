# ============================================================================
# 输出
# ============================================================================

output "geminidb_endpoint" {
  description = "GeminiDB（DynamoDB 兼容）数据面端点，含协议与端口"
  value       = "${var.geminidb_protocol}://${local.geminidb_endpoint}"
}

output "geminidb_host_port" {
  description = "GeminiDB 数据面 host:port（供探测脚本与 seed 脚本使用）"
  value       = local.geminidb_endpoint
}

output "geminidb_data_port" {
  description = "GeminiDB 数据端口"
  value       = local.geminidb_node_port
}

output "obs_bucket_name" {
  description = "音频文件 OBS 桶名"
  value       = huaweicloud_obs_bucket.audio.bucket
}

output "eg_channel_id" {
  description = "EG 事件通道 ID（create-story 函数发布事件使用）"
  value       = huaweicloud_eg_custom_event_channel.story.id
}

output "eg_source_name" {
  description = "EG 自定义事件源名称"
  value       = huaweicloud_eg_custom_event_source.story.name
}

output "smn_topic_arn" {
  description = "邮件通知 SMN 主题 URN"
  value       = huaweicloud_smn_topic.story.id
}

output "create_story_function_urn" {
  description = "create-story 函数 URN"
  value       = huaweicloud_fgs_function.create_story.urn
}

output "generate_audio_function_urn" {
  description = "generate-audio 函数 URN"
  value       = huaweicloud_fgs_function.generate_audio.urn
}

output "cae_application_id" {
  description = "CAE 应用 ID（enable_frontend=false 时为空）"
  value       = try(huaweicloud_cae_application.main[0].id, "")
}

output "nat_eip" {
  description = "NAT 网关绑定的 EIP（enable_nat_gateway=false 时为空）"
  value       = try(one(huaweicloud_vpc_eip.nat[*].address), "")
}
