/**
 * generate-audio —— 故事语音合成
 *
 * 链路：EG 事件触发（StoryGenerated）→ SIS 语音合成（分段短语音、MP3）→ 音频入 OBS
 *       → 生成 2 天有效期的预签名 URL → 回写 stories 表 audioURL 字段。
 *
 * 凭据说明：
 *   - 数据面（GeminiDB 兼容 DynamoDB）：rwuser + 实例密码，协议 http。
 *   - 控制面（SIS / OBS）：FunctionGraph 委托临时凭证，取自 handler 的 context 参数；
 *     OBS SDK 需显式传入 security_token。
 *
 * 环境变量：REGION / GEMINIDB_ENDPOINT / GEMINIDB_ACCESS_KEY / GEMINIDB_SECRET_KEY /
 *          STORIES_TABLE / AUDIO_BUCKET / PRESIGN_EXPIRES / SIS_VOICE / SIS_SAMPLE_RATE / SIS_FORMAT
 */

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { Readable } = require('stream');
const ObsClient = require('esdk-obs-nodejs');
const huaweicloudsdkcore = require('@huaweicloud/huaweicloud-sdk-core');
const sis = require('@huaweicloud/huaweicloud-sdk-sis');

const REGION = process.env.REGION || 'cn-north-4';
const PROTOCOL = process.env.GEMINIDB_PROTOCOL || 'http';

// ---------------------------------------------------------------------------
// 数据面客户端：GeminiDB 兼容 DynamoDB 接口
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
// 控制面客户端：委托临时凭证
// ---------------------------------------------------------------------------
function buildControlPlaneCredentials(context) {
  return new huaweicloudsdkcore.BasicCredentials()
    .withAk(context.getSecurityAccessKey())
    .withSk(context.getSecuritySecretKey())
    .withProjectId(process.env.HW_PROJECT_ID || '')
    .withSecurityToken(context.getSecurityToken());
}

function buildSisClient(context) {
  return sis.SisClient.newBuilder()
    .withCredential(buildControlPlaneCredentials(context))
    .withRegion(sis.SisRegion.valueOf(REGION))
    .build();
}

// OBS 客户端需显式带上临时凭证的 security_token
function buildObsClient(context) {
  return new ObsClient({
    access_key_id: context.getSecurityAccessKey(),
    secret_access_key: context.getSecuritySecretKey(),
    security_token: context.getSecurityToken(),
    server: `https://obs.${REGION}.myhuaweicloud.com`,
  });
}

// 短语音合成单段文本上限约 500 字符，超长故事分段合成后按字节拼接
const MAX_CHUNK = 400;
function chunkText(text) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > MAX_CHUNK) {
      if (cur) chunks.push(cur.trim());
      cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

async function synthesize(sisClient, text) {
  // SIS 短语音合成：RunTtsRequest.body 为 PostCustomTTSReq，音色通过 TtsConfig.property 指定
  // sample_rate 仅支持 16000/8000，audio_format 支持 wav/mp3/pcm
  const req = new sis.RunTtsRequest().withBody(
    new sis.PostCustomTTSReq()
      .withText(text)
      .withConfig(new sis.TtsConfig()
        .withAudioFormat(process.env.SIS_FORMAT || 'mp3')
        .withSampleRate(process.env.SIS_SAMPLE_RATE || '16000')
        .withProperty(process.env.SIS_VOICE || 'english_amy_common'))
  );
  const res = await sisClient.runTts(req);
  return Buffer.from(res.result.data, 'base64');
}

// ---------------------------------------------------------------------------
// SIS 调用 + 占位音频兜底
// ---------------------------------------------------------------------------
// 真机实测结论（cn-north-4）：SIS 对 VPC 内客户端【强制要求终端节点】，
// 报 SIS.0035 inner network client should use VPC endpoint to call SIS.；
// 官方终端节点服务名 cn-north-4.apig-sis.1e71d41d-... 不在本区域终端节点
// 公共服务目录内（141 个服务中无 sis / apig-sis），按 service_name /
// service_id 各种组合创建均返回 EndPoint.0002 Parameter error.
// → 需工单开通后方可真实合成。
//
// 兜底行为：SIS 不可用时生成一段 100% 静音的合法 MP3 帧序列作为占位音频，
// 仍然走完「上传 OBS → 生成预签名 URL → 回写 stories.audioURL」全链路，
// 并在返回值/数据库中标记 audioSource=stub，便于验证报告如实区分。
// 终端节点开通后，同一份代码自动走真实合成，无需改动。

/** 生成 44.1kHz / 128kbps / 单声道的静音 MP3 帧序列 */
function buildSilentMp3(frameCount = 40) {
  // MPEG1 Layer3, 128kbps, 44.1kHz, 无填充 → 帧长 = 144 * 128000 / 44100 = 417 字节
  const FRAME_LEN = 417;
  const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = Buffer.alloc(FRAME_LEN, 0);
    HEADER.copy(frame, 0);
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

async function synthesizeWithFallback(sisClient, text) {
  try {
    const audio = await synthesize(sisClient, text);
    if (!audio || !audio.length) throw new Error('SIS returned empty audio');
    return { audio, source: 'sis' };
  } catch (e) {
    const reason = String(e.message || e).slice(0, 200);
    console.warn(`[generate-audio] SIS unavailable, falling back to silent placeholder: ${reason}`);
    return { audio: buildSilentMp3(), source: 'stub' };
  }
}

exports.handler = async (event, context) => {
  const dynamodb = buildDynamoClient();
  const sisClient = buildSisClient(context);
  const obs = buildObsClient(context);

  // EG 触发事件结构兼容：{ detail: {...} } 或 { events: [{ data: {...} }] }
  const payload = event.detail || (event.events && event.events[0] && (event.events[0].data || event.events[0])) || event;
  const { id, title, description } = payload;
  if (!id) {
    throw new Error('StoryGenerated event missing story id');
  }

  const text = `This is a story called ${title}. ${description}`;
  const chunks = chunkText(text);
  const parts = [];
  let source = 'sis';
  for (const chunk of chunks) {
    const r = await synthesizeWithFallback(sisClient, chunk);
    if (r.source === 'stub') source = 'stub';
    parts.push(r.audio);
  }
  // 全部走兜底时只保留一份静音占位，避免拼接出多段空音频
  const audio = source === 'stub' ? parts[0] : Buffer.concat(parts);

  const key = `stories/${id}/audio.mp3`;
  // Body 必须传 Readable stream，不能直接传 Buffer：
  // esdk-obs-nodejs 在 utils.js:1393 走 Buffer.from(String(xml), 'utf8')，
  // Buffer 先被 String() 按 UTF-8 解码，MP3 帧头 0xFF 0xFB 0x90 0xC4 等非法字节
  // 会变成 U+FFFD 替换字符（3 字节），二进制被破坏（16680 → 17000 字节）。
  // 传 stream 时 SDK 跳过该转码，字节原样送达。回归用例见 scripts/test-obs-binary.js。
  const put = await obs.putObject({
    Bucket: process.env.AUDIO_BUCKET,
    Key: key,
    Body: Readable.from([audio]),
    ContentType: 'audio/mpeg',
  });
  if (put.CommonMsg.Status >= 300) {
    throw new Error(`Failed to upload audio: ${put.CommonMsg.Message}`);
  }

  const signed = obs.createSignedUrlSync({
    Method: 'GET',
    Bucket: process.env.AUDIO_BUCKET,
    Key: key,
    Expires: Number(process.env.PRESIGN_EXPIRES || 172800),
  });
  if (!signed.SignedUrl) {
    throw new Error('Failed to create signed URL for audio');
  }

  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.STORIES_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET audioURL = :u, audioSource = :s',
    ExpressionAttributeValues: { ':u': { S: signed.SignedUrl }, ':s': { S: source } },
  }));

  return { statusCode: 200, body: JSON.stringify({ id, audioURL: signed.SignedUrl, audioSource: source }) };
};
