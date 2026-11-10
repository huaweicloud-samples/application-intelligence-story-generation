mock_provider "huaweicloud" {
  mock_resource "huaweicloud_geminidb_instance" {
    defaults = {
      groups = [{
        nodes = [{ id = "mock-node-id-0" }]
      }]
    }
  }
}

variables {
  region              = "cn-north-4"
  project_name        = "ai-story-generation"
  obs_bucket_name     = "ai-story-generation-audio-test"
  geminidb_password   = "MockPassword#2026"
  maas_api_key        = "MOCK_MAAS_KEY"
  domain_name         = "mock-domain-name"
  domain_id           = "00000000000000000000000000000000"
  project_id          = "00000000000000000000000000000000"
  geminidb_public_eip = true
  fgs_vpc_enabled     = false
  enable_nat_gateway  = false
  enable_frontend     = false
}

run "function_env_vars" {
  command = apply

  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).GEMINIDB_ACCESS_KEY == "rwuser"
    error_message = "数据面账号应为 rwuser"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).GEMINIDB_PROTOCOL == "http"
    error_message = "数据面协议应为 http"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).GEMINIDB_SECRET_KEY == "MockPassword#2026"
    error_message = "数据面密码未正确注入"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).MAAS_CHAT_BASE_URL == "https://api.modelarts-maas.com/v2"
    error_message = "MaaS 端点不正确"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).MAAS_CHAT_MODEL == "deepseek-v3.2"
    error_message = "MaaS 模型不正确"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).MAAS_SECRET_NAME == "ai-story-generation-maas-key"
    error_message = "CSMS 密钥名不正确"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).STORY_TTL_SECONDS == "172800"
    error_message = "TTL 应为 2 天"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).EG_SOURCE_NAME == "ai-story-generation-story-created"
    error_message = "EG 事件源名不正确"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.create_story.user_data).HW_PROJECT_ID == "00000000000000000000000000000000"
    error_message = "项目 ID 未注入"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.generate_audio.user_data).SIS_VOICE == "english_amy_common"
    error_message = "SIS 音色不正确"
  }
  assert {
    condition     = jsondecode(huaweicloud_fgs_function.generate_audio.user_data).PRESIGN_EXPIRES == "172800"
    error_message = "预签名有效期应为 2 天"
  }
  assert {
    condition     = nonsensitive(jsondecode(huaweicloud_csms_secret.maas_api_key.secret_text).api_key) == "MOCK_MAAS_KEY"
    error_message = "CSMS secret 应包装为 {\"api_key\": ...} JSON，与函数侧 JSON.parse 一致"
  }
}
