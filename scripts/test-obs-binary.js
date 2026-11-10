/**
 * 本地验证：OBS SDK putObject 在 Body 为 Buffer 时会破坏二进制。
 * 起因：utils.js:1393 走 Buffer.from(String(xml), 'utf8')，
 * Buffer 先被 String() 按 UTF-8 解码，非法字节变 U+FFFD 替换字符（3 字节），
 * 再重新编码 —— MP3 帧头 0xFF 0xFB 0x90 0xC4 全是非法字节，直接损坏。
 *
 * 本脚本用本地 HTTP server 抓取实际发出的请求体，验证：
 *   1. Body 为 Buffer  → 字节被破坏（且长度膨胀）
 *   2. Body 为 stream  → 字节原样送达
 * 不连真实 OBS，纯本地进程内验证。
 */
const http = require('http');
const { Readable } = require('stream');
const path = require('path');

const OBS = path.join(__dirname, '..', 'src', 'functions', 'generate-audio', 'node_modules', 'esdk-obs-nodejs');

const FRAME_LEN = 417;
const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
function buildSilentMp3(frameCount = 40) {
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const f = Buffer.alloc(FRAME_LEN, 0);
    HEADER.copy(f, 0);
    frames.push(f);
  }
  return Buffer.concat(frames);
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': '0' });
        res.end();
        srv.emit('captured', buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function capture(srv, fn) {
  return new Promise((resolve) => {
    srv.once('captured', resolve);
    fn();
  });
}

(async () => {
  const srv = await startServer();
  const port = srv.address().port;
  const ObsClient = require(path.join(OBS, 'lib', 'obs'));
  const expected = buildSilentMp3();

  const client = new ObsClient({
    access_key_id: 'AKFAKEFAKEFAKEFAKE',
    secret_access_key: 'SKfakefakefakefakefakefakefakefake',
    server: `127.0.0.1:${port}`,
    port: port,
    is_secure: false,
    path_style: true,
    max_retry_count: 1,
  });

  // 用例 1：Body 直接传 Buffer
  const gotBuf = await capture(srv, () => {
    client.putObject({
      Bucket: 'fake-bucket',
      Key: 'test.mp3',
      Body: expected,
      ContentType: 'audio/mpeg',
    });
  });

  // 用例 2：Body 传 Readable stream
  const gotStream = await capture(srv, () => {
    client.putObject({
      Bucket: 'fake-bucket',
      Key: 'test.mp3',
      Body: Readable.from([expected]),
      ContentType: 'audio/mpeg',
    });
  });

  const show = (label, got) => {
    const ok = got.equals(expected);
    console.log(`${label}`);
    console.log(`  期望字节 : ${expected.length}`);
    console.log(`  实际字节 : ${got.length}`);
    console.log(`  期望头   : ${expected.slice(0, 4).toString('hex')}`);
    console.log(`  实际头   : ${got.slice(0, 4).toString('hex')}`);
    console.log(`  是否一致 : ${ok ? '是 ✅' : '否 ❌'}`);
    console.log('');
  };

  console.log('=== 期望值 ===');
  console.log(`原始 MP3 字节数: ${expected.length}, 头: ${expected.slice(0, 4).toString('hex')}\n`);
  show('用例 1：Body = Buffer', gotBuf);
  show('用例 2：Body = Readable.from([buffer])', gotStream);

  srv.close();
})();
