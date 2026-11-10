# 架构说明

## 总体架构

本实践是一套事件驱动的定时内容生成系统：每日固定时间由函数自动生成一篇儿童睡前故事并持久化，随后以领域事件驱动语音合成与邮件通知两条异步链路，前端页面按需展示故事。

```
                            ┌────────────┐
                            │ 定时触发器 │
                            └──────┬─────┘
                                   │ 每日 19:15
                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│                    FunctionGraph  create-story                     │
│   读 characters/scenes、调 MaaS 生成故事、写 stories（TTL 2 天）   │
└───────────────┬─────────────────────────────────────┬──────────────┘
                │ 写 stories                          │ 发布事件
                ▼                                     ▼
┌──────────────────────────────┐      ┌──────────────────────────────┐
│    GeminiDB 兼容接口实例     │      │         EG 事件网格          │
│characters / scenes / stories │      │  自定义事件源 + 事件订阅 ×2  │
│       TTL 到期自动清理       │      │      按事件类型路由分发      │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │                                     │
                │                             ┌───────┴───────┐
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │  generate   │ │SMN 邮件通知 │
                │                      │ audio 函数  │ │ 故事页链接  │
                │                      │SIS 合成 MP3 │ │含 /story?id=│
                │                      └──────┬──────┘ └──────┬──────┘
                │                             │               │
                │                             ▼               ▼
                │                      ┌─────────────┐ ┌─────────────┐
                │                      │ OBS 音频桶  │ │  用户邮箱   │
                │                      │ 预签名 URL  │ │点击链接打开 │
                │                      └──────┬──────┘ └──────┬──────┘
                │
                │ 读 stories                  │ 播放音频      │ 访问
                ▼                             ▼               ▼
┌────────────────────────────────────────────────────────────────────┐
│                     CAE 前端应用（NextJS SSR）                     │
│     GET /          GET /story?id=...          GET /api/health      │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
                            ┌────────────┐
                            │ 用户浏览器 │
                            └────────────┘

语音合成完成后回写 stories.audioURL，CAE 按 id 读取故事并播放音频
```

## 关键组件

| 组件 | 服务 | 职责 |
|---|---|---|
| create-story | FunctionGraph | 定时（每日 19:15）读取角色与场景，调用 MaaS 生成故事，写入 stories 表（2 天 TTL），随后发布 StoryGenerated 领域事件 |
| 事件路由 | EG 事件网格 | 自定义事件源接收 StoryGenerated，两条订阅分别路由到语音合成函数与 SMN 邮件主题 |
| generate-audio | FunctionGraph | 事件触发，调 SIS 语音合成生成 MP3，上传 OBS 并生成 2 天有效期预签名 URL，回写 stories.audioURL |
| 邮件通知 | SMN | 订阅邮箱收到包含前端故事页地址的邮件 |
| 故事前端 | CAE | NextJS SSR 容器应用，按 id 读取 stories 表渲染故事页，音频/图缺失时自动回退 |
| 数据存储 | GeminiDB（DynamoDB 兼容） | characters / scenes / stories 三张表；stories 表使用 DynamoDB 兼容 TTL（字段 ttl） |
| 音频存储 | OBS | 私有桶存放音频对象，前端经预签名 URL 播放 |
| 密钥托管 | DEW-CSMS | 托管 MaaS API Key，函数运行时读取 |
| 模型推理 | MaaS（ModelArts Studio） | OpenAI 兼容接口，默认 DeepSeek 预置模型，按故事提示词生成文本 |

## 华为云网络形态与桩兜底（真机实测结论）

FGS 函数挂 VPC 后，默认网卡走 `tunl_fgs_vpc` 隧道，**公网不可达**。因此不建 NAT 网关，
改为利用**华为云内网服务地址在 VPC 内天然可达**的特性：

| 依赖 | 形态 | 实测结论 |
|---|---|---|
| EG / OBS / KMS / CSMS / ModelArts | 内网服务地址 `100.125.x.x` | ✅ VPC 内可达，无需终端节点 |
| MaaS 推理面 `api.modelarts-maas.com` | 公网 IP | ❌ 无 NAT 不可达 → **内置桩故事兜底** |
| SIS 语音合成 | 内网可达，但强制要求专属终端节点 | ⚠️ 终端节点未开放 → **内置静音 MP3 兜底** |

因此 create-story 与 generate-audio 均采用「**先尝试真实调用，超时/失败则回退到内置桩**」的模式，
并在落库与返回值中带上 `storySource` / `audioSource` 字段如实标注来源（`maas` / `sis` / `stub`），
不做美化。补上真实 MaaS Key 并开通 NAT（或取消函数挂 VPC）后，无需改代码即可切回真实推理。

> 关键实测：**不挂 VPC 的 FGS 函数可通 MaaS**（返回 `401 Invalid authorization header`，说明网络通、仅缺 Key）；
> 挂 VPC 的函数对同一地址 timeout。这证明 NAT（或取消挂载）是 MaaS 接入的唯一缺口。


## 数据流

1. **定时生成**：定时触发器每日 19:15 调用 create-story。
2. **故事写入**：create-story 随机选择场景、组装全部角色为提示词，调用 MaaS 生成标题 + 200 词以上的韵文故事，以 uuid 为主键写入 stories 表，ttl 字段为写入时间 + 2 天（到期自动清理）。
3. **领域事件**：写入成功后，create-story 向 EG 自定义事件源发布 StoryGenerated 事件（data 含 id/title/description/scene）。
4. **一对多分发**：EG 按事件源过滤，将事件同时投递给 generate-audio 函数（FUNC 目标）与 SMN 主题（SMN 目标）。
5. **语音合成**：generate-audio 按句子分段调用 SIS 短语音合成，MP3 字节流拼接后上传 OBS `stories/{id}/audio.mp3`，生成 2 天预签名 URL 并回写 stories.audioURL。
6. **邮件与阅读**：邮件中链接指向 `/story?id=<storyId>`；前端容器从 stories 表读取故事，有音频则播放、无音频回退纯文本。
