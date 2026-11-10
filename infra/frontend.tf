# ============================================================================
# 前端托管：CAE（云应用引擎）——NextJS 容器应用
# ============================================================================
# 默认关闭（enable_frontend=false）：
# CAE 起步规格为 8 核 32 GiB，且需镜像仓库 SWR 与公网 EIP，是资源占用最大的可选项。
# 端到端后端链路（GeminiDB → FGS → MaaS → EG → SIS → OBS）不依赖前端。

resource "huaweicloud_identity_agency" "cae" {
  count = var.enable_frontend ? 1 : 0

  name                  = "${local.name_prefix}-cae-agency"
  description           = "Agency for CAE to pull images and log"
  duration              = "FOREVER"
  delegated_domain_name = var.domain_name

  project_role {
    project = var.region
    roles = [
      "SWR Operator",
      "OBS OperateAccess",
      "AOM Administrator",
      "LTS Administrator",
    ]
  }
}

resource "huaweicloud_cae_environment" "main" {
  count = var.enable_frontend ? 1 : 0

  name = "${local.name_prefix}-env"

  annotations = {
    type              = "exclusive"
    vpc_id            = huaweicloud_vpc.main.id
    subnet_id         = huaweicloud_vpc_subnet.main.id
    security_group_id = huaweicloud_networking_secgroup.main.id
    group_name        = var.swr_org
  }
}

resource "huaweicloud_cae_application" "main" {
  count = var.enable_frontend ? 1 : 0

  environment_id = huaweicloud_cae_environment.main[0].id
  name           = "${local.name_prefix}-app"
}

# NextJS SSR 容器组件：镜像从 SWR 拉取，读取 stories 表渲染故事页
resource "huaweicloud_cae_component" "frontend" {
  count = var.enable_frontend ? 1 : 0

  environment_id      = huaweicloud_cae_environment.main[0].id
  application_id      = huaweicloud_cae_application.main[0].id
  deploy_after_create = true

  metadata {
    name = "${local.name_prefix}-frontend"
    annotations = {
      version = "1.0.0"
    }
  }

  spec {
    runtime = "Docker"
    replica = 1

    source {
      type = "image"
      url  = var.swr_image
    }

    resource_limit {
      cpu    = "500m"
      memory = "1Gi"
    }
  }

  configurations {
    type = "environment_variables"
    data = jsonencode({
      REGION              = var.region
      TABLE_NAME          = "stories"
      GEMINIDB_ENDPOINT   = local.geminidb_endpoint
      GEMINIDB_PROTOCOL   = var.geminidb_protocol
      GEMINIDB_ACCESS_KEY = "rwuser"
      GEMINIDB_SECRET_KEY = var.geminidb_password
    })
  }
}

# CAE 外网访问 EIP（公网入口，按流量模式；访问配置在 CAE 控制台绑定该 EIP）
resource "huaweicloud_vpc_eip" "cae" {
  count = var.enable_frontend ? 1 : 0

  publicip {
    type = "5_bgp"
  }

  bandwidth {
    name        = "${local.name_prefix}-cae-bw"
    size        = 5
    share_type  = "PER"
    charge_mode = "traffic"
  }
}
