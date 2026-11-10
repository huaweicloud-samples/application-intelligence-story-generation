/**
 * create-story —— 每日定时生成睡前故事
 *
 * 链路：定时触发 → 读取 characters / scenes → 调用 MaaS 生成故事（带 2 天 TTL 写入 stories 表）
 *       → 发布 StoryGenerated 领域事件（EG 自定义事件源），由 EG 订阅分发到语音合成与邮件通知。
 *
 * 凭据说明（数据面与控制面走的是两套凭据）：
 *   - 数据面（GeminiDB 兼容 DynamoDB）：使用实例管理员账号 rwuser + 实例密码，协议 http；
 *     数据面【不认】华为云 AK/SK，也不支持 securityToken。
 *   - 控制面（CSMS / EG）：使用 FunctionGraph 委托的临时凭证，
 *     通过 handler 的第二个参数 context 获取（getSecurityAccessKey / getSecuritySecretKey / getSecurityToken）。
 *     临时凭证【不会】以环境变量形式注入，SDK 也不会自动读取环境变量，
 *     因此所有客户端必须在 handler 内部构建。
 *
 * 环境变量：REGION / GEMINIDB_ENDPOINT / GEMINIDB_ACCESS_KEY / GEMINIDB_SECRET_KEY /
 *          CHARACTERS_TABLE / SCENES_TABLE / STORIES_TABLE / STORY_TTL_SECONDS /
 *          MAAS_CHAT_BASE_URL / MAAS_CHAT_MODEL / MAAS_SECRET_NAME /
 *          EG_CHANNEL_ID / EG_SOURCE_NAME / STORY_FRONTEND_URL
 */

const { DynamoDBClient, ScanCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');
const huaweicloudsdkcore = require('@huaweicloud/huaweicloud-sdk-core');
const csms = require('@huaweicloud/huaweicloud-sdk-csms');
const eg = require('@huaweicloud/huaweicloud-sdk-eg');

const REGION = process.env.REGION || 'cn-north-4';
const PROTOCOL = process.env.GEMINIDB_PROTOCOL || 'http';

// ---------------------------------------------------------------------------
// 数据面客户端：GeminiDB 兼容 DynamoDB 接口
// 端点形如 "10.0.1.10:8000"（由 Terraform 注入），协议默认 http
// ---------------------------------------------------------------------------
function buildDynamoClient() {
  return new DynamoDBClient({
    endpoint: `${PROTOCOL}://${process.env.GEMINIDB_ENDPOINT}`,
    region: REGION,
    credentials: {
      accessKeyId: process.env.GEMINIDB_ACCESS_KEY || 'rwuser',
      secretAccessKey: process.env.GEMINIDB_SECRET_KEY || '',
    },
  });
}

// ---------------------------------------------------------------------------
// 控制面客户端：从 FunctionGraph 委托获取临时凭证
// ---------------------------------------------------------------------------
function buildControlPlaneCredentials(context) {
  return new huaweicloudsdkcore.BasicCredentials()
    .withAk(context.getSecurityAccessKey())
    .withSk(context.getSecuritySecretKey())
    .withProjectId(process.env.HW_PROJECT_ID || '')
    .withSecurityToken(context.getSecurityToken());
}

function buildCsmsClient(context) {
  return csms.CsmsClient.newBuilder()
    .withCredential(buildControlPlaneCredentials(context))
    .withRegion(csms.CsmsRegion.valueOf(REGION))
    .build();
}

function buildEgClient(context) {
  return eg.EgClient.newBuilder()
    .withCredential(buildControlPlaneCredentials(context))
    .withRegion(eg.EgRegion.valueOf(REGION))
    .build();
}

// MaaS 统一推理入口（OpenAI 兼容端点），API Key 通过 CSMS 读取（同一轮执行内缓存）
//
// 注意：openai v4 的 timeout / maxRetries 必须放在【客户端构造参数】或
// RequestOptions（create 的第二个参数）上，放进 create() 的 body 里会被当成
// 请求体字段直接发给服务端而【完全不起作用】——那样 TCP 连接挂起时请求会
// 一直等到 SDK 默认超时（10 分钟），本函数的兜底逻辑就等不到触发时机。
async function getMaasClient(csmsClient) {
  const req = new csms.ShowSecretVersionRequest()
    .withSecretName(process.env.MAAS_SECRET_NAME)
    .withVersionId('v1');
  const res = await csmsClient.showSecretVersion(req);
  return new OpenAI({
    baseURL: process.env.MAAS_CHAT_BASE_URL || 'https://api.modelarts-maas.com/v2',
    apiKey: JSON.parse(res.version.secret_string).api_key,
    timeout: MAAS_TIMEOUT_MS,
    maxRetries: 0,
  });
}

async function listItems(dynamodb, tableName) {
  const res = await dynamodb.send(new ScanCommand({ TableName: tableName }));
  return (res.Items || []).map((item) => {
    const plain = {};
    for (const [k, v] of Object.entries(item)) plain[k] = Object.values(v)[0];
    return plain;
  });
}

// ---------------------------------------------------------------------------
// MaaS 推理 + 桩兜底
// ---------------------------------------------------------------------------
// 真实链路：MaaS（ModelArts Studio OpenAI 兼容端点）生成故事。
//
// 为什么需要兜底（真机实测，cn-north-4）：
//   FGS 函数挂 VPC 后容器内默认路由走 tunl_fgs_vpc 隧道，【公网不可达】：
//     api.modelarts-maas.com → 解析为公网 IP 1.95.59.212 / 1.95.81.128 → TCP 443 timeout。
//   而不挂 VPC 的函数访问同一地址是通的（返回 401，说明仅差 API Key）。
//   结论：MaaS 推理面在 cn-north-4 只能经 NAT 网关或专属终端节点访问，
//        本项目默认不建 NAT，故对 MaaS 调用加超时回退。
//
// 兜底行为：MaaS 不可用时用内置模板生成故事，保证
//   「读表 → 生成故事 → 落库 → 发布领域事件」这条主链路仍可真机验证，
//   并在返回值中标记 storySource=stub，便于验证报告如实区分。
// 补齐 TF_VAR_maas_api_key 并开通 NAT 后，同一份代码自动走真实推理，无需改动。
const MAAS_TIMEOUT_MS = Number(process.env.MAAS_TIMEOUT_MS || 8000);

function buildStubStory(characters, sceneDescription) {
  const names = characters.map((c) => c.name).join(' and ');
  const title = `The Moonlit Adventure of ${names}`;
  const description = [
    `Once upon a time, in ${sceneDescription}, ${names} set out beneath a sky full of stars.`,
    `They packed warm blankets, a small lantern, and three big promises to be brave.`,
    `"We will find the quietest song before the moon sleeps," they said together, and the wind agreed.`,
    `Step by step, they followed the silver path until the trees grew tall and the stars grew bright.`,
    `The moon leaned down low to listen, and the brook kept time with their footsteps,`,
    `tap and tap, as if it were counting the way home.`,
    `At last they found it: a little clearing where the grass hummed a lullaby all by itself.`,
    `Nobody spoke for a while. The lantern flickered once, twice, and then glowed steady and gold.`,
    `${names} sat down, and the whole forest fell quiet to listen.`,
    `Somewhere far away an owl said good night, and somewhere even farther a cloud`,
    `stretched itself out like a blanket over the sleeping hills.`,
    `And so the story ends the way the best ones do — with a warm blanket, a soft voice,`,
    `and everybody exactly where they belong. Good night.`,
  ].join(' ');
  return `${title}\n${description}`;
}

async function generateStoryWithMaas(csmsClient, prompt, characters, sceneDescription) {
  try {
    const client = await getMaasClient(csmsClient);
    const completion = await client.chat.completions.create({
      model: process.env.MAAS_CHAT_MODEL || 'qwen3-32b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7,
    });
    const content = (completion.choices[0].message.content || '').trim();
    if (!content) throw new Error('MaaS returned empty content');
    return { story: content, source: 'maas' };
  } catch (e) {
    const reason = String(e.message || e).slice(0, 200);
    console.warn(`[create-story] MaaS unavailable, falling back to stub story: ${reason}`);
    return { story: buildStubStory(characters, sceneDescription), source: 'stub' };
  }
}

exports.handler = async (event, context) => {
  const dynamodb = buildDynamoClient();
  const csmsClient = buildCsmsClient(context);
  const egClient = buildEgClient(context);

  const characters = await listItems(dynamodb, process.env.CHARACTERS_TABLE);
  const scenes = await listItems(dynamodb, process.env.SCENES_TABLE);
  if (!characters.length || !scenes.length) {
    throw new Error('characters/scenes 表为空，请先执行种子数据导入');
  }
  const selectedScene = scenes[Math.floor(Math.random() * scenes.length)];

  const prompt = `Write a title and a rhyming story on ${characters.length} main characters called ` +
    `${characters.map((c) => c.name).join(' and ')}. ` +
    `The story needs to be set within the scene ${selectedScene.description} and be at least 200 words long.`;

  const { story, source } = await generateStoryWithMaas(csmsClient, prompt, characters, selectedScene.description);

  const storyParts = story.split('\n');
  const title = storyParts.shift() || 'Untitled';
  const description = storyParts.join('\n');

  const storyId = uuidv4();
  const ttl = Math.floor(Date.now() / 1000) + Number(process.env.STORY_TTL_SECONDS || 172800);

  await dynamodb.send(new PutItemCommand({
    TableName: process.env.STORIES_TABLE,
    Item: marshall({
      id: storyId,
      title,
      characters,
      description,
      ttl,
      scene: selectedScene.description,
      storySource: source,
      createdAt: new Date().toISOString(),
    }),
  }));

  // 领域事件发布：写入成功后直接发布 StoryGenerated，EG 订阅负责一对多分发
  const publishReq = new eg.PutEventsRequest()
    .withChannelId(process.env.EG_CHANNEL_ID)
    .withBody(new eg.PutEventsReq().withEvents([
      new eg.CloudEvents()
        .withId(storyId)
        .withSource(process.env.EG_SOURCE_NAME)
        .withSpecversion('1.0')
        .withType('StoryGenerated')
        .withTime(new Date().toISOString())
        .withData({ id: storyId, title, description, scene: selectedScene.description }),
    ]));
  await egClient.putEvents(publishReq);

  return {
    statusCode: 200,
    body: JSON.stringify({ id: storyId, title, storySource: source }),
  };
};
