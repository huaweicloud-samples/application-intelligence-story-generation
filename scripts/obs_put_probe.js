// 账号受限范围探测（OBS 写操作）
// 目的：判别 FSS.0403 是「账号整体欠费受限」还是「仅 FGS 服务受限」。
// OBS 官方错误码 UserRestricted = 账号受限或冻结，是最灵敏的判别器。
// 用法：node obs_probe.js <bucket>   （AK/SK 从环境变量读，不落盘）
const ObsClient = require('esdk-obs-nodejs');

const bucket = process.argv[2] || 'ai-story-generation-audio';
const client = new ObsClient({
  access_key_id: process.env.HUAWEICLOUD_AK,
  secret_access_key: process.env.HUAWEICLOUD_SK,
  server: 'obs.cn-north-4.myhuaweicloud.com',
  port: 443,
  is_secure: true,
  max_retry_count: 1,
});

client.putObject(
  { Bucket: bucket, Key: 'probe/account-state-check.txt', Body: 'probe' },
  (err, resp) => {
    if (err) {
      console.log('[obs-put] FAIL code=', err.code, 'msg=', err.message);
      console.log('[obs-put] statusCode=', err.statusCode, 'requestId=', err.requestId);
    } else {
      console.log('[obs-put] OK etag=', resp.etag);
    }
  }
);
