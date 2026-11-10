# ============================================================================
# 网络层：VPC / 子网 / 安全组 / 可选 NAT 网关
# ============================================================================

resource "huaweicloud_vpc" "main" {
  name = "${local.name_prefix}-vpc"
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc_subnet" "main" {
  name       = "${local.name_prefix}-subnet"
  vpc_id     = huaweicloud_vpc.main.id
  cidr       = "10.0.1.0/24"
  gateway_ip = "10.0.1.1"
}

resource "huaweicloud_networking_secgroup" "main" {
  name        = "${local.name_prefix}-sg"
  description = "Security group for ${local.name_prefix}"
}

# ---------------------------------------------------------------------------
# GeminiDB 数据端口放行
# ---------------------------------------------------------------------------
# GeminiDB 兼容 DynamoDB 接口实例自 2026 年 1 月起不再支持绑定 EIP
# （接口返回 DBS.216029 This operation is not allowed），
# 因此只能由同 VPC 内的客户端访问，此处仅放通 VPC 内网段。
resource "huaweicloud_networking_secgroup_rule" "allow_data_port" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = local.geminidb_node_port
  port_range_max    = local.geminidb_node_port
  remote_ip_prefix  = "10.0.0.0/16"
  security_group_id = huaweicloud_networking_secgroup.main.id
}

# 负载均衡（高可用）端口，兼容接口集群形态的 HA 端口为 80
resource "huaweicloud_networking_secgroup_rule" "allow_data_ha_port" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = local.geminidb_lb_port
  port_range_max    = local.geminidb_lb_port
  remote_ip_prefix  = "10.0.0.0/16"
  security_group_id = huaweicloud_networking_secgroup.main.id
}

# ---------------------------------------------------------------------------
# 子网安全组：函数挂 VPC 的前提条件
# ---------------------------------------------------------------------------
# 华为云《配置函数的网络环境》要求：
#   1) 函数的委托需具备 VPC Administrator；
#   2) 安全组入方向放通 ICMP（源为所选 VPC 网段）、出方向放通业务端口。
#
# 真机实测结论（重要）：本账号【不存在 id 为 "default" 的安全组】，
# 直接写 security_group_id = "default" 会报：
#   VPC.0602 security_group_id default does not exist
# 账号内唯一带 vpc_id 字段的是系统组 Sys-default
# （id 00673c73-42e4-4a48-8576-5df3eede55f4，但其 vpc_id 字面量为 "default"，
#  并非本 VPC），不可用于本场景。
#
# 正确做法：给子网关联本项目自建的安全组 huaweicloud_networking_secgroup.main，
# 并在该组上放通 ICMP 入方向与出方向全端口。
resource "huaweicloud_networking_secgroup_rule" "allow_icmp" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "icmp"
  remote_ip_prefix  = "10.0.0.0/16"
  security_group_id = huaweicloud_networking_secgroup.main.id
}

resource "huaweicloud_networking_secgroup_rule" "allow_outbound" {
  direction         = "egress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 1
  port_range_max    = 65535
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.main.id
}

# ---------------------------------------------------------------------------
# 公网 NAT 网关（小型规格，按需开启）
# ---------------------------------------------------------------------------
# 为什么必须有：FGS 挂 VPC 后【默认网卡被禁用】，函数失去公网访问能力，
# 无法调用 MaaS / SIS / OBS / CSMS / EG 等公网服务，必须经 NAT 网关出网。
# 官方同时说明：购买公网 NAT 网关时，云端会自动在 VPC 默认路由表中
# 添加一条 0.0.0.0/0 指向该 NAT 网关的路由，故此处不再手工创建路由。
resource "huaweicloud_vpc_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  publicip {
    type = "5_bgp"
  }

  bandwidth {
    name        = "${local.name_prefix}-nat-bw"
    size        = 5
    share_type  = "PER"
    charge_mode = "traffic"
  }
}

resource "huaweicloud_nat_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  name          = "${local.name_prefix}-nat"
  spec          = "1"
  vpc_id        = huaweicloud_vpc.main.id
  subnet_id     = huaweicloud_vpc_subnet.main.id
  charging_mode = "postPaid"

  depends_on = [huaweicloud_vpc_eip.nat]
}

resource "huaweicloud_vpc_eip_associate" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  public_ip = huaweicloud_vpc_eip.nat[0].address
  port_id   = huaweicloud_nat_gateway.main[0].id
}

# SNAT 规则：让 10.0.1.0/24（函数所在子网）共享 NAT 的 EIP 出网
resource "huaweicloud_nat_snat_rule" "subnet" {
  count = var.enable_nat_gateway ? 1 : 0

  nat_gateway_id = huaweicloud_nat_gateway.main[0].id
  # cidr / network_id / subnet_id 三者只能指定其一
  subnet_id      = huaweicloud_vpc_subnet.main.id
  floating_ip_id = huaweicloud_vpc_eip.nat[0].id
  description    = "SNAT for FunctionGraph in ${local.name_prefix}-subnet"
}
