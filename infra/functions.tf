# ============================================================================
# 计算层：FunctionGraph 函数 + 定时触发器（事件分发由 EG 订阅承担）
# ============================================================================

# IAM 委托：FunctionGraph 云服务委托（op_svc_cff）
#
# 真机验证结论（cn-north-4）：
#   · 必须是【云服务委托】，delegated_service_name = "op_svc_cff"
#     （FunctionGraph 的云服务主体），普通账号委托（delegated_domain_name）
#     会导致建函数报 FSS.1501 The delegate not exist。
#   · domain_roles 授予全局服务策略；project_role 用于项目级服务（如 GeminiDB）。
#   · 函数挂 VPC 时委托需具备 VPC Administrator。
#   · GeminiDB 数据面【不认】IAM 委托，只认实例管理员账号 rwuser + 实例密码，
#     故此处不授予 GeminiDB 相关角色。
resource "huaweicloud_identity_agency" "functiongraph" {
  name                   = "${local.name_prefix}-fgs-cff-agency"
  description            = "Agency for FunctionGraph to access storage, notification, speech and VPC"
  delegated_service_name = "op_svc_cff"

  domain_roles = [
    "OBS OperateAccess",
    "SMN Publisher",
  ]

  # 区域级服务策略必须用 project_role（domain_roles 只对全局服务生效）。
  # 函数挂 VPC 时，FGS 需要用委托去查询子网/网卡信息，
  # 缺 VPC Administrator 会报 VPC.0216 Policy doesn't allow 'get_network'。
  #
  # 真机实测（探针函数内调用 SDK 的实际报错）：
  #   · CSMS 读密钥 → "No permissions for any one of the roles:
  #     [readonly, te_admin, op_service, kms_adm, csms_adm],
  #     or action csms:secretVersion:get"
  #     → DEW/CSMS 是区域级服务，放 domain_roles 无效，必须放 project_role。
  #   · EG 发布事件  → "No permissions for any one of the roles: [te_admin],
  #     or action eg:channels:putEvents"
  #     → 同理，EG 是区域级服务。移入 project_role 后即通过（探针返回 event_id）。
  #   · SIS 语音合成 → "inner network client should use VPC endpoint to call SIS."
  #     → 权限没问题，是网络形态限制（挂 VPC 的客户端必须走终端节点）。
  #   · OBS 上传    → 403 Access Denied，是桶策略缺失（见 storage.tf）。
  #
  # 策略名说明：华为云服务端鉴权按策略别名（alias）匹配，
  # 服务端报出的可选角色列表即别名：
  #   KMS 相关 → kms_adm / csms_adm；EventGrid 相关 → te_admin。
  # 因此这里用官方【显示名】对应的正确名称，别名在服务端自动匹配。
  project_role {
    project = var.region
    roles = [
      "VPC Administrator",
      "GeminiDB FullAccess",
      "KMS Administrator",
      "CSMS FullAccess",
      "SIS FullAccess",
      "EG FullAccess",
      "OBS OperateAccess",
    ]
  }
}

# ---------------------------------------------------------------------------
# FGS 服务委托说明（已弃用）
# ---------------------------------------------------------------------------
# 华为云《配置函数的网络环境》要求为函数工作流服务创建委托以操作 VPC 端口，
# 资源形态应为 huaweicloud_identity_service_agency（delegated_service_name = "functiongraph"）。
#
# 但真机实测：该资源在本账号/区域【不可用】——provider 走 IAM v5 POST /v5/agencies，
# 自动构造的 trust_policy 被 IAM 恒定拒绝：
#   PAP5.0011 malformed policy document
#
# 替代方案（实测有效）：
#   直接复用上面的账号内委托 huaweicloud_identity_agency.functiongraph，
#   并在它上面授予 "VPC Administrator"，即可成功创建【带 VPC】的函数。
#   已用原生 API 建 probe 函数（带 vpc_id + subnet_id）验证成功，
#   返回 urn:fss:cn-north-4:...:function:default:probe-b:latest。


# 函数 1：create-story —— 定时触发，读取角色/场景 → 调 MaaS 生成故事 → 写入 stories 表 → 发布领域事件
resource "huaweicloud_fgs_function" "create_story" {
  name        = "${local.name_prefix}-create-story"
  agency      = huaweicloud_identity_agency.functiongraph.name
  handler     = "index.handler"
  memory_size = 1024
  timeout     = 300
  runtime     = "Node.js18.15"

  # package 即 FGS 的「应用（app）名」，创建函数时必填，否则报 FSS.1027
  # Invalid packageName (app name)。用默认应用 default 即可。
  app = "default"

  # 代码以 base64 内联上传（code_type = "zip"）：
  #   - 免装 obsutil、免手工上传，单次 terraform apply 即可完成部署；
  #   - provider 对 func_code 使用 StateFunc(sha1) 存 state，state 不会膨胀；
  #   - 限制：单包 ≤50MB（官方接口上限），验证期部署包约 9MB。
  code_type     = "zip"
  code_filename = "create_story.zip"
  func_code     = local.create_story_code

  # 挂 VPC 后默认网卡被禁用，访问公网 API 需 NAT 网关（enable_nat_gateway）
  vpc_id     = var.fgs_vpc_enabled ? huaweicloud_vpc.main.id : null
  network_id = var.fgs_vpc_enabled ? huaweicloud_vpc_subnet.main.id : null

  user_data = jsonencode(local.env_without_empty)

  # 显式依赖委托：委托刚创建时 IAM 侧尚未可用，Terraform 并发建函数会报
  # FSS.1501 The delegate not exist。实测委托本身有效（原生 API 建函数成功），
  # 属并发时序问题，故显式 depends_on 保证顺序。
  depends_on = [huaweicloud_identity_agency.functiongraph]
}

# 定时触发器：每日 19:15 触发 create-story（6 段 cron：秒 分 时 日 月 周）
resource "huaweicloud_fgs_function_trigger" "create_story_timer" {
  function_urn = huaweicloud_fgs_function.create_story.urn
  type         = "TIMER"
  status       = "ACTIVE"

  event_data = jsonencode({
    name          = "${local.name_prefix}-bedtime"
    schedule_type = "Cron"
    schedule      = var.bedtime_cron
    # provider 会自动向 event_data 注入 sync_execution 字段。
    # 若配置里不显式写，云端已存的事件数据不含该字段，
    # provider 每次 refresh 都会判定「有变更」并发起 PUT，
    # 而 TIMER 触发器在 status 未变时禁止更新元数据，返回：
    #   FSS.1153 Trigger status ACTIVE is unchanged,
    #          and TIMER trigger metadata cannot be updated currently
    # 显式声明该字段，让配置与云端存储保持一致，消除无谓 diff。
    sync_execution = false
  })
}

# 函数 2：generate-audio —— EG 事件订阅触发（见 messaging.tf），SIS 语音合成 → OBS → 预签名 URL 回写
resource "huaweicloud_fgs_function" "generate_audio" {
  name        = "${local.name_prefix}-generate-audio"
  agency      = huaweicloud_identity_agency.functiongraph.name
  handler     = "index.handler"
  memory_size = 1024
  timeout     = 300
  runtime     = "Node.js18.15"

  app = "default"

  code_type     = "zip"
  code_filename = "generate_audio.zip"
  func_code     = local.generate_audio_code

  vpc_id     = var.fgs_vpc_enabled ? huaweicloud_vpc.main.id : null
  network_id = var.fgs_vpc_enabled ? huaweicloud_vpc_subnet.main.id : null

  user_data = jsonencode(local.env_without_empty)

  # 同 create_story：委托必须先于函数创建落地，否则报 FSS.1501
  depends_on = [huaweicloud_identity_agency.functiongraph]
}
