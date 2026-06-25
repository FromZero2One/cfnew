/**
 * obfuscate-worker.js — 混淆 _worker.js 构建产物
 *
 * 用法: node obfuscate-worker.js
 * 前置条件: 先运行 npm run build (生成 _worker.js)
 *
 * 输出: 混淆后的 _worker.js（覆盖原文件）
 *
 * 混淆配置与原项目一致:
 *   - stringArray + base64 编码
 *   - mangled-shuffled 标识符
 *   - unicodeEscapeSequence 转义
 *   - splitStrings 分割字符串
 *   - compact 压缩
 */

import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, '_worker.js');

if (!fs.existsSync(workerPath)) {
  console.error('错误：未找到 _worker.js。请先运行 npm run build。');
  process.exit(1);
}

const originalCode = fs.readFileSync(workerPath, 'utf8');

if (!originalCode || originalCode.trim().length === 0) {
  console.error('错误：_worker.js 为空。');
  process.exit(1);
}

const obfuscationOptions = {
  compact: true,
  controlFlowFlattening: false,
  controlFlowFlatteningThreshold: 0,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 1.0,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: false,
  stringArrayWrappersParametersMaxCount: 3,
  renameGlobals: true,
  identifierNamesGenerator: 'mangled-shuffled',
  identifierNamesCache: null,
  identifiersPrefix: '',
  renameProperties: false,
  renamePropertiesMode: 'safe',
  ignoreImports: false,
  target: 'browser',
  numbersToExpressions: false,
  simplify: false,
  splitStrings: true,
  splitStringsChunkLength: 1,
  transformObjectKeys: false,
  unicodeEscapeSequence: true,
  selfDefending: false,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  domainLock: [],
};

console.log('正在混淆 _worker.js ...');
const obfuscatedCode = JavaScriptObfuscator.obfuscate(originalCode, obfuscationOptions).getObfuscatedCode();
fs.writeFileSync(workerPath, obfuscatedCode, 'utf8');
console.log(`✅ 混淆完成。_worker.js 大小: ${(obfuscatedCode.length / 1024).toFixed(1)} KB`);
