/**
 * 种子数据导入：向 GeminiDB（DynamoDB 兼容）写入 characters / scenes
 *
 * 用法：
 *   export GEMINIDB_ENDPOINT="<host>:<port>"     # terraform output geminidb_host_port
 *   export GEMINIDB_ACCESS_KEY="rwuser"
 *   export GEMINIDB_SECRET_KEY="<实例管理员密码>"
 *   export GEMINIDB_PROTOCOL="http"               # 可选，默认 http
 *   node scripts/seed-data.js
 *
 * 说明：
 *   - GeminiDB 兼容 DynamoDB 接口的数据面只认实例管理员账号 rwuser + 实例密码，
 *     不接受华为云 AK/SK，也不支持 securityToken。
 *   - 协议为 http（官方 Java 示例即用 http）。
 */
const { DynamoDBClient, BatchWriteItemCommand, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const characters = require('./characters.json');
const scenes = require('./scenes.json');

const REGION = process.env.REGION || 'cn-north-4';
const PROTOCOL = process.env.GEMINIDB_PROTOCOL || 'http';

const client = new DynamoDBClient({
  endpoint: `${PROTOCOL}://${process.env.GEMINIDB_ENDPOINT}`,
  region: REGION,
  credentials: {
    accessKeyId: process.env.GEMINIDB_ACCESS_KEY || 'rwuser',
    secretAccessKey: process.env.GEMINIDB_SECRET_KEY || '',
  },
});

// GeminiDB 兼容接口的表在首次写入时自动创建，此处显式创建以获得明确报错。
//
// 注意：GeminiDB 兼容 DynamoDB 接口【不支持 PAY_PER_REQUEST】，
// 实测报 ValidationException: No provisioned throughput specified for the table，
// 必须显式给出 ProvisionedThroughput。
async function ensureTable(tableName, ttlAttribute) {
  const params = {
    TableName: tableName,
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
  };
  if (ttlAttribute) {
    params.TimeToLiveSpecification = { Enabled: true, AttributeName: ttlAttribute };
  }
  try {
    await client.send(new CreateTableCommand(params));
    console.log(`table ${tableName} created`);
  } catch (e) {
    if (e.name === 'ResourceInUseException' || /already exists/i.test(e.message || '')) {
      console.log(`table ${tableName} already exists`);
    } else {
      throw e;
    }
  }
}

const insertIntoDDB = async () => {
  await ensureTable('characters');
  await ensureTable('scenes');
  await ensureTable('stories', 'ttl');

  // insert characters
  await client.send(
    new BatchWriteItemCommand({
      RequestItems: {
        characters: characters.map((character) => ({
          PutRequest: {
            Item: marshall(character),
          },
        })),
      },
    })
  );

  // insert scenes
  await client.send(
    new BatchWriteItemCommand({
      RequestItems: {
        scenes: scenes.map((scene) => ({
          PutRequest: {
            Item: marshall(scene),
          },
        })),
      },
    })
  );
};

insertIntoDDB()
  .then(() => console.log('seed data inserted'))
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  });
