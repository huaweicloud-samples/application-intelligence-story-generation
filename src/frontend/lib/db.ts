import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// GeminiDB 提供 DynamoDB 兼容接口：
//   - 数据面只认实例管理员账号（rwuser）+ 实例密码，不接受华为云 AK/SK，也不支持 securityToken
//   - 协议为 http（端点形如 "10.0.1.10:8000"）
// 前端容器与 GeminiDB 同处 VPC，走内网端点。
const client = new DynamoDBClient({
  region: process.env.REGION,
  endpoint: `http://${process.env.GEMINIDB_ENDPOINT}`,
  credentials: {
    accessKeyId: process.env.GEMINIDB_ACCESS_KEY || 'rwuser',
    secretAccessKey: process.env.GEMINIDB_SECRET_KEY || '',
  },
});

export const getStory = async (id: string) => {
  try {
    const { Item: story } = await client.send(
      new GetItemCommand({
        TableName: process.env.TABLE_NAME,
        Key: marshall({
          id
        }),
      })
    );

    if (story) {
      return unmarshall(story);
    } else {
      return null;
    }
  } catch (error) {
    console.log('error', error);
    return null;
  }
};
