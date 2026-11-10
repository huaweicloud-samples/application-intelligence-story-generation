/**
 * 本地端到端验证：create-story + generate-audio
 *  - 数据面：真实 @aws-sdk/client-dynamodb → 本地假 DynamoDB（协议/语义一致）
 *  - 控制面：CSMS / EG / SIS / OBS / MaaS 全部 mock
 */
const path = require('path');
const assert = require('assert');
const { calls } = require('./mock_loader');
const { server, tables, ensureTable } = require('./fake_dynamo');

// 相对定位产物根，避免硬编码本机绝对路径（仓库克隆到任意目录都可跑）
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 18080;
const EP = `127.0.0.1:${PORT}`;

process.env.REGION = 'cn-north-4';
process.env.GEMINIDB_PROTOCOL = 'http';
process.env.GEMINIDB_ENDPOINT = EP;
process.env.GEMINIDB_ACCESS_KEY = 'rwuser';
process.env.GEMINIDB_SECRET_KEY = 'MOCK_DB_PASSWORD';
process.env.CHARACTERS_TABLE = 'characters';
process.env.SCENES_TABLE = 'scenes';
process.env.STORIES_TABLE = 'stories';
process.env.STORY_TTL_SECONDS = '172800';
process.env.MAAS_CHAT_BASE_URL = 'https://api.modelarts-maas.com/v2';
process.env.MAAS_CHAT_MODEL = 'deepseek-v3.2';
process.env.MAAS_SECRET_NAME = 'ai-story-generation-maas-key';
process.env.EG_CHANNEL_ID = 'CHANNEL_ID_MOCK';
process.env.EG_SOURCE_NAME = 'ai-story-generation-story-created';
process.env.STORY_FRONTEND_URL = '';
process.env.HW_PROJECT_ID = 'PROJECT_ID_MOCK';
process.env.AUDIO_BUCKET = 'ai-story-generation-audio-mock';
process.env.PRESIGN_EXPIRES = '172800';
process.env.SIS_VOICE = 'english_amy_common';
process.env.SIS_SAMPLE_RATE = '16000';
process.env.SIS_FORMAT = 'mp3';

const context = {
  getSecurityAccessKey: () => 'MOCK_AK',
  getSecuritySecretKey: () => 'MOCK_SK',
  getSecurityToken: () => 'MOCK_TOKEN',
};

function seed() {
  const characters = [
    { id: 'c1', name: 'Luna', description: 'a curious cat' },
    { id: 'c2', name: 'Bobo', description: 'a loyal dog' },
  ];
  const scenes = [
    { id: 's1', description: 'a moonlit forest clearing' },
    { id: 's2', description: 'a quiet village by the sea' },
  ];
  const c = ensureTable('characters'), s = ensureTable('scenes');
  for (const x of characters) c.set(x.id, { id: { S: x.id }, name: { S: x.name }, description: { S: x.description } });
  for (const x of scenes) s.set(x.id, { id: { S: x.id }, description: { S: x.description } });
  return { characters, scenes };
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const seeded = seed();
  console.log('✔ 假 DynamoDB 启动于', EP, '；已注入', seeded.characters.length, '个角色 /', seeded.scenes.length, '个场景');

  // ---------- 1. create-story ----------
  const createStory = require(path.join(REPO, 'src/functions/create-story/index.js'));
  const res1 = await createStory.handler({ triggerSource: 'TIMER' }, context);
  const body1 = JSON.parse(res1.body);
  assert.strictEqual(res1.statusCode, 200);
  assert.ok(body1.id, '应返回故事 id');
  assert.ok(body1.title, '应返回标题');
  console.log('✔ create-story 返回:', JSON.stringify(body1));

  // MaaS 调用参数校验
  assert.strictEqual(calls.maasCalls.length, 1, '应调用 MaaS 一次');
  assert.strictEqual(calls.maasCalls[0].model, 'deepseek-v3.2');
  const prompt = calls.maasCalls[0].messages[0].content;
  assert.ok(prompt.includes('Luna') && prompt.includes('Bobo'), 'prompt 应含角色名');
  assert.ok(prompt.includes('moonlit forest') || prompt.includes('village'), 'prompt 应含场景');
  assert.ok(calls.maasCalls[0].max_tokens === 1000 && calls.maasCalls[0].temperature === 0.7);
  console.log('✔ MaaS 调用参数正确: model=deepseek-v3.2, max_tokens=1000, temperature=0.7');
  console.log('  prompt:', prompt);

  // 数据面写入校验
  const stories = tables.get('stories');
  assert.strictEqual(stories.size, 1, 'stories 表应有 1 条记录');
  const item = Array.from(stories.values())[0];
  assert.ok(item.id && item.title && item.description && item.scene, '故事字段应齐全');
  const ttl = Number(item.ttl.N);
  const expectTtl = Math.floor(Date.now() / 1000) + 172800;
  assert.ok(Math.abs(ttl - expectTtl) < 60, `TTL 应约等于 now+172800，实际 ${ttl}`);
  console.log('✔ stories 写入正确: id/title/description/scene/ttl 齐全, ttl=now+172800');
  console.log('  title =', item.title.S, '| scene =', item.scene.S);

  // 领域事件发布校验
  assert.strictEqual(calls.egEvents.length, 1, '应发布 1 个 EG 事件');
  const egReq = calls.egEvents[0];
  assert.strictEqual(egReq.channelId, 'CHANNEL_ID_MOCK');
  const ev = egReq.body.events[0];
  assert.strictEqual(ev.type, 'StoryGenerated', '事件类型应为 StoryGenerated');
  assert.strictEqual(ev.source, 'ai-story-generation-story-created');
  assert.strictEqual(ev.id, body1.id, '事件 id 应与故事 id 一致');
  assert.strictEqual(ev.specversion, '1.0');
  assert.ok(ev.data.title && ev.data.description, '事件数据应含故事内容');
  console.log('✔ 领域事件发布正确: type=StoryGenerated, source=ai-story-generation-story-created, id 与故事一致');

  // ---------- 2. generate-audio ----------
  const generateAudio = require(path.join(REPO, 'src/functions/generate-audio/index.js'));
  const res2 = await generateAudio.handler({ detail: { id: body1.id, title: item.title.S, description: item.description.S } }, context);
  const body2 = JSON.parse(res2.body);
  assert.strictEqual(res2.statusCode, 200);
  assert.ok(body2.audioURL.includes('signature=MOCK'), '应返回预签名 URL');
  console.log('✔ generate-audio 返回:', JSON.stringify(body2));

  // SIS 调用校验
  assert.ok(calls.sisCalls.length >= 1, '应调用 SIS 语音合成');
  const cfg = calls.sisCalls[0].body.config;
  assert.strictEqual(cfg.property, 'english_amy_common');
  assert.strictEqual(cfg.audioFormat, 'mp3');
  assert.strictEqual(cfg.sampleRate, '16000');
  console.log('✔ SIS 调用参数正确: voice=english_amy_common, format=mp3, sample_rate=16000, 共', calls.sisCalls.length, '段');

  // OBS 上传校验
  assert.strictEqual(calls.obsPuts.length, 1, '应上传 1 个音频对象');
  const put = calls.obsPuts[0];
  assert.strictEqual(put.Bucket, 'ai-story-generation-audio-mock');
  assert.strictEqual(put.Key, `stories/${body1.id}/audio.mp3`);
  assert.strictEqual(put.ContentType, 'audio/mpeg');
  assert.ok(put.BodyBuffer && put.BodyBuffer.length > 0, '音频内容非空');
  // MP3 帧头必须是 0xFF 0xFB（若被 String(xml) 转码破坏，首字节会变成 0xEF）
  assert.strictEqual(put.BodyBuffer[0], 0xff, 'MP3 首字节应为 0xFF');
  assert.strictEqual(put.BodyBuffer[1], 0xfb, 'MP3 第二字节应为 0xFB');
  console.log('✔ OBS 上传正确: key=' + put.Key + ', content-type=' + put.ContentType + ', bytes=' + put.BodyBuffer.length);

  // 回写校验
  const updated = Array.from(tables.get('stories').values())[0];
  assert.ok(updated.audioURL, 'stories.audioURL 应已回写');
  assert.ok(updated.audioURL.S.includes('Expires=172800'), '预签名有效期应为 2 天');
  console.log('✔ stories.audioURL 回写成功, 有效期 172800 秒 (2 天)');

  // ---------- 3. 负向用例 ----------
  let threw = false;
  try { await generateAudio.handler({ detail: { title: 'x' } }, context); } catch (e) { threw = /missing story id/.test(e.message); }
  assert.ok(threw, '缺 story id 时应抛错');
  console.log('✔ 负向用例: 缺少 story id 时按预期抛出错误');

  server.close();
  console.log('\n===== 本地端到端验证全部通过 =====');
})().catch((e) => { console.error('✘ 验证失败:', e); process.exit(1); });
