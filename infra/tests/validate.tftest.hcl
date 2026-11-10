mock_provider "huaweicloud" {}

variables {
  region                = "cn-north-4"
  project_name          = "ai-story-generation"
  obs_bucket_name       = "ai-story-generation-audio-test"
  geminidb_password     = "MockPassword#2026"
  maas_api_key          = "MOCK_MAAS_KEY"
  domain_name           = "mock-domain-name"
  domain_id             = "00000000000000000000000000000000"
  project_id            = "00000000000000000000000000000000"
  geminidb_node_num     = 3
  geminidb_flavor       = "geminidb.cassandra.large.4"
  geminidb_storage_size = 100
  geminidb_public_eip   = true
  fgs_vpc_enabled       = false
  enable_nat_gateway    = false
  enable_frontend       = false
}

run "resource_graph_and_config" {
  command = plan

  assert {
    condition     = output.geminidb_endpoint != ""
    error_message = "应输出 GeminiDB 端点"
  }
  assert {
    condition     = output.obs_bucket_name == "ai-story-generation-audio-test"
    error_message = "OBS 桶名不符"
  }
  assert {
    condition     = output.cae_application_id == ""
    error_message = "验证期不应创建 CAE 前端"
  }
  assert {
    condition     = huaweicloud_vpc_eip.db[0].bandwidth[0].size == 5
    error_message = "GeminiDB EIP 带宽应为 5M"
  }
  assert {
    condition     = huaweicloud_geminidb_instance.main.mode == "Cluster"
    error_message = "GeminiDB 必须为集群形态"
  }
  assert {
    condition     = huaweicloud_geminidb_instance.main.flavor[0].num == 3
    error_message = "GeminiDB 节点数应为 3"
  }
  assert {
    condition     = huaweicloud_geminidb_instance.main.flavor[0].storage == "ULTRAHIGH"
    error_message = "GeminiDB 存储类型应为 ULTRAHIGH"
  }
  assert {
    condition     = huaweicloud_geminidb_instance.main.datastore[0].type == "dynamodb"
    error_message = "GeminiDB 数据面类型应为 dynamodb"
  }
  assert {
    condition     = huaweicloud_fgs_function.create_story.code_type == "zip"
    error_message = "函数代码类型应为 zip"
  }
  assert {
    condition     = huaweicloud_fgs_function.create_story.vpc_id == null
    error_message = "验证期函数不应挂 VPC"
  }
  assert {
    condition     = huaweicloud_vpc_eip.nat == null || length(huaweicloud_vpc_eip.nat) == 0
    error_message = "验证期不应创建 NAT 网关 EIP"
  }
  assert {
    condition     = length(huaweicloud_cae_application.main) == 0
    error_message = "验证期不应创建 CAE 应用"
  }
}
