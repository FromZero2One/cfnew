/**
 * ========================================================
 * config.js — 三层配置系统
 * ========================================================
 * 配置优先级: KV 存储 > 环境变量 > 硬编码默认值
 *
 * KV 使用 30 秒缓存 + c_ver 版本键实现跨隔离区即时生效。
 */

import { CACHE_TTL } from './utils.js';

// ── KV 相关状态 ──────────────────────────────────────────────

/** @type {object|null} KV 命名空间绑定 */
let kvStore = null;

/** @type {object} 缓存的 KV 配置 */
let kvConfig = {};

/** @type {number} 上次 KV 加载时间戳 */
let kvLastLoad = 0;

/** @type {string} 当前 KV 版本号（用于跨 isolate 缓存失效） */
let kvVersion = '';

// ============================================================
// 默认配置定义
// ============================================================

/** @type {object} 所有配置项的默认值 */
export const DEFAULT_CONFIG = {
  // ---- 核心认证 ----
  uuid:       '351c9981-04b6-4103-aa4b-864aa9c91469',   // 默认 UUID（建议通过环境变量覆盖）
  customPath: '',                                         // 自定义路径（替代 UUID）

  // ---- 协议开关 ----
  enableVLESS: 'yes',   // VLESS (默认开启)
  enableTrojan: 'no',   // Trojan (已废弃，保留兼容)
  enableXhttp: 'no',    // xhttp   (已废弃，保留兼容)

  // ---- 代理核心 ----
  proxyIP:      '',     // 自定义 ProxyIP (p)
  socks5:       '',     // SOCKS5 代理配置 (s)
  fallbackIP:   '',     // 回退地址
  customDNS:    'https://223.5.5.5/dns-query',
  alpn:         '',     // TLS ALPN (h3/h2/http/1.1)

  // ---- 优选IP ----
  yx:           '',     // 自定义优选 IP 列表 (逗号分隔)
  yxURL:        '',     // 优选 IP 来源 URL
  epd:          'yes',  // 启用优选域名
  epi:          'yes',  // 启用优选 IP
  egi:          'yes',  // 启用自定义优选

  // ---- 订阅 ----
  scu:          'https://url.v1.mk/sub',   // 订阅转换 API

  // ---- 功能开关 ----
  ech:          'no',   // ECH 加密客户端问候
  ena:          'no',   // 启用原生地址
  ae:           '',     // 允许 API 管理
  rm:           '',     // 地区匹配
  qj:           '',     // 降级控制
  dkby:         'no',   // 仅 TLS 节点
  yxby:         '',     // 优选控制
  ipv4:         'yes',  // 使用 IPv4
  ipv6:         'yes',  // 使用 IPv6

  // ---- 首页伪装 ----
  homepage:     '',     // 自定义首页 URL
};

// ============================================================
// 配置加载与合并
// ============================================================

/**
 * 解析 "yes/no/true/false/1/0/on/off" 字符串为布尔值
 * @param {*} val - 输入值
 * @param {boolean} defaultVal - 默认值
 * @returns {boolean} 布尔结果
 */
function parseBool(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (val === true || val === false) return val;
  const s = String(val).trim().toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(s)) return true;
  if (['no', 'false', '0', 'off'].includes(s)) return false;
  return defaultVal;
}

/**
 * 从环境变量读取配置快照
 * 支持大写/小写/下划线多种命名风格
 * @param {object} env - Workers 环境变量对象
 * @returns {object} 配置键值对
 */
function readEnvConfig(env) {
  if (!env) return {};
  const map = {
    uuid:        ['uuid', 'UUID'],
    customPath:  ['customPath', 'CUSTOMPATH', 'CUSTOM_PATH'],
    enableVLESS: ['ev', 'EV'],
    enableTrojan:['et', 'ET'],
    enableXhttp: ['ex', 'EX'],
    proxyIP:     ['p', 'P'],
    socks5:      ['s', 'S'],
    customDNS:   ['customDNS', 'CUSTOMDNS', 'CUSTOM_DNS'],
    alpn:        ['alpn', 'ALPN'],
    yx:          ['yx', 'YX'],
    yxURL:       ['yxURL', 'YXURL', 'YX_URL'],
    ech:         ['ech', 'ECH'],
    ena:         ['ena', 'ENA'],
    epd:         ['epd', 'EPD'],
    epi:         ['epi', 'EPI'],
    egi:         ['egi', 'EGI'],
    ae:          ['ae', 'AE'],
    rm:          ['rm', 'RM'],
    qj:          ['qj', 'QJ'],
    dkby:        ['dkby', 'DKBY'],
    yxby:        ['yxby', 'YXBY'],
    homepage:    ['homepage', 'HOMEPAGE'],
    ipv4:        ['ipv4', 'IPV4'],
    ipv6:        ['ipv6', 'IPV6'],
  };
  const result = {};
  for (const [key, names] of Object.entries(map)) {
    for (const name of names) {
      if (env[name] !== undefined && env[name] !== null && env[name] !== '') {
        result[key] = env[name];
        break;
      }
    }
  }
  return result;
}

/**
 * 合并并规范化配置（KV > Env > 默认值）
 * @param {object} env - Workers 环境变量
 * @returns {object} 最终配置对象
 */
function normalizeConfig(env = {}) {
  const envCfg = readEnvConfig(env);
  return {
    ...DEFAULT_CONFIG,
    ...envCfg,
    ...kvConfig,           // KV 配置覆盖优先级最高
  };
}

// ============================================================
// KV 配置管理
// ============================================================

/**
 * 初始化 KV 绑定
 * @param {object} env - Workers 环境变量
 */
export async function initKV(env) {
  if (env.C) {
    try {
      kvStore = env.C;
      await loadKVConfig();
    } catch (e) {
      kvStore = null;
    }
  }
}

/**
 * 从 KV 加载配置（含 30 秒缓存 + c_ver 版本键）
 * @param {boolean} force - 是否强制刷新（忽略缓存）
 */
export async function loadKVConfig(force = false) {
  if (!kvStore) return;

  // 短窗口内信任缓存，避免高频请求打爆 KV
  if (!force && kvLastLoad > 0 && Date.now() - kvLastLoad < CACHE_TTL) {
    return;
  }

  try {
    // 先读小体积版本键 c_ver（约 13 字节），用于跨 isolate 缓存失效
    let newVersion = '';
    try {
      newVersion = (await kvStore.get('c_ver')) || '';
    } catch (_) {}

    // 版本未变且已有缓存，只更新时间戳
    if (!force && newVersion && newVersion === kvVersion && Object.keys(kvConfig).length > 0) {
      kvLastLoad = Date.now();
      return;
    }

    const data = await kvStore.get('c');
    if (data) {
      kvConfig = JSON.parse(data);
    }
    kvVersion = newVersion;
    kvLastLoad = Date.now();
  } catch (e) {
    // 失败时保留现有缓存，避免临时故障导致配置丢失
    if (!kvConfig) kvConfig = {};
  }
}

/**
 * 保存配置到 KV
 * @param {object} config - 要保存的配置对象
 */
export async function saveKVConfig(config) {
  if (!kvStore) throw new Error('KV not configured');
  Object.assign(kvConfig, config);
  const configStr = JSON.stringify(kvConfig);
  await kvStore.put('c', configStr);
  // 写入新版本号，让其他 isolate 立即感知变化
  const newVer = String(Date.now());
  kvVersion = newVer;
  try { await kvStore.put('c_ver', newVer); } catch (_) {}
  kvLastLoad = Date.now();
}

// ============================================================
// 全局状态（运行时动态配置）
// ============================================================

/** @type {object} 当前生效的合并配置 */
let currentConfig = { ...DEFAULT_CONFIG };

/**
 * 刷新当前配置（从 KV + Env 重新合并）
 * @param {object} env - Workers 环境变量
 */
export async function refreshConfig(env = {}) {
  await loadKVConfig();
  currentConfig = normalizeConfig(env);
}

/**
 * 获取当前生效的配置对象
 * @returns {object} 当前配置
 */
export function getConfig() {
  return currentConfig;
}

/**
 * 读取单个配置值（带默认值回退）
 * @param {string} key - 配置键
 * @param {*} defaultVal - 默认值
 * @returns {*} 配置值
 */
export function getConfigValue(key, defaultVal = '') {
  if (currentConfig[key] !== undefined) return currentConfig[key];
  return defaultVal;
}

/**
 * 获取布尔类型配置值
 * @param {string} key - 配置键
 * @param {boolean} defaultVal - 默认值
 * @returns {boolean} 布尔结果
 */
export function getBoolConfig(key, defaultVal = false) {
  const val = getConfigValue(key, defaultVal ? 'yes' : 'no');
  return parseBool(val, defaultVal);
}

/**
 * 获取当前 KV 状态
 * @returns {{available: boolean, lastLoad: number, version: string}}
 */
export function getKVStatus() {
  return {
    available: kvStore !== null,
    lastLoad: kvLastLoad,
    version: kvVersion,
  };
}
