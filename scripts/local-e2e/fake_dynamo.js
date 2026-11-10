/**
 * 最小 DynamoDB 兼容数据面模拟器（内存版）
 * 验证 create-story / generate-audio 的数据面读写语义，不依赖真实云资源。
 */
const http = require('http');
const crypto = require('crypto');

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** DynamoDB 风格 AttributeValue 编解码 */
const AV = {
  s: (v) => ({ S: v }),
  n: (v) => ({ N: String(v) }),
  b: (v) => ({ B: v }),
  bool: (v) => ({ BOOL: v }),
  l: (v) => ({ L: v.map(AV.s) }),
  m: (v) => ({ M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, AV.s(x)])) }),
};
function decode(av) {
  const t = Object.keys(av)[0];
  switch (t) {
    case 'S': return av.S;
    case 'N': return Number(av.N);
    case 'BOOL': return av.BOOL;
    case 'L': return av.L.map(decode);
    case 'M': return Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, decode(v)]));
    case 'NULL': return null;
    default: return av[t];
  }
}
const tables = new Map(); // name -> Map(id -> item)
function ensureTable(name) {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const target = (req.headers['x-amz-target'] || '').split('.').pop();
    let op = target;
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    const reply = (obj, status = 200) => {
      const s = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/x-amz-json-1.0', 'x-amz-crc32': '0' });
      res.end(s);
    };

    if (op === 'CreateTable') {
      ensureTable(payload.TableName);
      return reply({ TableDescription: { TableName: payload.TableName, TableStatus: 'ACTIVE' } });
    }
    if (op === 'PutItem') {
      const t = ensureTable(payload.TableName);
      const item = Object.fromEntries(Object.entries(payload.Item).map(([k, v]) => [k, decode(v)]));
      t.set(item.id, payload.Item);
      return reply({});
    }
    if (op === 'BatchWriteItem') {
      for (const [tn, items] of Object.entries(payload.RequestItems || {})) {
        const t = ensureTable(tn);
        for (const r of items) {
          const item = Object.fromEntries(Object.entries(r.PutRequest.Item).map(([k, v]) => [k, decode(v)]));
          t.set(item.id, r.PutRequest.Item);
        }
      }
      return reply({ UnprocessedItems: {} });
    }
    if (op === 'Scan') {
      const t = ensureTable(payload.TableName);
      const items = Array.from(t.values());
      return reply({ Items: items, Count: items.length, ScannedCount: items.length });
    }
    if (op === 'GetItem') {
      const t = ensureTable(payload.TableName);
      const key = decode(payload.Key.id);
      const it = t.get(key);
      return reply(it ? { Item: it } : {});
    }
    if (op === 'UpdateItem') {
      const t = ensureTable(payload.TableName);
      const key = decode(payload.Key.id);
      const cur = t.get(key) || {};
      const upd = payload.ExpressionAttributeValues || {};
      const names = payload.ExpressionAttributeNames || {};
      // 简单支持 SET #a = :v 形式
      const setMatch = /SET\s+(.+)$/i.exec(payload.UpdateExpression || '');
      if (setMatch) {
        for (const part of setMatch[1].split(',')) {
          const m = /^\s*([#\w]+)\s*=\s*(:\w+)\s*$/.exec(part);
          if (m) {
            const attr = m[1].startsWith('#') ? names[m[1]] : m[1];
            cur[attr] = upd[m[2]];
          }
        }
      }
      t.set(key, cur);
      return reply({ Attributes: cur });
    }
    if (op === 'DeleteItem') {
      const t = ensureTable(payload.TableName);
      t.delete(decode(payload.Key.id));
      return reply({});
    }
    reply({ __type: 'UnknownOperationException', message: op }, 400);
  });
});

module.exports = { server, tables, ensureTable, AV, decode };

if (require.main === module) {
  const port = Number(process.env.PORT || 18080);
  server.listen(port, '127.0.0.1', () => console.log('fake dynamo on', port));
}
