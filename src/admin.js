/**
 * ========================================================
 * admin.js — 管理面板 + REST API
 * ========================================================
 * 提供:
 *   1. 管理面板 HTML（单页应用，内联 CSS/JS）
 *   2. 配置管理 API（GET/POST /{path}/api/config）
 *   3. 优选 IP 管理 API（GET/POST/DELETE /{path}/api/preferred-ips）
 */

import { getConfig, getConfigValue, getBoolConfig, getKVStatus, saveKVConfig, refreshConfig } from './config.js';
import { generateClash, generateSingbox, generateBase64, generateVLESSLinks } from './subscribe.js';
import { createNodeNamer, isValidAddress, parseAddressPort } from './utils.js';

const DEFAULT_DIRECT_DOMAINS = [
  { name: "cloudflare.182682.xyz", domain: "cloudflare.182682.xyz" },
  { name: "speed.marisalnc.com", domain: "speed.marisalnc.com" },
  { domain: "freeyx.cloudflare88.eu.org" },
  { domain: "bestcf.top" },
  { domain: "cdn.2020111.xyz" },
  { domain: "cf.090227.xyz" },
  { domain: "cf.877771.xyz" },
  { domain: "cdn.tzpro.xyz" },
];

const FALLBACK_ADDRESSES = [
  { domain: 'ProxyIP.HK.CMLiussss.net', region: 'HK', regionCode: 'HK', port: 443 },
  { domain: 'ProxyIP.US.CMLiussss.net', region: 'US', regionCode: 'US', port: 443 },
  { domain: 'ProxyIP.SG.CMLiussss.net', region: 'SG', regionCode: 'SG', port: 443 },
  { domain: 'ProxyIP.JP.CMLiussss.net', region: 'JP', regionCode: 'JP', port: 443 },
  { domain: 'ProxyIP.KR.CMLiussss.net', region: 'KR', regionCode: 'KR', port: 443 },
  { domain: 'ProxyIP.DE.CMLiussss.net', region: 'DE', regionCode: 'DE', port: 443 },
  { domain: 'ProxyIP.GB.CMLiussss.net', region: 'GB', regionCode: 'GB', port: 443 },
];

// ─── Config API ──────────────────────────────────────────────

export async function handleConfigAPI(request, env) {
  if (request.method === 'GET') {
    const cfg = getConfig();
    const kvStatus = getKVStatus();
    return new Response(JSON.stringify({ config: cfg, kvStatus, timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      await saveKVConfig(body);
      await refreshConfig(env);
      return new Response(JSON.stringify({ success: true, message: '配置已保存' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}

// ─── Preferred IPs API ───────────────────────────────────────

let preferredIPs = [];
let preferredDomains = [];

function loadPreferredFromConfig() {
  const cfg = getConfig();
  const yx = cfg.yx || '';
  preferredIPs = [];
  preferredDomains = [];
  if (yx) {
    yx.split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(item) {
      var name = '';
      var addrPart = item;
      if (item.includes('#')) {
        var parts = item.split('#');
        addrPart = parts[0].trim();
        name = parts[1].trim();
      }
      var parsed = parseAddressPort(addrPart);
      if (!name) name = addrPart;
      if (isValidAddress(parsed.address)) {
        preferredIPs.push({ ip: parsed.address, port: parsed.port, isp: name });
      } else {
        preferredDomains.push({ domain: parsed.address, port: parsed.port, name: name });
      }
    });
  }
}

export function getPreferredIPs() {
  loadPreferredFromConfig();
  return { ips: preferredIPs, domains: preferredDomains };
}

export async function handlePreferredIPsAPI(request) {
  if (request.method === 'GET') {
    return new Response(JSON.stringify(getPreferredIPs()), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'POST') {
    try {
      var body = await request.json();
      var current = getConfigValue('yx', '');
      var existing = current ? current.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
      if (body.all === true && Array.isArray(body.ips)) {
        existing.push.apply(existing, body.ips);
      } else if (body.ip) {
        existing.push(body.ip);
      }
      await saveKVConfig({ yx: existing.join(',') });
      loadPreferredFromConfig();
      return new Response(JSON.stringify({ success: true, count: existing.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (request.method === 'DELETE') {
    try {
      var body = await request.json();
      if (body.all === true) {
        await saveKVConfig({ yx: '' });
        preferredIPs = []; preferredDomains = [];
        return new Response(JSON.stringify({ success: true, message: '已清空' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } else if (body.ip) {
        var current = getConfigValue('yx', '');
        var list = current ? current.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
        await saveKVConfig({ yx: list.filter(function(item) { return !item.includes(body.ip); }).join(',') });
        loadPreferredFromConfig();
        return new Response(JSON.stringify({ success: true, message: '已删除' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}

// ─── Subscription Handler ────────────────────────────────────

export async function handleSubscription(request, authToken, config, workerDomain) {
  var url = new URL(request.url);
  var target = url.searchParams.get('target') || 'base64';
  var namer = createNodeNamer(false);
  var allLinks = [];

  async function addNodes(ipList) {
    var links = generateVLESSLinks(ipList, authToken, workerDomain, config.disableNonTLS, false, namer);
    allLinks.push.apply(allLinks, links);
  }

  if (getBoolConfig('ena', false) && workerDomain) {
    await addNodes([{ ip: workerDomain, isp: '原生地址' }]);
  }

  loadPreferredFromConfig();
  var hasCustom = preferredIPs.length > 0 || preferredDomains.length > 0;
  if (getBoolConfig('yxby', false)) {
    // preferred disabled
  } else if (hasCustom) {
    if (preferredIPs.length > 0 && getBoolConfig('epi', true)) await addNodes(preferredIPs);
    if (preferredDomains.length > 0 && getBoolConfig('epd', true)) {
      await addNodes(preferredDomains.map(function(d) { return { ip: d.domain, isp: d.name || d.domain, port: d.port }; }));
    }
  } else {
    if (getBoolConfig('epd', true)) {
      await addNodes(DEFAULT_DIRECT_DOMAINS.map(function(d) { return { ip: d.domain, isp: d.name || d.domain }; }));
    }
  }

  if (allLinks.length === 0) {
    var fallback = FALLBACK_ADDRESSES.find(function(a) { return a.region === (config.workerRegion || 'SG'); }) || FALLBACK_ADDRESSES[0];
    await addNodes([{ ip: fallback.domain, isp: 'ProxyIP-' + fallback.region, port: fallback.port }]);
  }

  var content, contentType;
  var t = target.toLowerCase();
  if (t === 'clash' || t === 'clashr' || t === 'meta' || t === 'clashmeta') {
    content = generateClash(allLinks, config.customDNS);
    contentType = 'text/yaml; charset=utf-8';
  } else if (t === 'singbox' || t === 'sing-box') {
    content = generateSingbox(allLinks, config.customDNS);
    contentType = 'application/json; charset=utf-8';
  } else {
    content = generateBase64(allLinks);
    contentType = 'text/plain; charset=utf-8';
  }

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

// ─── Admin Page HTML ─────────────────────────────────────────

export function renderAdminPage(config, workerDomain, kvAvailable) {
  var cfg = config || {};
  var path = cfg.customPath || cfg.uuid || '';
  var subBase = '/' + path + '/sub';

  return '<!DOCTYPE html>' +
  '<html lang="zh-CN"><head>' +
  '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
  '<title>CFnew — 管理面板</title>' +
  '<style>' +
  '*{margin:0;padding:0;box-sizing:border-box}' +
  'body{font-family:"JetBrains Mono","Fira Code","Courier New",monospace;' +
  'background:radial-gradient(ellipse at 80% -10%,#2a0040 0%,#05030e 50%,#000 100%);' +
  'color:#e6f5ff;min-height:100vh;padding:24px}' +
  'body::before{content:"";position:fixed;inset:0;' +
  'background-image:linear-gradient(rgba(255,43,214,0.08) 1px,transparent 1px),' +
  'linear-gradient(90deg,rgba(255,43,214,0.08) 1px,transparent 1px);' +
  'background-size:48px 48px;z-index:-1;pointer-events:none}' +
  '.container{max-width:1100px;margin:0 auto}' +
  '.header{text-align:center;padding:20px 24px;margin-bottom:24px;' +
  'border:1px solid rgba(0,240,255,0.55);' +
  'background:linear-gradient(135deg,rgba(15,3,40,0.8),rgba(40,5,70,0.6));' +
  'box-shadow:0 0 30px rgba(0,240,255,0.2)}' +
  '.header h1{font-size:2rem;color:#00f0ff;text-shadow:0 0 12px #00f0ff,-2px 0 #ff2bd6,2px 0 #00ff9d;' +
  'letter-spacing:0.08em;text-transform:uppercase}' +
  '.header p{color:#7aa9c4;font-size:0.9rem}' +
  '.card{background:linear-gradient(180deg,rgba(8,4,28,0.9),rgba(15,3,40,0.8));' +
  'border:1px solid rgba(0,240,255,0.55);padding:20px 24px;margin-bottom:18px}' +
  '.card h2{color:#00f0ff;font-size:1rem;letter-spacing:0.2em;text-transform:uppercase;' +
  'margin-bottom:16px;display:flex;align-items:center;gap:10px}' +
  '.card h2::before{content:"";width:10px;height:10px;background:#ff2bd6;transform:rotate(45deg)}' +
  '.card h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#00f0ff,transparent)}' +
  '.btn{background:linear-gradient(135deg,rgba(0,240,255,0.12),rgba(255,43,214,0.12));' +
  'border:1px solid rgba(0,240,255,0.55);padding:10px 18px;color:#00f0ff;font-family:inherit;' +
  'font-size:0.85rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer}' +
  '.btn:hover{color:#ff2bd6;border-color:#ff2bd6;box-shadow:0 0 14px rgba(255,43,214,0.4)}' +
  '.btn-primary{border-color:#00ff9d;color:#00ff9d}' +
  '.btn-primary:hover{color:#ff2bd6;border-color:#ff2bd6}' +
  '.btn-sm{padding:6px 12px;font-size:0.75rem}' +
  'input,select{background:rgba(0,0,0,0.6);border:1px solid rgba(0,240,255,0.55);' +
  'color:#00f0ff;padding:8px 12px;font-family:inherit;font-size:0.85rem;outline:none;width:100%}' +
  'input:focus,select:focus{border-color:#ff2bd6;box-shadow:0 0 10px rgba(255,43,214,0.3)}' +
  'label{display:block;margin-bottom:4px;color:#7aa9c4;font-size:0.8rem}' +
  '.form-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}' +
  '.form-group{margin-bottom:10px;flex:1;min-width:200px}' +
  '.sub-url{background:rgba(0,0,0,0.7);border:1px dashed #ff2bd6;padding:12px 16px;' +
  'word-break:break-all;color:#00ff9d;margin-top:12px;font-size:0.85rem;cursor:pointer}' +
  '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:10px 0}' +
  '.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}' +
  '.stat{padding:10px;border:1px solid rgba(0,240,255,0.2)}' +
  '.stat-label{color:#7aa9c4;font-size:0.75rem}' +
  '.stat-value{color:#00ff9d;font-size:1rem}' +
  '.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;' +
  'background:rgba(8,4,28,0.95);border:1px solid #00ff9d;color:#00ff9d;z-index:9999;animation:fadeIn 0.3s}' +
  '.toast.error{border-color:#ff3860;color:#ff3860}' +
  '@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}' +
  '</style></head><body>' +
  '<div class="container">' +
  '<div class="header"><h1>// CFNEW / NIGHTCITY</h1><p>管理面板 v3.0 — VLESS 代理服务</p></div>' +

  // Client selection
  '<div class="card"><h2>客户端</h2>' +
  '<div class="grid">' +
  '<button class="btn" onclick="copySub(\'clash\')">CLASH</button>' +
  '<button class="btn" onclick="copySub(\'singbox\')">SING-BOX</button>' +
  '<button class="btn" onclick="copySub(\'v2ray\')">V2RAY</button>' +
  '</div>' +
  '<div id="subUrl" class="sub-url" style="display:none"></div></div>' +

  // System status
  '<div class="card"><h2>系统状态</h2>' +
  '<div class="status-grid">' +
  '<div class="stat"><div class="stat-label">Worker</div><div class="stat-value">' +
  (cfg.workerRegion || '检测中...') + '</div></div>' +
  '<div class="stat"><div class="stat-label">KV</div><div class="stat-value">' +
  (kvAvailable ? '✅ 已启用' : '⚠️ 未配置') + '</div></div>' +
  '<div class="stat"><div class="stat-label">协议</div><div class="stat-value">VLESS</div></div>' +
  '<div class="stat"><div class="stat-label">域</div><div class="stat-value">' +
  (workerDomain || '-') + '</div></div>' +
  '</div></div>' +

  // Config form
  '<div class="card"><h2>配置管理</h2>' +
  '<div class="form-row">' +
  '<div class="form-group"><label>自定义路径 (d)</label>' +
  '<input type="text" id="cfg_customPath" value="' + esc(cfg.customPath) + '" placeholder="留空使用UUID"></div>' +
  '<div class="form-group"><label>ProxyIP (p)</label>' +
  '<input type="text" id="cfg_proxyIP" value="' + esc(cfg.proxyIP) + '" placeholder="host:port"></div>' +
  '</div>' +
  '<div class="form-group"><label>优选IP (yx) — IP#名称,IP2#名称</label>' +
  '<input type="text" id="cfg_yx" value="' + esc(cfg.yx) + '" placeholder="1.2.3.4#节点1"></div>' +
  '<div class="form-row">' +
  '<div class="form-group"><label>SOCKS5 (s)</label>' +
  '<input type="text" id="cfg_socks5" value="' + esc(cfg.socks5) + '" placeholder="user:pass@host:port"></div>' +
  '<div class="form-group"><label>DNS (customDNS)</label>' +
  '<input type="text" id="cfg_customDNS" value="' + esc(cfg.customDNS || 'https://223.5.5.5/dns-query') + '"></div>' +
  '</div>' +
  '<button class="btn btn-primary" onclick="saveConfig()">保存配置</button></div>' +

  // Advanced
  '<div class="card"><h2>高级控制</h2>' +
  '<div class="form-row">' +
  '<label><input type="checkbox" id="adv_downgrade"' +
  (getBoolConfig('qj', false) ? ' checked' : '') + '> 降级模式 (qj)</label>' +
  '<label><input type="checkbox" id="adv_tlsOnly"' +
  (getBoolConfig('dkby', false) ? ' checked' : '') + '> 仅 TLS (dkby)</label>' +
  '<label><input type="checkbox" id="adv_disablePreferred"' +
  (getBoolConfig('yxby', false) ? ' checked' : '') + '> 关闭优选 (yxby)</label>' +
  '</div>' +
  '<div class="form-row">' +
  '<label><input type="checkbox" id="adv_ech"' +
  (cfg.ech === 'yes' ? ' checked' : '') + '> ECH</label>' +
  '<label><input type="checkbox" id="adv_native"' +
  (getBoolConfig('ena', false) ? ' checked' : '') + '> 原生地址</label>' +
  '</div>' +
  '<button class="btn btn-sm" onclick="saveAdvanced()">保存高级设置</button></div>' +

  // Subscription links
  '<div class="card"><h2>订阅链接</h2>' +
  '<div class="form-group"><label>Clash</label>' +
  '<div class="sub-url" onclick="copyText(this)">' + subBase + '?target=clash</div></div>' +
  '<div class="form-group"><label>Sing-box</label>' +
  '<div class="sub-url" onclick="copyText(this)">' + subBase + '?target=singbox</div></div>' +
  '<div class="form-group"><label>V2Ray</label>' +
  '<div class="sub-url" onclick="copyText(this)">' + subBase + '?target=v2ray</div></div>' +
  '</div></div>' +

  // JavaScript
  '<script>' +
  'var B="' + subBase + '";' +
  'function copySub(t){var u=location.origin+B+"?target="+t;' +
  'var d=document.getElementById("subUrl");d.style.display="block";d.textContent=u;' +
  'navigator.clipboard.writeText(u).then(function(){showToast("已复制 "+t+" 订阅链接")})["catch"](function(){})}' +
  'function copyText(el){navigator.clipboard.writeText(location.origin+el.textContent.trim())' +
  '.then(function(){showToast("已复制到剪贴板")})["catch"](function(){})}' +
  'function showToast(m,e){var t=document.createElement("div");' +
  't.className="toast"+(e?" error":"");t.textContent=m;' +
  'document.body.appendChild(t);setTimeout(function(){t.remove()},3000)}' +
  'async function saveConfig(){var d={' +
  'customPath:document.getElementById("cfg_customPath").value.trim(),' +
  'proxyIP:document.getElementById("cfg_proxyIP").value.trim(),' +
  'yx:document.getElementById("cfg_yx").value.trim(),' +
  'socks5:document.getElementById("cfg_socks5").value.trim(),' +
  'customDNS:document.getElementById("cfg_customDNS").value.trim()};' +
  'try{var r=await fetch(location.pathname.replace(/\\/api\\/config.*/,"/api/config"),' +
  '{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});' +
  'var j=await r.json();j.success?showToast("✅ 配置已保存"):showToast(j.error||"保存失败",true)}' +
  'catch(e){showToast(e.message,true)}}' +
  'async function saveAdvanced(){var d={' +
  'qj:document.getElementById("adv_downgrade").checked?"no":"",' +
  'dkby:document.getElementById("adv_tlsOnly").checked?"yes":"",' +
  'yxby:document.getElementById("adv_disablePreferred").checked?"yes":"",' +
  'ech:document.getElementById("adv_ech").checked?"yes":"",' +
  'ena:document.getElementById("adv_native").checked?"yes":""};' +
  'try{var r=await fetch(location.pathname.replace(/\\/api\\/config.*/,"/api/config"),' +
  '{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});' +
  'var j=await r.json();j.success?showToast("✅ 高级设置已保存"):showToast(j.error||"保存失败",true)}' +
  'catch(e){showToast(e.message,true)}}' +
  '</script></body></html>';
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
