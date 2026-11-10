#!/usr/bin/env node
/**
 * 函数部署包构建脚本
 *
 * 产出 build/create_story.zip 与 build/generate_audio.zip，
 * 供 Terraform 以 code_type="zip" + filebase64() 内联上传。
 *
 * 为什么自己打包而不用 zip 命令：
 *   Windows Git Bash 环境通常没有 zip，且 FGS 依赖打包必须保持
 *   node_modules 目录结构与 POSIX 路径分隔符。
 *
 * 用法：
 *   node scripts/build-packages.js
 *
 * 前置：src/functions/<fn>/node_modules 已存在（脚本会自动 npm install）。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const FUNCTIONS = ['create-story', 'generate-audio'];

/** 计算 CRC32（zip 格式要求） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳 */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** 递归收集文件，返回相对于 baseDir 的 POSIX 路径 */
function collectFiles(dir, baseDir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, baseDir, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(baseDir, full).split(path.sep).join('/'));
    }
  }
  return acc;
}

/** 生成 zip（deflate 压缩，条目名为 POSIX 路径） */
function writeZip(outFile, baseDir, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(baseDir, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 若压缩后反而更大则直接存储
    const useStore = deflated.length >= raw.length;
    const data = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    chunks.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra len
    cd.writeUInt16LE(0, 32);            // comment len
    cd.writeUInt16LE(0, 34);            // disk number
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(0, 38);            // external attrs
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, eocd]));
}

function ensureDeps(fnDir) {
  const nm = path.join(fnDir, 'node_modules');
  if (fs.existsSync(nm) && fs.readdirSync(nm).length > 0) return;
  console.log(`  installing dependencies for ${path.basename(fnDir)} ...`);
  execSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: fnDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function build(fnName) {
  const fnDir = path.join(ROOT, 'src', 'functions', fnName);
  ensureDeps(fnDir);

  // node_modules 全量 + 函数源码与 package.json
  const files = collectFiles(path.join(fnDir, 'node_modules'), fnDir);
  for (const extra of ['index.js', 'package.json']) {
    const p = path.join(fnDir, extra);
    if (fs.existsSync(p)) files.push(extra);
  }

  const outName = fnName === 'create-story' ? 'create_story.zip' : 'generate_audio.zip';
  const outFile = path.join(BUILD_DIR, outName);
  writeZip(outFile, fnDir, files);
  const mb = fs.statSync(outFile).size / 1048576;
  console.log(`  ${outName}: ${files.length} files, ${mb.toFixed(2)} MB`);
  return { outName, mb };
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  console.log('==> building function packages');
  const results = FUNCTIONS.map(build);

  const total = results.reduce((s, r) => s + r.mb, 0);
  console.log(`==> done. total ${total.toFixed(2)} MB (FGS inline limit 50 MB per package)`);
  if (total > 45) {
    console.warn('!! warning: close to the 50MB API limit');
  }
}

main();
