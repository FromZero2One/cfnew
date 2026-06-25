/**
 * ========================================================
 * proxy.js — WebSocket 代理核心（VLESS 协议）
 * ========================================================
 * 处理 WebSocket 升级请求，解析 VLESS 协议头部，
 * 建立到目标服务器的 TCP 连接（直连 + 竞速 + 降级回退）。
 *
 * 连接流程:
 *   Client WebSocket
 *     → VLESS 头部解析（UUID 认证、目标地址提取）
 *     → 直连 TCP（2 路并发竞速，3.5s 首字节超时）
 *     → 失败 → 回退地址 / SOCKS5 / Fallback ProxyIP
 *     → 数据传输（上传队列合并 + 下载聚合优化）
 */

import { connect } from 'cloudflare:sockets';
import {
  ADDR_TYPE_IPV4, ADDR_TYPE_DOMAIN, ADDR_TYPE_IPV6,
  CHUNK_SIZE, DOWNLOAD_PACKET_SIZE, DOWNLOAD_TAIL, DOWNLOAD_DELAY,
  UPLOAD_PACKET_SIZE, UPLOAD_QUEUE_LIMIT, RACE_COUNT, FIRST_BYTE_TIMEOUT,
  getUUIDBytes, checkUUID, toUint8Array, concatU8,
  parseAddressPort, sortByRegion,
  createNodeNamer, ERRORS
} from './utils.js';

// ── 状态引用（由 index.js 在路由阶段设置） ─────────────────────

/**
 * 便捷访问 config.js 中的全局状态
 * 这些函数指针会在 index.js 初始化时注入
 */
let getConfigValue = () => '';
let getBoolConfig = () => false;
let getConfig = () => ({});
let fallbackAddresses = [];

/**
 * 注入配置访问函数（由 index.js 调用）
 * @param {object} deps - 依赖注入对象
 */
export function injectDeps(deps) {
  if (deps.getConfigValue) getConfigValue = deps.getConfigValue;
  if (deps.getBoolConfig) getBoolConfig = deps.getBoolConfig;
  if (deps.getConfig) getConfig = deps.getConfig;
  if (deps.fallbackAddresses) fallbackAddresses = deps.fallbackAddresses;
}

// ── 连接管理 ──────────────────────────────────────────────────

/**
 * 打开 TCP 连接
 * @param {string} host - 目标主机
 * @param {number} port - 目标端口
 * @param {object|null} fetcher - 可选 fetcher（用于测试 API 等）
 * @returns {Promise<object>} Socket 对象
 */
async function openTCPSocket(host, port, fetcher = null) {
  const target = { hostname: host, port };
  if (fetcher && typeof fetcher.connect === 'function') return fetcher.connect(target);
  const sock = connect(target);
  if (sock?.opened) await sock.opened;
  return sock;
}

/**
 * 带竞速的 TCP 连接（同时发起 N 个，取先到者）
 * @param {string} host - 目标主机
 * @param {number} port - 目标端口
 * @param {object|null} fetcher - 可选 fetcher
 * @param {number} raceCount - 竞速并发数
 * @returns {Promise<object>} 最先成功的 Socket
 */
async function connectRace(host, port, fetcher = null, raceCount = RACE_COUNT) {
  const count = Math.max(1, raceCount | 0);
  if (count <= 1) return openTCPSocket(host, port, fetcher);

  const promises = Array.from({ length: count }, () => openTCPSocket(host, port, fetcher));
  const winner = await Promise.any(promises);
  // 关闭失败/慢速的连接
  promises.forEach(p => {
    p.then(sock => { if (sock !== winner) try { sock.close(); } catch (_) {} }, () => {});
  });
  return winner;
}

/**
 * 建立 SOCKS5 代理连接
 * @param {number} addrType - 地址类型
 * @param {string} address - 目标地址
 * @param {number} port - 目标端口
 * @param {object} proxyConfig - 代理配置 { hostname, socksPort, username?, password? }
 * @returns {Promise<object>} 已连接的 Socket
 */
async function connectViaSOCKS5(addrType, address, port, proxyConfig) {
  const { username, password, hostname, socksPort } = proxyConfig;
  const sock = connect({ hostname, port: socksPort });
  const writer = sock.writable.getWriter();

  // 握手：告知支持的方法
  await writer.write(new Uint8Array(username ? [5, 2, 0, 2] : [5, 1, 0]));

  const reader = sock.readable.getReader();
  let resp = (await reader.read()).value;
  if (resp[0] !== 5 || resp[1] === 255) throw new Error('SOCKS5: no acceptable methods');

  // 用户名密码认证
  if (resp[1] === 2) {
    if (!username || !password) throw new Error('SOCKS5: auth required but no credentials');
    const encoder = new TextEncoder();
    const authReq = new Uint8Array([
      1, username.length, ...encoder.encode(username),
      password.length, ...encoder.encode(password)
    ]);
    await writer.write(authReq);
    resp = (await reader.read()).value;
    if (resp[0] !== 1 || resp[1] !== 0) throw new Error('SOCKS5: auth failed');
  }

  // 发送连接请求
  const encoder = new TextEncoder();
  let addrBytes;
  switch (addrType) {
    case ADDR_TYPE_IPV4:
      addrBytes = new Uint8Array([1, ...address.split('.').map(Number)]);
      break;
    case ADDR_TYPE_DOMAIN:
      addrBytes = new Uint8Array([3, address.length, ...encoder.encode(address)]);
      break;
    case ADDR_TYPE_IPV6:
      addrBytes = new Uint8Array([4, ...address.split(':').flatMap(s => {
        const n = parseInt(s, 16);
        return [n >> 8, n & 255];
      })]);
      break;
    default:
      throw new Error(ERRORS.INVALID_ADDR_TYPE);
  }
  await writer.write(new Uint8Array([5, 1, 0, ...addrBytes, port >> 8, port & 255]));
  resp = (await reader.read()).value;
  if (resp[1] !== 0) throw new Error('SOCKS5: connection failed');

  writer.releaseLock();
  reader.releaseLock();
  return sock;
}

// ═══════════════════════════════════════════════════════════════
// 传输优化 —— 上行队列合并（GrainTCP 思路）
// ═══════════════════════════════════════════════════════════════

/**
 * 创建块合并队列
 * 小包合并成大包再发送，减少 TCP 小包数量
 * @param {number} chunkSize - 合并目标大小
 * @param {number} totalLimit - 总字节上限
 * @param {number} itemLimit - 队列条目上限
 * @returns {object} 队列操作对象
 */
function createChunkQueue(chunkSize, totalLimit = chunkSize, itemLimit = Math.max(1, totalLimit >> 8)) {
  let queue = [], head = 0, totalBytes = 0, buffer = null;

  function maybeCompact() {
    if (head > 32 && head * 2 >= queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
  }

  function dequeue() {
    if (head >= queue.length) return null;
    const data = queue[head];
    queue[head++] = undefined;
    totalBytes -= data.byteLength;
    maybeCompact();
    return data;
  }

  return {
    get empty() { return head >= queue.length; },
    clear() { queue = []; head = 0; totalBytes = 0; },
    /** 入队一块数据，返回是否成功 */
    sow(data) {
      const len = data?.byteLength || 0;
      if (!len) return true;
      if (totalBytes + len > totalLimit || queue.length - head >= itemLimit) return false;
      queue.push(data);
      totalBytes += len;
      return true;
    },
    /** 取出合并后的数据块 */
    bundle(data) {
      data = data || dequeue();
      if (!data || head >= queue.length || data.byteLength >= chunkSize) return [data, false];

      let size = data.byteLength;
      let end = head;
      while (end < queue.length) {
        const next = queue[end];
        if (size + next.byteLength > chunkSize) break;
        size += next.byteLength;
        end++;
      }
      if (end === head) return [data, false];

      const out = buffer || new Uint8Array(chunkSize);
      out.set(data);
      let offset = data.byteLength;
      while (head < end) {
        const d = queue[head];
        queue[head++] = undefined;
        totalBytes -= d.byteLength;
        out.set(d, offset);
        offset += d.byteLength;
      }
      maybeCompact();
      return [out.subarray(0, size), true];
    }
  };
}

/**
 * 创建下载聚合发送器
 * 小包聚合到阈值再发送，大包直发
 * @param {WebSocket} ws - Cloudflare WebSocket
 * @returns {object} { send(data), flush() }
 */
function createDownstream(ws) {
  const MAX = DOWNLOAD_PACKET_SIZE;
  const TAIL = DOWNLOAD_TAIL;
  const MIN_AGGREGATE = Math.max(4096, TAIL << 3);
  let buf = new Uint8Array(MAX);
  let len = 0;
  let timer = 0;
  let flushing = false;
  let packetId = 0;
  let key = 0;
  let lazyCount = 0;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = 0;
    flushing = false;
    if (!len) return;
    if (ws.readyState === 1) ws.send(buf.subarray(0, len).slice());
    buf = new Uint8Array(MAX);
    len = 0;
    lazyCount = 0;
  }

  function scheduleFlush() {
    if (timer || flushing) return;
    flushing = true;
    key = packetId;
    queueMicrotask(() => {
      flushing = false;
      if (!len || timer) return;
      if (MAX - len < TAIL) return flush();
      timer = setTimeout(() => {
        timer = 0;
        if (!len) return;
        if (MAX - len < TAIL) return flush();
        if (lazyCount < 2 && (packetId !== key || len < MIN_AGGREGATE)) {
          lazyCount++;
          key = packetId;
          return scheduleFlush();
        }
        flush();
      }, Math.max(DOWNLOAD_DELAY, 1));
    });
  }

  return {
    send(chunk) {
      const data = toUint8Array(chunk);
      let offset = 0;
      const total = data.byteLength;
      if (!total) return;
      while (offset < total) {
        // 缓冲区为空且数据足够大 → 直发
        if (!len && total - offset >= MAX) {
          const sz = Math.min(MAX, total - offset);
          if (ws.readyState === 1) ws.send(offset || sz !== total ? data.subarray(offset, offset + sz) : data);
          offset += sz;
          continue;
        }
        const sz = Math.min(MAX - len, total - offset);
        buf.set(data.subarray(offset, offset + sz), len);
        len += sz;
        offset += sz;
        packetId++;
        if (len === MAX || MAX - len < TAIL) flush();
        else scheduleFlush();
      }
    },
    flush,
  };
}

// ═══════════════════════════════════════════════════════════════
// VLESS 协议解析
// ═══════════════════════════════════════════════════════════════

const sharedDecoder = new TextDecoder();

/**
 * 解析 VLESS WebSocket 数据头部
 * VLESS v1/v2 协议格式:
 *   [0]      - 协议版本
 *   [1-16]   - UUID (16 字节)
 *   [17]     - 附加信息长度
 *   [18..]   - 附加信息
 *   [...     - 命令 (1=TCP, 2=UDP)
 *   [... +1] - 端口 (大端 2 字节)
 *   [... +3] - 地址类型 (1=IPv4, 2=域名, 3=IPv6)
 *   [... +4] - 地址数据
 *
 * @param {Uint8Array} chunk - 原始数据
 * @param {string} token - 期望的 UUID
 * @returns {object} 解析结果 { hasError, addressType, port, hostname, isUDP, rawIndex, version }
 */
export function parseVLESSHeader(chunk, token) {
  const data = toUint8Array(chunk);
  if (data.byteLength < 24) return { hasError: true, message: ERRORS.INVALID_DATA };

  const version = data.subarray(0, 1);
  const uuidBytes = getUUIDBytes(token);
  if (!uuidBytes || !checkUUID(data, 1, uuidBytes)) {
    return { hasError: true, message: ERRORS.INVALID_USER };
  }

  const addonLen = data[17];
  const cmdIdx = 18 + addonLen;
  if (data.byteLength < cmdIdx + 5) return { hasError: true, message: ERRORS.INVALID_DATA };

  const cmd = data[cmdIdx];
  let isUDP = false;
  if (cmd === 1) { /* TCP */ }
  else if (cmd === 2) { isUDP = true; }
  else return { hasError: true, message: ERRORS.UNSUPPORTED_COMMAND };

  const portIdx = 19 + addonLen;
  const port = (data[portIdx] << 8) | data[portIdx + 1];

  let addrIdx = portIdx + 2;
  let addrLen = 0;
  let hostname = '';
  const addrType = data[addrIdx];

  switch (addrType) {
    case ADDR_TYPE_IPV4:
      addrLen = 4;
      if (data.byteLength < addrIdx + 1 + addrLen) return { hasError: true, message: ERRORS.INVALID_DATA };
      hostname = `${data[addrIdx + 1]}.${data[addrIdx + 2]}.${data[addrIdx + 3]}.${data[addrIdx + 4]}`;
      break;
    case ADDR_TYPE_DOMAIN:
      if (data.byteLength < addrIdx + 2) return { hasError: true, message: ERRORS.INVALID_DATA };
      addrLen = data[addrIdx + 1];
      if (data.byteLength < addrIdx + 2 + addrLen) return { hasError: true, message: ERRORS.INVALID_DATA };
      hostname = sharedDecoder.decode(data.subarray(addrIdx + 2, addrIdx + 2 + addrLen));
      break;
    case ADDR_TYPE_IPV6:
      addrLen = 16;
      if (data.byteLength < addrIdx + 1 + addrLen) return { hasError: true, message: ERRORS.INVALID_DATA };
      const parts = [];
      const view = new DataView(data.buffer, data.byteOffset + addrIdx + 1, addrLen);
      for (let i = 0; i < 8; i++) parts.push(view.getUint16(i * 2).toString(16));
      hostname = parts.join(':');
      break;
    default:
      return { hasError: true, message: `${ERRORS.INVALID_ADDR_TYPE}: ${addrType}` };
  }

  if (!hostname) return { hasError: true, message: `${ERRORS.EMPTY_ADDRESS}: ${addrType}` };

  return {
    hasError: false,
    addressType: addrType,
    port,
    hostname,
    isUDP,
    rawIndex: addrIdx + 1 + addrLen,
    version,
  };
}

// ═══════════════════════════════════════════════════════════════
// WebSocket ⇒ TCP 桥接
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 WebSocket → ReadableStream 适配器
 * 将 WS message 事件转为流式数据，同时处理 early data
 * @param {WebSocket} ws - Workers WebSocket
 * @param {string} earlyDataHeader - Sec-WebSocket-Protocol 头中的 early data
 * @returns {ReadableStream} 可读流
 */
function createWSStream(ws, earlyDataHeader) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      ws.addEventListener('message', event => {
        if (!cancelled) controller.enqueue(toUint8Array(event.data));
      });
      ws.addEventListener('close', () => {
        if (!cancelled) { closeWS(ws); controller.close(); }
      });
      ws.addEventListener('error', err => controller.error(err));
      // 处理 early data
      const { earlyData, error } = parseB64Array(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(toUint8Array(earlyData));
    },
    cancel() {
      cancelled = true;
      closeWS(ws);
    }
  });
}

/**
 * Base64 解析（用于 early data）
 */
function parseB64Array(str) {
  if (!str) return { earlyData: null, error: null };
  try {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { earlyData: bytes, error: null };
  } catch (e) {
    return { earlyData: null, error: e };
  }
}

/**
 * 关闭 WebSocket 的辅助函数
 */
function closeWS(ws) {
  try { ws.close(); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// TCP ↔ WebSocket 数据转发
// ═══════════════════════════════════════════════════════════════

/**
 * TCP 可读流 → WebSocket 的转发管道
 * 使用下载聚合优化小包性能
 * @param {object} remoteSocket - TCP Socket
 * @param {WebSocket} ws - WebSocket
 * @param {Uint8Array|null} headerData - 需要拼接的头部数据
 * @param {function|null} retryFn - 降级重试回调
 */
async function pipeTCPtoWS(remoteSocket, ws, headerData, retryFn) {
  let header = headerData;
  let hasData = false;
  let retried = false;

  // 首字节超时：直连握手成功但远端无数据 → 触发降级
  let firstByteTimer = null;
  if (retryFn) {
    firstByteTimer = setTimeout(() => {
      if (!hasData && !retried) {
        retried = true;
        try { remoteSocket.close(); } catch (_) {}
        retryFn();
      }
    }, FIRST_BYTE_TIMEOUT);
  }

  const downstream = createDownstream(ws);
  let reader = null;
  let useByob = true;
  let buffer = new ArrayBuffer(CHUNK_SIZE);

  try {
    try {
      reader = remoteSocket.readable.getReader({ mode: 'byob' });
    } catch (_) {
      useByob = false;
      reader = remoteSocket.readable.getReader();
    }

    for (;;) {
      const result = useByob
        ? await reader.read(new Uint8Array(buffer, 0, CHUNK_SIZE))
        : await reader.read();
      if (result.done) break;

      const value = result.value;
      let chunk = toUint8Array(value);
      const nextBuf = useByob && value?.buffer instanceof ArrayBuffer && value.buffer.byteLength >= CHUNK_SIZE
        ? value.buffer : new ArrayBuffer(CHUNK_SIZE);

      if (!chunk.byteLength) continue;

      if (!hasData) {
        hasData = true;
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      }

      if (ws.readyState !== 1) throw new Error(ERRORS.WS_NOT_OPEN);

      // 拼接 VLESS 响应头部
      if (header) {
        chunk = concatU8(header, chunk);
        header = null;
      }

      // 大块直发，小块聚合
      if (chunk.byteLength >= CHUNK_SIZE >> 1) {
        downstream.flush();
        ws.send(chunk);
        if (useByob) buffer = new ArrayBuffer(CHUNK_SIZE);
      } else {
        downstream.send(chunk.slice());
        if (useByob) buffer = nextBuf;
      }
    }
    downstream.flush();
  } catch (e) {
    if (!retried) closeWS(ws);
  } finally {
    try { downstream.flush(); } catch (_) {}
    try { reader?.releaseLock(); } catch (_) {}
  }

  if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
  if (!hasData && !retried && retryFn) retryFn();
}

// ═══════════════════════════════════════════════════════════════
// UDP DNS 代理（端口 53 专用）
// ═══════════════════════════════════════════════════════════════

async function handleUDPDNS(udpPacket, ws, header, fetcher = null) {
  try {
    const sock = await connectRace('8.8.4.4', 53, fetcher, 1);
    let hdr = header;
    const writer = sock.writable.getWriter();
    await writer.write(udpPacket);
    writer.releaseLock();
    await pipeTCPtoWS(sock, ws, hdr, null);
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// 主连接处理（含三级降级链）
// ═══════════════════════════════════════════════════════════════

/**
 * 建立到目标地址的连接，处理降级逻辑
 *
 * 降级链: 直连 → SOCKS5 → Fallback ProxyIP
 *
 * @param {number} addrType - 地址类型
 * @param {string} host - 目标主机
 * @param {number} port - 目标端口
 * @param {Uint8Array} rawData - 客户端初始数据
 * @param {WebSocket} ws - 客户端 WebSocket
 * @param {Uint8Array|null} vlessHeader - VLESS 响应头部
 * @param {object} connState - 连接状态对象
 * @param {string} reqFallback - 请求级回退地址
 * @param {string} workerRegion - Worker 地区
 * @param {boolean|null} regionMatch - 地区匹配开关
 * @param {object|null} socks5Cfg - SOCKS5 配置
 * @param {boolean} socks5Enabled - SOCKS5 是否启用
 * @param {boolean} downgradeEnabled - 是否启用降级模式
 * @param {object|null} fetcher - Workers fetcher
 */
export async function handleConnect(
  addrType, host, port, rawData, ws, vlessHeader,
  connState, reqFallback, workerRegion, regionMatch,
  socks5Cfg, socks5Enabled, downgradeEnabled, fetcher
) {
  const actualFallback = reqFallback || getConfigValue('proxyIP', '');
  const actualRegion = workerRegion;
  const actualRegionMatch = regionMatch !== null ? regionMatch : getBoolConfig('rm', true);
  const actualSocksCfg = socks5Cfg || null;
  const actualSocksEnabled = socks5Cfg ? true : socks5Enabled;
  const data = toUint8Array(rawData);

  /**
   * 建立连接并发送初始数据
   */
  async function connectAndSend(address, targetPort, useProxy = false) {
    const remote = useProxy
      ? await connectViaSOCKS5(addrType, address, targetPort, actualSocksCfg)
      : await connectRace(address, targetPort, fetcher, RACE_COUNT);
    const writer = remote.writable.getWriter();
    if (data.byteLength) await writer.write(data);
    return { remoteSock: remote, writer };
  }

  /** 清理当前连接 */
  function clearCurrent(sock, writer) {
    if (connState.socket !== sock) return;
    try { writer?.releaseLock(); } catch (_) {}
    connState.socket = null;
    connState.writer = null;
  }

  /** 替换为新的成功连接 */
  function setNewRemote(sock, writer, retryCallback) {
    try {
      if (connState.writer && connState.writer !== writer) connState.writer.releaseLock();
    } catch (_) {}
    connState.socket = sock;
    connState.writer = writer;
    connState.drainUpload?.();
    sock.closed.catch(() => {}).finally(() => {
      if (connState.socket === sock) closeWS(ws);
    });
    pipeTCPtoWS(sock, ws, vlessHeader, retryCallback).finally(() => {
      if (connState.socket === sock) {
        try { writer.releaseLock(); } catch (_) {}
        connState.writer = null;
      }
    });
  }

  /** 重试逻辑（降级） */
  async function handleRetry() {
    if (downgradeEnabled && actualSocksEnabled) {
      // SOCKS5 降级
      try {
        const { remoteSock, writer } = await connectAndSend(host, port, true);
        setNewRemote(remoteSock, writer, null);
        return;
      } catch (_) {
        // SOCKS5 失败 → Fallback
        let fallbackHost, fallbackPort;
        if (actualFallback && actualFallback.trim()) {
          const parsed = parseAddressPort(actualFallback);
          fallbackHost = parsed.address;
          fallbackPort = parsed.port || port;
        } else {
          const addr = getFallbackAddress(actualRegion, actualRegionMatch);
          fallbackHost = addr ? addr.domain : host;
          fallbackPort = addr ? addr.port : port;
        }
        try {
          const { remoteSock, writer } = await connectAndSend(fallbackHost, fallbackPort, false);
          setNewRemote(remoteSock, writer, null);
        } catch (_) { closeWS(ws); }
      }
    } else {
      // 直连 Fallback
      let fallbackHost, fallbackPort;
      if (actualFallback && actualFallback.trim()) {
        const parsed = parseAddressPort(actualFallback);
        fallbackHost = parsed.address;
        fallbackPort = parsed.port || port;
      } else {
        const addr = getFallbackAddress(actualRegion, actualRegionMatch);
        fallbackHost = addr ? addr.domain : host;
        fallbackPort = addr ? addr.port : port;
      }
      try {
        const { remoteSock, writer } = await connectAndSend(fallbackHost, fallbackPort, actualSocksEnabled);
        setNewRemote(remoteSock, writer, null);
      } catch (_) { closeWS(ws); }
    }
  }

  // 主路径：直连尝试
  try {
    const { remoteSock, writer } = await connectAndSend(host, port, downgradeEnabled ? false : actualSocksEnabled);
    setNewRemote(remoteSock, writer, () => {
      clearCurrent(remoteSock, writer);
      handleRetry();
    });
  } catch (_) {
    await handleRetry();
  }
}

/**
 * 从备选地址列表中获取回退地址
 * @param {string} region - Worker 地区
 * @param {boolean} regionMatch - 是否启用地区匹配
 * @returns {object|null} 回退地址对象
 */
function getFallbackAddress(region, regionMatch) {
  if (fallbackAddresses.length === 0) return null;
  const available = fallbackAddresses.map(a => ({ ...a, available: true }));
  if (regionMatch && region) {
    const sorted = sortByRegion(region, available, regionMatch);
    if (sorted.length > 0) return sorted[0];
  }
  return available[0];
}

// ═══════════════════════════════════════════════════════════════
// WebSocket 请求主入口
// ═══════════════════════════════════════════════════════════════

/**
 * 处理 WebSocket 升级请求（代理核心入口）
 *
 * @param {Request} request - HTTP 请求（含 Upgrade: websocket）
 * @param {string} authToken - 认证 UUID
 * @param {object} config - 当前配置
 * @returns {Response} 101 Switching Protocols 或错误
 */
export async function handleWebSocket(request, authToken, config) {
  const url = new URL(request.url);
  const reqFallback = url.searchParams.get('p') || '';
  const reqRegion = (url.searchParams.get('wk') || '').toUpperCase();
  const reqRM = url.searchParams.get('rm') || '';
  const reqRegionMatch = reqRM ? reqRM.toLowerCase() !== 'no' : null;
  const reqSocksStr = url.searchParams.get('s') || '';
  let reqSocksCfg = null;
  if (reqSocksStr) {
    try { reqSocksCfg = parseSocksConfig(reqSocksStr); } catch (_) {}
  }

  // 确定 Worker 地区
  let workerRegion = config.workerRegion || '';
  if (!workerRegion && reqRegion) workerRegion = reqRegion;

  const enableDowngrade = getBoolConfig('qj', false);
  const socksEnabled = config.socks5Enabled || false;
  const socksCfg = config.socks5Config || {};

  const wsPair = new WebSocketPair();
  const [client, server] = Object.values(wsPair);
  server.accept();
  server.binaryType = 'arraybuffer';

  const connState = {
    socket: null,
    writer: null,
    drainUpload: null,
  };

  let isDNS = false;
  let protocolType = null;
  let flushing = false;
  let transportClosed = false;

  const uploadQueue = createChunkQueue(UPLOAD_PACKET_SIZE, UPLOAD_QUEUE_LIMIT, UPLOAD_QUEUE_LIMIT >> 8);
  const fetcher = request.fetcher;

  // ── 上传处理 ──────────────────────────────────────────────

  function releaseWriter() {
    try { connState.writer?.releaseLock(); } catch (_) {}
    connState.writer = null;
  }

  function closeTransport() {
    if (transportClosed) return;
    transportClosed = true;
    uploadQueue.clear();
    releaseWriter();
    try { connState.socket?.close(); } catch (_) {}
    closeWS(server);
  }

  function enqueueUpload(chunk) {
    const data = toUint8Array(chunk);
    if (!data.byteLength) return true;
    if (!uploadQueue.sow(data)) { closeTransport(); return false; }
    connState.drainUpload();
    return true;
  }

  async function flushUploads() {
    if (flushing || transportClosed || !connState.writer) return;
    flushing = true;
    try {
      for (;;) {
        if (transportClosed || !connState.writer) break;
        const [bundle] = uploadQueue.bundle();
        if (!bundle) break;
        await connState.writer.write(bundle);
      }
    } catch (_) { closeTransport(); }
    finally {
      flushing = false;
      if (!uploadQueue.empty && !transportClosed && connState.writer) queueMicrotask(flushUploads);
    }
  }

  connState.drainUpload = () => {
    if (!flushing && !uploadQueue.empty && connState.writer) queueMicrotask(flushUploads);
  };

  // ── 数据流处理（VLESS 协议解析 + 连接建立） ─────────────

  const earlyDataHeader = request.headers.get(atob('c2VjLXdlYnNvY2tldC1wcm90b2NvbA==')) || '';
  const wsStream = createWSStream(server, earlyDataHeader);

  wsStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (transportClosed) return;
      const data = toUint8Array(chunk);

      // DNS 模式直接转发
      if (isDNS) return handleUDPDNS(data, server, null, fetcher);

      // 已有连接 → 直接写入上传队列
      if (connState.socket && connState.writer) {
        if (!enqueueUpload(data)) throw new Error('upload queue overflow');
        return;
      }

      // 已解析协议但连接尚未建立 → 也入队
      if (protocolType) {
        if (!enqueueUpload(data)) throw new Error('upload queue overflow');
        return;
      }

      // 首次数据 → 尝试解析 VLESS 协议
      if (!protocolType) {
        // VLESS 解析（最少 24 字节）
        if (config.enableVLESS && data.byteLength >= 24) {
          const result = parseVLESSHeader(data, authToken);
          if (!result.hasError) {
            protocolType = 'vless';
            const { addressType, port, hostname, rawIndex, version, isUDP } = result;

            if (isUDP) {
              if (port === 53) isDNS = true;
              else throw new Error(ERRORS.UDP_DNS_ONLY);
            }

            const respHeader = new Uint8Array([version[0], 0]);
            const remaining = data.subarray(rawIndex);

            if (isDNS) return handleUDPDNS(remaining, server, respHeader, fetcher);

            await handleConnect(
              addressType, hostname, port, remaining,
              server, respHeader, connState,
              reqFallback, workerRegion, reqRegionMatch,
              reqSocksCfg || socksCfg, reqSocksCfg ? true : socksEnabled,
              enableDowngrade, fetcher
            );
            return;
          }
        }

        throw new Error('Unsupported protocol or authentication failed');
      }
    },
  })).catch(err => { closeTransport(); });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// ── SOCKS5 配置解析 ──────────────────────────────────────────

/**
 * 解析 "username:password@host:port" 格式的 SOCKS5 配置
 * @param {string} str - 配置字符串
 * @returns {object} 解析结果
 */
function parseSocksConfig(str) {
  let [userpass, rest] = str.split("@").reverse();
  let username, password, hostname, socksPort;
  if (rest) {
    const parts = rest.split(":");
    if (parts.length !== 2) throw new Error('Invalid SOCKS5 address');
    [username, password] = parts;
  }
  const parts = rest ? rest.split(":") : [];
  socksPort = Number(rest ? parts.pop() : '');
  if (isNaN(socksPort)) throw new Error('Invalid SOCKS5 port');
  hostname = rest ? (rest.includes('@') ? parts.join(":") : rest) : parts.join(":");
  return { username, password, hostname, socksPort };
}
