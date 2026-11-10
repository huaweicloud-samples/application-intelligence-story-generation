/**
 * 查询 GeminiDB 中的 stories 表（验证链路产物）
 *
 * 用法：
 *   export GEMINIDB_ENDPOINT="<host>:<port>"
 *   export GEMINIDB_ACCESS_KEY="rwuser"
 *   export GEMINIDB_SECRET_KEY="<实例管理员密码>"
 *   node scripts/query-stories.js [表名，默认 stories]
 */
const path = require('path');
const { DynamoDBClient, ScanCommand } = require(
  path.resolve(__dirname, '..', 'src', 'functions', 'create-story', 'node_modules', '@aws-sdk', 'client-dynamodb')
);

const REGION = process.env.REGION || 'cn-north-4';
const PROTOCOL = process.env.GEMINIDB_PROTOCOL || 'http';
const table = process.argv[2] || 'stories';

const client = new DynamoDBClient({
  endpoint: `${PROTOCOL}://${process.env.GEMINIDB_ENDPOINT}`,
  region: REGION,
  credentials: {
    accessKeyId: process.env.GEMINIDB_ACCESS_KEY || 'rwuser',
    secretAccessKey: process.env.GEMINIDB_SECRET_KEY || '',
  },
});

function plain(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    const val = Object.values(v)[0];
    out[k] = val && typeof val === 'object' && 'S' in val ? val.S : val;
  }
  return out;
}

(async () => {
  const res = await client.send(new ScanCommand({ TableName: table }));
  const items = (res.Items || []).map(plain);
  console.log(`${table}: ${items.length} 条`);
  for (const it of items) {
    console.log('---');
    console.log(JSON.stringify(it, null, 1).slice(0, 2000));
  }
})().catch((e) => {
  console.error('查询失败:', e.name, e.message);
  process.exit(1);
});
