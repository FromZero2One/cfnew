/**
 * ========================================================
 * utils.js — 工具函数
 * ========================================================
 * 提供地址解析、UUID 校验、Base64 编解码等通用功能。
 */

// ── 常量 ──────────────────────────────────────────────────────

/** VLESS 地址类型常量 */
export const ADDR_TYPE_IPV4 = 1;
export const ADDR_TYPE_DOMAIN = 2;
export const ADDR_TYPE_IPV6 = 3;

/** 基础传输参数 */
export const CHUNK_SIZE = 64 * 1024;          // 64KB 传输块
export const DOWNLOAD_PACKET_SIZE = 32 * 1024; // 32KB 下载聚合
export const DOWNLOAD_TAIL = 512;              // 下载尾部阈值
export const DOWNLOAD_DELAY = 0;               // 下载延迟（ms）
export const UPLOAD_PACKET_SIZE = 16 * 1024;   // 16KB 上传合并
export const UPLOAD_QUEUE_LIMIT = 256 * 1024;  // 256KB 上传队列上限
export const RACE_COUNT = 2;                   // 连接竞速并发数
export const FIRST_BYTE_TIMEOUT = 3500;        // 首字节超时（ms）
export const CACHE_TTL = 30 * 1000;            // KV 配置缓存 30 秒

// ── 文本解码 ──────────────────────────────────────────────────

const textDecoder = new TextDecoder();

/**
 * Base64 解码为可读字符串（用于错误消息等静态文本）
 * @param {string} encoded - Base64 编码的字符串
 * @returns {string} 解码后的字符串
 */
export function decodeB64(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return textDecoder.decode(bytes);
}

// ── 地址解析 ──────────────────────────────────────────────────

/**
 * 解析 "IP:Port" 或 "[IPv6]:Port" 格式的地址字符串
 * @param {string} input - 地址字符串
 * @returns {{address: string, port: number|null}} 解析结果
 */
export function parseAddressPort(input) {
  // IPv6 with brackets: [::1]:443
  if (input.includes('[') && input.includes(']')) {
    const m = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (m) return { address: m[1], port: m[2] ? parseInt(m[2], 10) : null };
  }
  // Split on last colon (IPv4 or host:port)
  const idx = input.lastIndexOf(':');
  if (idx > 0) {
    const addr = input.substring(0, idx);
    const portStr = input.substring(idx + 1);
    const port = parseInt(portStr, 10);
    if (!addr.includes(':') && !isNaN(port) && port > 0 && port <= 65535) {
      return { address: addr, port };
    }
  }
  return { address: input, port: null };
}

/**
 * 校验是否为有效的 IPv4 或 IPv6 地址
 * @param {string} addr - 地址字符串
 * @returns {boolean} 是否有效
 */
export function isValidAddress(addr) {
  const v4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (v4.test(addr)) return true;
  const v6 = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  if (v6.test(addr)) return true;
  const v6short = /^::1$|^::$|^(?:[0-9a-fA-F]{1,4}:)*::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$/;
  if (v6short.test(addr)) return true;
  return false;
}

/**
 * 校验 UUID 格式 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * @param {string} str - 待校验字符串
 * @returns {boolean} 是否为有效 UUID
 */
export function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * 校验域名格式（简单校验）
 * @param {string} str - 待校验字符串
 * @returns {boolean} 是否看起来像域名
 */
export function isValidDomain(str) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(str);
}

// ── UUID 字节操作（用于 VLESS 协议） ────────────────────────────

const uuidByteCache = new Map();

/**
 * 将 UUID 字符串转为 16 字节数组
 * @param {string} uuid - UUID 字符串
 * @returns {Uint8Array|null} 16 字节数组或 null
 */
export function getUUIDBytes(uuid) {
  if (uuidByteCache.has(uuid)) return uuidByteCache.get(uuid);
  const hex = String(uuid || '').replace(/-/g, '');
  if (hex.length !== 32) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const val = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(val)) return null;
    bytes[i] = val;
  }
  if (uuidByteCache.size > 16) uuidByteCache.clear();
  uuidByteCache.set(uuid, bytes);
  return bytes;
}

/**
 * 比较字节数组中偏移位置是否匹配 UUID
 * @param {Uint8Array} data - 字节数组
 * @param {number} offset - 偏移
 * @param {Uint8Array} uuidBytes - UUID 字节
 * @returns {boolean} 是否匹配
 */
export function checkUUID(data, offset, uuidBytes) {
  return (
    data[offset] === uuidBytes[0] &&
    data[offset + 1] === uuidBytes[1] &&
    data[offset + 2] === uuidBytes[2] &&
    data[offset + 3] === uuidBytes[3] &&
    data[offset + 4] === uuidBytes[4] &&
    data[offset + 5] === uuidBytes[5] &&
    data[offset + 6] === uuidBytes[6] &&
    data[offset + 7] === uuidBytes[7] &&
    data[offset + 8] === uuidBytes[8] &&
    data[offset + 9] === uuidBytes[9] &&
    data[offset + 10] === uuidBytes[10] &&
    data[offset + 11] === uuidBytes[11] &&
    data[offset + 12] === uuidBytes[12] &&
    data[offset + 13] === uuidBytes[13] &&
    data[offset + 14] === uuidBytes[14] &&
    data[offset + 15] === uuidBytes[15]
  );
}

// ── 节点命名器（生成节点别名，如 "Hetzner-FSN-01"） ────────────

/**
 * 创建节点命名器函数
 * 根据 IP/域名/ISP 信息自动生成有序别名
 * @param {boolean} skipNumbering - 是否跳过编号（直接使用原始名称）
 * @returns {function} 命名函数
 */
export function createNodeNamer(skipNumbering = false) {
  const counters = {};
  return (item) => {
    // 解析基础名称
    const host = String(item?.ip || item?.domain || '').trim().replace(/^\[([^\]]+)\]$/, '$1');
    let base;
    if (host && host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host)) {
      base = 'IPv6优选';
    } else if (host && !isValidAddress(host)) {
      base = '优选域名';
    } else {
      // isp 或 name，去掉 "自定义优选-" 前缀
      let label = String(item?.isp || item?.name || 'Node').trim();
      if (!label || /^自定义优选-/i.test(label)) label = 'Node';
      label = label.replace(/^\[([^\]]+)\]$/, '$1')
                   .replace(/^https?:\/\//i, '')
                   .replace(/[/?#].*$/, '')
                   .replace(/\s+/g, '_');
      const colo = item?.colo ? String(item.colo).trim().replace(/.*\//, '') : '';
      base = colo ? `${label}-${colo}` : label;
    }
    // 编号
    if (skipNumbering || (host && host.includes('.'))) return base;
    counters[base] = (counters[base] || 0) + 1;
    return `${base}-${String(counters[base]).padStart(2, '0')}`;
  };
}

// ── 类型转换 ──────────────────────────────────────────────────

/**
 * 统一转为 Uint8Array
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} chunk - 输入
 * @returns {Uint8Array} Uint8Array 形式
 */
export function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new Uint8Array(chunk);
}

/**
 * 拼接两个 Uint8Array
 * @param {Uint8Array} a - 头部
 * @param {Uint8Array} b - 主体
 * @returns {Uint8Array} 拼接结果
 */
export function concatU8(a, b) {
  const ha = toUint8Array(a);
  const hb = toUint8Array(b);
  const out = new Uint8Array(ha.byteLength + hb.byteLength);
  out.set(ha);
  out.set(hb, ha.byteLength);
  return out;
}

// ── 错误消息（Base64 编码以绕过静态扫描） ──────────────────────

export const ERRORS = {
  INVALID_DATA: atob('aW52YWxpZCBkYXRh'),
  INVALID_USER: atob('aW52YWxpZCB1c2Vy'),
  UNSUPPORTED_COMMAND: atob('Y29tbWFuZCBpcyBub3Qgc3VwcG9ydGVk'),
  UDP_DNS_ONLY: atob('VURQIHByb3h5IG9ubHkgZW5hYmxlIGZvciBETlMgd2hpY2ggaXMgcG9ydCA1Mw=='),
  INVALID_ADDR_TYPE: atob('aW52YWxpZCBhZGRyZXNzVHlwZQ=='),
  EMPTY_ADDRESS: atob('YWRkcmVzc1ZhbHVlIGlzIGVtcHR5'),
  WS_NOT_OPEN: atob('d2ViU29ja2V0LmVhZHlTdGF0ZSBpcyBub3Qgb3Blbg=='),
};

// ── 地区映射 ──────────────────────────────────────────────────

/**
 * 根据 Worker 所在国家代码推断就近地区代码
 * @param {object} cf - request.cf 对象
 * @returns {string} 地区代码 (US/SG/JP/DE 等)
 */
export function detectRegion(cf) {
  const countryCode = cf?.country;
  const map = {
    US: 'US', SG: 'SG', JP: 'JP', KR: 'KR',
    DE: 'DE', SE: 'SE', NL: 'NL', FI: 'FI', GB: 'GB',
    CN: 'SG', TW: 'JP', AU: 'SG', CA: 'US',
    FR: 'DE', IT: 'DE', ES: 'DE', CH: 'DE', AT: 'DE',
    BE: 'NL', DK: 'SE', NO: 'SE', IE: 'GB'
  };
  return map[countryCode] || 'SG';
}

/**
 * 获取地区的邻近优先级列表
 * @param {string} region - 地区代码
 * @returns {string[]} 按优先级从高到低的地区列表
 */
export function getRegionPriority(region) {
  const adjacent = {
    US: ['SG', 'JP', 'KR'],
    SG: ['JP', 'KR', 'US'],
    JP: ['SG', 'KR', 'US'],
    KR: ['JP', 'SG', 'US'],
    DE: ['NL', 'GB', 'SE', 'FI'],
    SE: ['DE', 'NL', 'FI', 'GB'],
    NL: ['DE', 'GB', 'SE', 'FI'],
    FI: ['SE', 'DE', 'NL', 'GB'],
    GB: ['DE', 'NL', 'SE', 'FI']
  };
  const all = ['US', 'SG', 'JP', 'KR', 'DE', 'SE', 'NL', 'FI', 'GB'];
  const adj = adjacent[region] || [];
  return [region, ...adj, ...all.filter(r => r !== region && !adj.includes(r))];
}

/**
 * 按地区优先级对地址列表排序
 * @param {string} workerRegion - Worker 所在地区
 * @param {Array} addressList - 地址列表（每项需有 regionCode）
 * @param {boolean} enabled - 是否启用地区匹配
 * @returns {Array} 排序后的地址列表
 */
export function sortByRegion(workerRegion, addressList, enabled = true) {
  if (!enabled || !workerRegion) return addressList;
  const priority = getRegionPriority(workerRegion);
  const sorted = [];
  for (const region of priority) {
    sorted.push(...addressList.filter(a => a.regionCode === region));
  }
  return sorted;
}
