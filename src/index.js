/**
 * ========================================================
 * index.js — CFnew 简化版入口 + 路由
 * ========================================================
 *
 * 架构:
 *   config.js      — 三层配置系统 (KV > Env > 默认值)
 *   proxy.js       — WebSocket 代理核心 (VLESS + 连接竞速 + 降级)
 *   subscribe.js   — 订阅生成器 (Clash / Sing-box / V2Ray)
 *   admin.js       — 管理面板 + REST API
 *   utils.js       — 工具函数
 *
 * 路由表:
 *   /                             → 管理面板首页
 *   /{path}/sub?target=xxx        → 订阅生成
 *   /{path}/api/config            → 配置管理 API (GET/POST)
 *   /{path}/api/preferred-ips     → 优选 IP 管理 API (GET/POST/DELETE)
 *   /{path}/region                → 地区检测
 *   WebSocket /{path}             → VLESS 代理隧道
 *   POST /{path}                  → (预留 xhttp，当前返回 404)
 *   /*                            → 404
 *
 *   {path} = 自定义路径 或 UUID
 */

import { initKV, refreshConfig, getConfig, getConfigValue, getBoolConfig, getKVStatus } from './config.js';
import { handleWebSocket, injectDeps as injectProxyDeps } from './proxy.js';
import { handleSubscription } from './admin.js';
import { handleConfigAPI, handlePreferredIPsAPI, renderAdminPage } from './admin.js';
import { isValidUUID, detectRegion, parseAddressPort, ERRORS } from './utils.js';

export default {
  async fetch(request, env, ctx) {
    try {
      // ── 阶段 1: 初始化配置 ──────────────────────────────
      await initKV(env);
      await refreshConfig(env);
      const config = getConfig();
      const authToken = (env.u || env.U || config.uuid || '').toLowerCase();

      // 注入依赖到 proxy 模块
      injectProxyDeps({
        getConfigValue,
        getBoolConfig,
        getConfig,
        fallbackAddresses: FALLBACK_ADDRESSES,
      });

      const url = new URL(request.url);
      const pathParts = url.pathname.split('/').filter(Boolean);
      const isWebSocket = request.headers.get('Upgrade') === atob('d2Vic29ja2V0');
      const isPOST = request.method === 'POST';

      // ── 阶段 2: 路径校验 ──────────────────────────────
      // 确定当前路径对应的 UUID/自定义路径
      const pathFromEnv = (env.d || env.D || '').toLowerCase();
      const effectivePath = pathFromEnv || authToken;

      // 对于非 WS 且非 POST 且非首页的请求，校验路径合法性
      if (!isWebSocket && !isPOST && url.pathname !== '/') {
        const firstSegment = pathParts[0] || '';
        const cleanPath = effectivePath.startsWith('/') ? effectivePath.substring(1) : effectivePath;
        if (firstSegment !== authToken && (cleanPath ? firstSegment !== cleanPath : false)) {
          if (!pathFromEnv || firstSegment !== pathFromEnv) {
            return new Response('Not Found', { status: 404 });
          }
        }
      }

      // ── 阶段 3: 解析 Worker 地区 ────────────────────────
      const manualRegion = getConfigValue('wk', env.wk || env.WK || '');
      let workerRegion;
      if (manualRegion && manualRegion.trim()) {
        workerRegion = manualRegion.trim().toUpperCase();
      } else if (getConfigValue('proxyIP', env.p || env.P || '').trim()) {
        workerRegion = 'CUSTOM';
      } else {
        workerRegion = detectRegion(request.cf);
      }

      // 运行时配置（提供给各个模块）
      const runtimeConfig = {
        authToken,
        workerRegion,
        customPath: getConfigValue('d', env.d || env.D || ''),
        proxyIP: getConfigValue('p', env.p || env.P || ''),
        socks5: getConfigValue('s', env.s || env.S || ''),
        disableNonTLS: getBoolConfig('dkby', false),
        enableDowngrade: getBoolConfig('qj', false),
        customDNS: getConfigValue('customDNS', env.customDNS || 'https://223.5.5.5/dns-query'),
        enableVLESS: getBoolConfig('ev', true),
        regionMatch: getBoolConfig('rm', true),
        socks5Enabled: !!(getConfigValue('s', env.s || env.S || '')),
        socks5Config: parseSocksConfigSafe(getConfigValue('s', env.s || env.S || '')),
        ...config,
      };

      // ── 阶段 4: 路由分发 ──────────────────────────────

      // 4a. 配置 API
      if (url.pathname.includes('/api/config')) {
        return await handleConfigAPI(request, env);
      }

      // 4b. 优选 IP API
      if (url.pathname.includes('/api/preferred-ips')) {
        return await handlePreferredIPsAPI(request);
      }

      // 4c. WebSocket → VLESS 代理
      if (isWebSocket) {
        return await handleWebSocket(request, authToken, runtimeConfig);
      }

      // 4d. POST（xhttp 预留，当前返回 404）
      if (isPOST) {
        return new Response('Not Implemented', { status: 404 });
      }

      // 4e. GET 路由
      if (request.method === 'GET') {
        const workerDomain = url.hostname;

        // 地区检测
        if (url.pathname.endsWith('/region')) {
          return handleRegion(request, runtimeConfig, workerRegion);
        }

        // 首页 → 管理面板
        if (url.pathname === '/') {
          const kvStatus = getKVStatus();
          return new Response(renderAdminPage(runtimeConfig, workerDomain, kvStatus.available), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        // 订阅生成 (/{path} 或 /{path}/sub)
        const currentPath = url.pathname.replace(/\/$/, '');
        if (currentPath.includes('/sub')) {
          return await handleSubscription(request, authToken, runtimeConfig, workerDomain);
        }

        // 直接访问 /{path} → 管理面板（带路径）
        const segment = pathParts[0] || '';
        if (segment === authToken || segment === runtimeConfig.customPath) {
          return new Response(renderAdminPage(runtimeConfig, workerDomain, getKVStatus().available), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

// ============================================================
// 辅助函数
// ============================================================

const FALLBACK_ADDRESSES = [
  { domain: 'ProxyIP.HK.CMLiussss.net', region: 'HK', regionCode: 'HK', port: 443 },
  { domain: 'ProxyIP.US.CMLiussss.net', region: 'US', regionCode: 'US', port: 443 },
  { domain: 'ProxyIP.SG.CMLiussss.net', region: 'SG', regionCode: 'SG', port: 443 },
  { domain: 'ProxyIP.JP.CMLiussss.net', region: 'JP', regionCode: 'JP', port: 443 },
  { domain: 'ProxyIP.DE.CMLiussss.net', region: 'DE', regionCode: 'DE', port: 443 },
  { domain: 'ProxyIP.GB.CMLiussss.net', region: 'GB', regionCode: 'GB', port: 443 },
];

/**
 * 地区检测端点
 */
async function handleRegion(request, config, workerRegion) {
  const manualRegion = getConfigValue('wk', '');
  if (manualRegion && manualRegion.trim()) {
    return new Response(JSON.stringify({
      region: manualRegion.trim().toUpperCase(),
      detectionMethod: '手动指定',
      timestamp: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (config.proxyIP && config.proxyIP.trim()) {
    return new Response(JSON.stringify({
      region: 'CUSTOM',
      detectionMethod: '自定义 ProxyIP',
      timestamp: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    region: workerRegion,
    detectionMethod: 'Cloudflare API',
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
}

/**
 * 安全解析 SOCKS5 配置
 */
function parseSocksConfigSafe(str) {
  if (!str || !str.trim()) return {};
  try {
    let [userpass, rest] = str.split("@").reverse();
    let username, password, hostname, socksPort;
    if (rest) {
      const parts = rest.split(":");
      if (parts.length !== 2) return {};
      [username, password] = parts;
    }
    const addrParts = (rest || str).split(":");
    socksPort = Number(addrParts.pop());
    if (isNaN(socksPort)) return {};
    hostname = addrParts.join(":");
    return { username, password, hostname, socksPort };
  } catch (_) { return {}; }
}
