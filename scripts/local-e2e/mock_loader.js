/**
 * 模块拦截器：把控制面 SDK 替换为本地 mock，
 * 数据面（@aws-sdk/client-dynamodb）保持真实，走假 DynamoDB 服务。
 */
const Module = require('module');
const orig = Module._load;

const calls = { egEvents: [], sisCalls: [], obsPuts: [], maasCalls: [] };

const mocks = {
  openai: {
    OpenAI: class {
      constructor(opts) { this.opts = opts; }
      chat = { completions: { create: async (args) => {
        calls.maasCalls.push(args);
        return { choices: [{ message: { content: 'The Moonlight Dragon\nOnce upon a time in a forest, a brave dragon shared moonlight with friends.\nThe end.' } }] };
      } } };
    },
  },
  '@huaweicloud/huaweicloud-sdk-csms': {
    CsmsRegion: { valueOf: (r) => r },
    CsmsClient: { newBuilder: () => ({
      withCredential() { return this; }, withRegion() { return this; },
      build: () => ({ showSecretVersion: async () => ({ version: { secret_string: JSON.stringify({ api_key: 'MOCK_MAAS_KEY' }) } }) }),
    }) },
    ShowSecretVersionRequest: class { withSecretName() { return this; } withVersionId() { return this; } },
  },
  '@huaweicloud/huaweicloud-sdk-eg': {
    EgRegion: { valueOf: (r) => r },
    EgClient: { newBuilder: () => ({
      withCredential() { return this; }, withRegion() { return this; },
      build: () => ({ putEvents: async (req) => { calls.egEvents.push(req); return { events: [] }; } }),
    }) },
    PutEventsRequest: class { withChannelId(v) { this.channelId = v; return this; } withBody(v) { this.body = v; return this; } },
    PutEventsReq: class { withEvents(v) { this.events = v; return this; } },
    CloudEvents: class {
      withId(v) { this.id = v; return this; } withSource(v) { this.source = v; return this; }
      withSpecversion(v) { this.specversion = v; return this; } withType(v) { this.type = v; return this; }
      withTime(v) { this.time = v; return this; } withData(v) { this.data = v; return this; }
    },
  },
  '@huaweicloud/huaweicloud-sdk-sis': {
    SisRegion: { valueOf: (r) => r },
    SisClient: { newBuilder: () => ({
      withCredential() { return this; }, withRegion() { return this; },
      build: () => ({ runTts: async (req) => {
        calls.sisCalls.push(req);
        // 返回**合法的 MP3 帧序列**（MPEG1 Layer3 / 128kbps / 44.1kHz，帧头 FF FB 90 C4），
        // 这样断言能真正校验「上传到 OBS 的字节是否被转码破坏」——若 Body 传 Buffer
        // 而非 Readable，esdk-obs-nodejs 会做 String(xml) 转码，首字节会变成 0xEF。
        const FRAME_LEN = 417;
        const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
        const frame = Buffer.alloc(FRAME_LEN);
        HEADER.copy(frame, 0);
        const mp3 = Buffer.concat([frame, frame, frame, frame]);
        return { result: { data: mp3.toString('base64') } };
      } }),
    }) },
    RunTtsRequest: class { withBody(v) { this.body = v; return this; } },
    PostCustomTTSReq: class { withText(v) { this.text = v; return this; } withConfig(v) { this.config = v; return this; } },
    TtsConfig: class { withAudioFormat(v) { this.audioFormat = v; return this; } withSampleRate(v) { this.sampleRate = v; return this; } withProperty(v) { this.property = v; return this; } },
  },
  'esdk-obs-nodejs': class {
    constructor(cfg) { this.cfg = cfg; }
    async putObject(o) {
      // Body 是 Readable stream（esdk-obs-nodejs 要求：Buffer 会被 String(xml) 转码破坏字节），
      // 这里把流收成 Buffer 一并记录，供断言校验字节保真。
      const chunks = [];
      if (o.Body && typeof o.Body.on === 'function') {
        for await (const c of o.Body) chunks.push(Buffer.from(c));
      } else if (Buffer.isBuffer(o.Body)) {
        chunks.push(o.Body);
      }
      o.BodyBuffer = Buffer.concat(chunks);
      calls.obsPuts.push(o);
      return { CommonMsg: { Status: 200, Message: 'OK' } };
    }
    createSignedUrlSync(o) {
      return { SignedUrl: `https://obs.mock/${o.Bucket}/${o.Key}?signature=MOCK&Expires=${o.Expires}` };
    }
  },
};

Module._load = function (request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  return orig.apply(this, arguments);
};

module.exports = { calls, mocks };
