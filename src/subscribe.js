/**
 * ========================================================
 * subscribe.js — 订阅生成器
 * ========================================================
 * 直接由 Worker 生成客户端配置，不依赖外部 sub-converter。
 *
 * 支持的格式:
 *   1. Clash / Clash.Meta  — YAML (含 Loyalsoldier rule-providers)
 *   2. Sing-box            — JSON (含 MetaCubeX SRS 规则集)
 *   3. V2Ray / Base64      — 纯链接 Base64 编码
 *
 * 所有节点基于 VLESS 协议生成，支持优选 IP/域名/自定义地址。
 */

import { decodeB64, createNodeNamer, isValidAddress } from './utils.js';

// ============================================================
// 辅助函数
// ============================================================

/** YAML 字符串转义（处理 IPv6 方括号、逗号等） */
function yamlQuote(val) {
  if (val == null) return '""';
  const s = String(val);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 规范化主机名（移除 IPv6 方括号） */
function normalizeHost(host) {
  if (!host) return host;
  const s = String(host);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

/** 解析 VLESS 分享链接为通用节点对象 */
function parseVLESSLink(link) {
  try {
    if (!link.startsWith(decodeB64('dmxlc3M6Ly8='))) return null;
    const url = new URL(link);
    const params = new URLSearchParams(url.search);
    return {
      proto: decodeB64('dmxlc3M='),
      name: decodeURIComponent(url.hash.substring(1)) || url.hostname + ':' + url.port,
      uuid: url.username,
      server: normalizeHost(url.hostname),
      port: parseInt(url.port) || 443,
      tls: params.get('security') === 'tls' || params.get('security') === 'reality',
      network: params.get('type') || 'ws',
      path: params.get('path') || '/?ed=2048',
      host: normalizeHost(params.get('host') || url.hostname),
      sni: normalizeHost(params.get('sni') || params.get('host') || url.hostname),
      alpn: (params.get('alpn') || '').split(',').map(s => s.trim()).filter(Boolean),
      fp: params.get('fp') || 'chrome',
      flow: params.get('flow') || '',
      encryption: params.get('encryption') || 'none',
      ech: params.get('ech') || '',
    };
  } catch (_) { return null; }
}

// ============================================================
// 1. Clash / Clash.Meta YAML 生成
// ============================================================

/**
 * 为 Clash 策略组生成 proxies 条目
 * @param {string[]} names - 节点名称列表
 * @param {object} opts - 选项
 * @returns {string} 格式化后的 YAML
 */
function clashProxyList(names, opts = {}) {
  const { directFirst = false, extraGroups = [] } = opts;
  const nodeLines = names.length
    ? names.map(n => `      - ${yamlQuote(n)}`).join('\n')
    : '      - DIRECT';
  const lines = [];
  if (directFirst) {
    lines.push('      - "🎯 全球直连"', '      - "🚀 节点选择"');
  } else {
    lines.push('      - "🚀 节点选择"', '      - "🎯 全球直连"');
  }
  for (const g of extraGroups) lines.push(`      - ${yamlQuote(g)}`);
  lines.push(nodeLines);
  return lines.join('\n');
}

/**
 * 构建单个节点的 Clash YAML 块
 */
function buildClashNode(node) {
  const lines = [];
  const server = normalizeHost(node.server);
  const host = normalizeHost(node.host) || server;
  const sni = normalizeHost(node.sni) || host;

  lines.push(`  - name: ${yamlQuote(node.name)}`);
  lines.push(`    type: ${node.proto}`);
  lines.push(`    server: ${yamlQuote(server)}`);
  lines.push(`    port: ${node.port}`);
  lines.push(`    uuid: ${node.uuid}`);
  lines.push(`    udp: true`);
  lines.push(`    tls: ${node.tls ? 'true' : 'false'}`);
  if (node.flow) lines.push(`    flow: ${yamlQuote(node.flow)}`);
  lines.push(`    client-fingerprint: ${yamlQuote(node.fp || 'chrome')}`);

  if (node.tls) {
    lines.push(`    servername: ${yamlQuote(sni)}`);
    if (node.alpn && node.alpn.length) {
      lines.push(`    alpn: [${node.alpn.map(a => yamlQuote(a)).join(', ')}]`);
    }
    lines.push(`    skip-cert-verify: false`);
  }

  if (node.network === 'ws') {
    lines.push(`    network: ws`);
    lines.push(`    ws-opts:`);
    lines.push(`      path: ${yamlQuote(node.path)}`);
    lines.push(`      headers:`);
    lines.push(`        Host: ${yamlQuote(host)}`);
  }

  if (node.ech) {
    lines.push(`    ech-opts:`);
    lines.push(`      enable: true`);
    lines.push(`      query-server-name: ${yamlQuote('cloudflare-ech.com')}`);
  }

  return lines.join('\n');
}

/**
 * 生成 Clash / Clash.Meta YAML 配置
 * 包含: 完整 Loyalsoldier rule-providers + 策略组
 *
 * @param {string[]} links - VLESS 分享链接列表
 * @param {string} customDNS - 自定义 DNS 地址
 * @returns {string} Clash YAML
 */
export function generateClash(links, customDNS = 'https://223.5.5.5/dns-query') {
  const nodes = links.map(parseVLESSLink).filter(n => n && n.proto === decodeB64('dmxlc3M='));
  const names = nodes.map(n => n.name);
  const dns = customDNS || 'https://223.5.5.5/dns-query';

  // ── 头部 ──
  const header = [
    'mixed-port: 7890',
    'allow-lan: true',
    'mode: rule',
    'log-level: info',
    'ipv6: true',
    'external-controller: 127.0.0.1:9090',
    'unified-delay: true',
    'tcp-concurrent: true',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    'geox-url:',
    '  geoip: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"',
    '  geosite: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"',
    '  mmdb: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb"',
    'sniffer:',
    '  enable: true',
    '  force-dns-mapping: true',
    '  parse-pure-ip: true',
    '  sniff:',
    '    HTTP:',
    '      ports: [80, 8080-8880]',
    '      override-destination: true',
    '    TLS:',
    '      ports: [443, 8443]',
    '    QUIC:',
    '      ports: [443, 8443]',
    'dns:',
    '  enable: true',
    '  listen: 0.0.0.0:1053',
    '  ipv6: true',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  fake-ip-filter:',
    '    - "*.lan"',
    '    - "+.local"',
    '    - "+.msftconnecttest.com"',
    '    - "+.msftncsi.com"',
    '    - "localhost.ptlogin2.qq.com"',
    '  default-nameserver:',
    '    - 223.5.5.5',
    '    - 119.29.29.29',
    '  nameserver:',
    `    - ${dns}`,
    '    - https://119.29.29.29/dns-query',
    '  fallback:',
    '    - https://1.1.1.1/dns-query',
    '    - https://8.8.8.8/dns-query',
    '  fallback-filter:',
    '    geoip: true',
    '    geoip-code: CN',
    '    ipcidr:',
    '      - 240.0.0.0/4',
  ].join('\n');

  // ── Proxies ──
  const proxies = ['proxies:'];
  for (const node of nodes) proxies.push(buildClashNode(node));

  // ── Proxy Groups ──
  const nodeOnly = names.length ? names.map(n => `      - ${yamlQuote(n)}`).join('\n') : '      - DIRECT';
  const groups = [
    decodeB64('cHJveHktZ3JvdXBzOg=='),
    '  - name: "🚀 节点选择"',
    '    type: select',
    '    proxies:',
    '      - "🎯 全球直连"',
    nodeOnly,
    '  - name: "🌍 国外媒体"',
    '    type: select',
    '    proxies:',
    clashProxyList(names),
    '  - name: "📺 哔哩哔哩"',
    '    type: select',
    '    proxies:',
    clashProxyList(names, { directFirst: true }),
    '  - name: "📹 油管视频"',
    '    type: select',
    '    proxies:',
    clashProxyList(names, { extraGroups: ['🌍 国外媒体'] }),
    '  - name: "🎬 奈飞视频"',
    '    type: select',
    '    proxies:',
    clashProxyList(names, { extraGroups: ['🌍 国外媒体'] }),
    '  - name: "📲 电报信息"',
    '    type: select',
    '    proxies:',
    clashProxyList(names),
    '  - name: "🌐 谷歌服务"',
    '    type: select',
    '    proxies:',
    clashProxyList(names),
    '  - name: "🤖 OpenAI"',
    '    type: select',
    '    proxies:',
    clashProxyList(names),
    '  - name: "Ⓜ️ 微软服务"',
    '    type: select',
    '    proxies:',
    clashProxyList(names, { directFirst: true }),
    '  - name: "🍎 苹果服务"',
    '    type: select',
    '    proxies:',
    clashProxyList(names, { directFirst: true }),
    '  - name: "🎯 全球直连"',
    '    type: select',
    '    proxies:',
    '      - DIRECT',
    '  - name: "🛑 全球拦截"',
    '    type: select',
    '    proxies:',
    '      - REJECT',
    '      - DIRECT',
    '  - name: "🐟 漏网之鱼"',
    '    type: select',
    '    proxies:',
    clashProxyList(names),
  ].join('\n');

  // ── Rule Providers (Loyalsoldier) ──
  const base = decodeB64('aHR0cHM6Ly9mYXN0bHkuanNkZWxpdnIubmV0L2doL0xveWFsc29sZGllci9jbGFzaC1ydWxlc0ByZWxlYXNl');
  const provider = (name, behavior) =>
    `  ${name}:\n    type: http\n    behavior: ${behavior}\n    url: "${base}/${name}.txt"\n    path: ./rulesets/loyalsoldier/${name}.txt\n    interval: 86400`;

  const ruleProviders = [
    'rule-providers:',
    provider('reject', 'domain'),
    provider('icloud', 'domain'),
    provider('apple', 'domain'),
    provider('google', 'domain'),
    provider(decodeB64('cHJveHk='), 'domain'),
    provider('direct', 'domain'),
    provider('private', 'domain'),
    provider('gfw', 'domain'),
    provider('greatfire', 'domain'),
    provider('tld-not-cn', 'domain'),
    provider('telegramcidr', 'ipcidr'),
    provider('cncidr', 'ipcidr'),
    provider('lancidr', 'ipcidr'),
    provider('applications', 'classical'),
  ].join('\n');

  // ── Rules ──
  const rules = [
    'rules:',
    '  - DOMAIN-SUFFIX,local,🎯 全球直连',
    '  - DOMAIN,yacd.haishan.me,🎯 全球直连',
    '  - DOMAIN,yacd.metacubex.one,🎯 全球直连',
    '  - DOMAIN-SUFFIX,googleapis.cn,🌐 谷歌服务',
    '  - DOMAIN-SUFFIX,gstatic.com,🌐 谷歌服务',
    '  - DOMAIN-SUFFIX,googlevideo.com,📹 油管视频',
    '  - DOMAIN-KEYWORD,youtube,📹 油管视频',
    '  - DOMAIN-SUFFIX,youtube.com,📹 油管视频',
    '  - DOMAIN-KEYWORD,netflix,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,netflix.com,🎬 奈飞视频',
    '  - DOMAIN-SUFFIX,bilibili.com,📺 哔哩哔哩',
    '  - DOMAIN-SUFFIX,bilivideo.com,📺 哔哩哔哩',
    '  - DOMAIN-KEYWORD,openai,🤖 OpenAI',
    '  - DOMAIN-KEYWORD,chatgpt,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,openai.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,chatgpt.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,anthropic.com,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,claude.ai,🤖 OpenAI',
    '  - DOMAIN-SUFFIX,perplexity.ai,🤖 OpenAI',
    '  - RULE-SET,applications,🎯 全球直连',
    '  - RULE-SET,private,🎯 全球直连',
    '  - RULE-SET,reject,🛑 全球拦截',
    '  - RULE-SET,icloud,🍎 苹果服务',
    '  - RULE-SET,apple,🍎 苹果服务',
    '  - RULE-SET,google,🌐 谷歌服务',
    decodeB64('ICAtIFJVTEUtU0VULHByb3h5LPCfmoAg6IqC54K56YCJ5oup'),
    '  - RULE-SET,gfw,🚀 节点选择',
    '  - RULE-SET,greatfire,🚀 节点选择',
    '  - RULE-SET,tld-not-cn,🚀 节点选择',
    '  - RULE-SET,direct,🎯 全球直连',
    '  - RULE-SET,lancidr,🎯 全球直连,no-resolve',
    '  - RULE-SET,cncidr,🎯 全球直连,no-resolve',
    '  - RULE-SET,telegramcidr,📲 电报信息,no-resolve',
    '  - GEOIP,LAN,🎯 全球直连,no-resolve',
    '  - GEOIP,CN,🎯 全球直连,no-resolve',
    '  - MATCH,🐟 漏网之鱼',
  ].join('\n');

  return [header, proxies.join('\n'), '', groups, ruleProviders, rules, ''].join('\n');
}

// ============================================================
// 2. Sing-box JSON 配置生成
// ============================================================

/**
 * 构建 Sing-box 出站节点
 */
function buildSingboxOutbound(node) {
  const out = {
    type: node.proto,
    tag: node.name,
    server: normalizeHost(node.server),
    server_port: node.port,
    uuid: node.uuid,
  };

  if (node.tls) {
    out.tls = {
      enabled: true,
      server_name: node.sni,
      insecure: false,
      utls: { enabled: true, fingerprint: node.fp || 'chrome' },
    };
    if (node.alpn && node.alpn.length) out.tls.alpn = node.alpn;
    if (node.ech) {
      out.tls.ech = { enabled: true, pq_signature_schemes_enabled: false, dynamic_record_sizing_disabled: false };
    }
  }

  if (node.network === 'ws') {
    out.transport = {
      type: 'ws',
      path: node.path,
      headers: { Host: node.host },
      max_early_data: 2048,
      early_data_header_name: 'Sec-WebSocket-Protocol',
    };
  }

  return out;
}

/**
 * 生成 Sing-box JSON 配置
 * 包含: MetaCubeX SRS 规则集 + 策略组
 *
 * @param {string[]} links - VLESS 分享链接列表
 * @param {string} customDNS - 自定义 DNS 地址
 * @returns {string} Sing-box JSON
 */
export function generateSingbox(links, customDNS = 'https://223.5.5.5/dns-query') {
  const nodes = links.map(parseVLESSLink).filter(n => n && n.proto === decodeB64('dmxlc3M='));
  const outboundTags = nodes.map(n => n.name);
  const dns = customDNS || 'https://223.5.5.5/dns-query';

  // 远端 SRS 规则集（jsDelivr 镜像 MetaCubeX）
  const srsBase = 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite';
  const geoipBase = 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip';
  const geosite = name => ({ tag: `geosite-${name}`, type: 'remote', format: 'binary', url: `${srsBase}/${name}.srs`, download_detour: 'direct' });
  const geoip = name => ({ tag: `geoip-${name}`, type: 'remote', format: 'binary', url: `${geoipBase}/${name}.srs`, download_detour: 'direct' });

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: dns, detour: 'select' },
        { tag: 'local', address: '223.5.5.5', detour: 'direct' },
        { tag: 'fakeip', address: 'fakeip' },
        { tag: 'block', address: 'rcode://success' },
      ],
      rules: [
        { outbound: 'any', server: 'local' },
        { rule_set: 'geosite-category-ads-all', server: 'block' },
        { rule_set: 'geosite-cn', server: 'local' },
        { query_type: ['A', 'AAAA'], server: 'fakeip' },
      ],
      fakeip: { enabled: true, inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' },
      independent_cache: true,
      strategy: 'ipv4_only',
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 2080,
        sniff: true,
        sniff_override_destination: true,
      },
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: decodeB64('c2luZy1ib3g='),
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
        sniff: true,
        sniff_override_destination: true,
      },
    ],
    outbounds: [
      { type: 'selector', tag: 'select', outbounds: ['direct', ...outboundTags], default: outboundTags[0] || 'direct' },
      { type: 'selector', tag: '🌍 国外媒体', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '📲 电报信息', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🌐 谷歌服务', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🤖 OpenAI', outbounds: ['select', 'direct', ...outboundTags] },
      { type: 'selector', tag: 'Ⓜ️ 微软服务', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '🍎 苹果服务', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '📺 哔哩哔哩', outbounds: ['direct', 'select', ...outboundTags] },
      { type: 'selector', tag: '📹 油管视频', outbounds: ['select', '🌍 国外媒体', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🎬 奈飞视频', outbounds: ['select', '🌍 国外媒体', 'direct', ...outboundTags] },
      { type: 'selector', tag: '🎯 全球直连', outbounds: ['direct'] },
      { type: 'selector', tag: '🐟 漏网之鱼', outbounds: ['select', 'direct', ...outboundTags] },
      ...nodes.map(buildSingboxOutbound),
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ],
    route: {
      rule_set: [
        geosite('cn'), geosite('private'), geosite('apple'),
        geosite('microsoft'), geosite('google'), geosite('telegram'),
        geosite('openai'), geosite('anthropic'), geosite('youtube'),
        geosite('netflix'), geosite('disney'), geosite('spotify'),
        geosite('tiktok'), geosite('twitter'), geosite('facebook'),
        geosite('github'), geosite('geolocation-!cn'), geosite('category-ads-all'),
        geoip('cn'), geoip('private'), geoip('telegram'),
      ],
      rules: [
        { protocol: 'dns', outbound: 'dns-out' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: 'geosite-category-ads-all', outbound: 'block' },
        { rule_set: 'geosite-private', outbound: 'direct' },
        { rule_set: 'geosite-apple', outbound: '🍎 苹果服务' },
        { rule_set: 'geosite-microsoft', outbound: 'Ⓜ️ 微软服务' },
        { rule_set: 'geosite-openai', outbound: '🤖 OpenAI' },
        { rule_set: 'geosite-anthropic', outbound: '🤖 OpenAI' },
        { rule_set: 'geosite-telegram', outbound: '📲 电报信息' },
        { rule_set: 'geoip-telegram', outbound: '📲 电报信息' },
        { rule_set: 'geosite-google', outbound: '🌐 谷歌服务' },
        { rule_set: 'geosite-youtube', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-netflix', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-disney', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-spotify', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-tiktok', outbound: '🌍 国外媒体' },
        { rule_set: 'geosite-github', outbound: 'select' },
        { rule_set: 'geosite-geolocation-!cn', outbound: 'select' },
        { rule_set: 'geosite-cn', outbound: 'direct' },
        { rule_set: 'geoip-cn', outbound: 'direct' },
        { ip_is_private: true, outbound: 'direct' },
      ],
      final: '🐟 漏网之鱼',
      auto_detect_interface: true,
    },
    experimental: {
      cache_file: { enabled: true, store_fakeip: true },
      clash_api: { external_controller: '127.0.0.1:9090' },
    },
  };

  return JSON.stringify(config, null, 2);
}

// ============================================================
// 3. V2Ray / Base64 纯链接格式
// ============================================================

/**
 * 生成 Base64 编码的 VLESS 链接列表
 * 兼容: V2Ray, V2RayNG, Shadowrocket, Nekoray, Nekobox
 *
 * @param {string[]} links - VLESS 分享链接列表
 * @returns {string} Base64 编码的订阅内容
 */
export function generateBase64(links) {
  return btoa(links.join('\n'));
}

// ============================================================
// VLESS 分享链接生成
// ============================================================

/**
 * 根据 IP/域名列表生成 VLESS 分享链接
 *
 * @param {Array} items - 地址列表 [{ ip, domain, port, isp, name, colo }]
 * @param {string} uuid - 认证 UUID
 * @param {string} workerDomain - Worker 域名
 * @param {boolean} disableNonTLS - 是否禁用非 TLS 端口
 * @param {boolean} skipNumbering - 节点是否跳过编号
 * @param {function|null} namer - 节点命名函数
 * @returns {string[]} VLESS 链接列表
 */
export function generateVLESSLinks(items, uuid, workerDomain, disableNonTLS = false, skipNumbering = false, namer = null) {
  const TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
  const NON_TLS_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  const DEFAULT_TLS = [443];
  const DEFAULT_NON_TLS = disableNonTLS ? [] : [80];
  const WS_PATH = '/?ed=2048';
  const makeName = namer || createNodeNamer(skipNumbering);
  const links = [];

  for (const item of items) {
    const safeAddr = item.ip && item.ip.includes(':') ? `[${item.ip}]` : (item.ip || item.domain);
    let portConfigs = [];

    if (item.port) {
      const p = item.port;
      if (TLS_PORTS.includes(p)) portConfigs.push({ port: p, tls: true });
      else if (NON_TLS_PORTS.includes(p)) { if (!disableNonTLS) portConfigs.push({ port: p, tls: false }); }
      else portConfigs.push({ port: p, tls: true });
    } else {
      DEFAULT_TLS.forEach(p => portConfigs.push({ port: p, tls: true }));
      DEFAULT_NON_TLS.forEach(p => portConfigs.push({ port: p, tls: false }));
    }

    for (const { port, tls } of portConfigs) {
      const nodeName = makeName(item);
      const params = new URLSearchParams({
        encryption: 'none',
        ...(tls ? {
          security: 'tls',
          sni: workerDomain,
          fp: 'randomized',
          type: 'ws',
          host: workerDomain,
          path: WS_PATH,
        } : {
          security: 'none',
          type: 'ws',
          host: workerDomain,
          path: WS_PATH,
        })
      });
      links.push(`${decodeB64('dmxlc3M6Ly8=')}${uuid}@${safeAddr}:${port}?${params.toString()}#${encodeURIComponent(nodeName)}`);
    }
  }

  return links;
}
