// 按精确 key 读取 OBS 对象并校验 MP3 字节保真。
// 读取走【预签名 URL + fetch】路径：SDK 的 getObject 回调里 Body 未正确回填，
// 而预签名 URL 可直接拿到完整字节（此前 VPC 内 verify 函数亦用此路径校验过）。
// 用法：node obs_get_key.js <bucket> <key> [key2 ...]
const ObsClient = require('esdk-obs-nodejs');

const bucket = process.argv[2];
const keys = process.argv.slice(3);
const client = new ObsClient({
  access_key_id: process.env.HUAWEICLOUD_AK,
  secret_access_key: process.env.HUAWEICLOUD_SK,
  server: 'obs.cn-north-4.myhuaweicloud.com',
  port: 443,
  is_secure: true,
  max_retry_count: 1,
});

if (!bucket || !keys.length) {
  console.log('用法: node obs_get_key.js <bucket> <key> [key...]');
  process.exit(1);
}

async function check(key) {
  const signed = client.createSignedUrlSync({
    Method: 'GET',
    Bucket: bucket,
    Key: key,
    Expires: 300,
  });
  const res = await fetch(signed.SignedUrl);
  if (!res.ok) {
    console.log(' ', key, 'HTTP', res.status);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.slice(0, 4).toString('hex');
  console.log(' ', key, 'bytes=', buf.length, 'magic=', magic,
    buf.length === 16680 && magic === 'fffb90c4'
      ? '✅ 字节保真' : '⚠️ 与期望(16680/fffb90c4)不符');
}

(async () => {
  for (const k of keys) {
    try {
      await check(k);
    } catch (e) {
      console.log(' ', k, 'ERR', String(e).slice(0, 120));
    }
  }
  process.exit(0);
})();
