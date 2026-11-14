// magpie 网关用量采集：把「非本机设备」的 Token 消耗并进独立历史库。
//
// 为什么需要这一路：另一路数据是 $DSH_HOME/sessions，只有本机能扫到。
// Mac 通过本机 magpie 网关（[::]:3425）调用模型，会话文件在 Mac 上，本机看不到；
// 而网关对每个请求都逐条落账（in/out/cache_read/cache_write + client_ip + provider），
// 所以「外部设备」的用量只能从网关取。
//
// 去重原则（重要）：只保留 client_ip 不属于本机的记录。
// 本机 DSH 自己的请求已经由会话存档计入，把网关里的本机记录也算进来 = 同一批请求算两次。
//
// 独立的 data/gateway-history.jsonl 用来兜住 magpie 的 usage.jsonl：
// 后者没有任何轮转/保留承诺，被截断或重建后历史就没了。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认网关日志位置（magpie 装在用户目录下） */
export function defaultUsageFile() {
  return path.join(os.homedir(), '.config', 'magpie', 'usage.jsonl');
}

/** 本机地址集合：网关里这些 client_ip 属于本机，必须剔除 */
export function localAddresses() {
  const set = new Set(['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a && a.address) set.add(a.address);
  }
  return set;
}

function normalizeIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function isLocalIp(ip, locals) {
  if (!ip) return true;                     // 空 IP = 网关内部调用（额度刷新等），不是外部设备
  if (locals.has(ip)) return true;
  if (ip === '::1' || /^127\./.test(ip)) return true;
  return false;
}

function loadDeviceNames(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!o || typeof o !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[normalizeIp(k)] = v;
    return out;
  } catch { return {}; }
}

/** 解析 magpie usage.jsonl → 归一化的请求记录 */
export function readUsageRows(file) {
  const rows = [];
  if (!file || !fs.existsSync(file)) return rows;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return rows; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Date.parse(r.t);
    if (!Number.isFinite(t)) continue;
    if (r.status != null && Number(r.status) !== 200) continue;
    const ep = String(r.ep || '');
    if (ep.startsWith('/v1/magpie')) continue;        // 网关自身的管理接口不是模型请求
    const input = Number(r.in) || 0;
    const output = Number(r.out) || 0;
    const cacheRead = Number(r.cache_read) || 0;
    const cacheWrite = Number(r.cache_write) || 0;
    const total = input + output + cacheRead + cacheWrite;
    if (total <= 0) continue;                          // 空请求（0 Token）不进统计
    rows.push({
      id: String(r.route_id != null ? r.route_id : `${t}#${r.response_id || ''}`),
      t,
      ip: normalizeIp(r.client_ip),
      agent: r.agent || null,
      provider: r.provider || 'unknown',
      model: r.served || r.model || 'unknown',
      u: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: total,
      },
    });
  }
  return rows;
}

/**
 * 采集外部设备用量并入历史库，返回可直接喂给 buildBundle 的记录数组。
 * records[].device 是给页面显示的设备名（来自 devicesFile 映射，缺省用 IP）。
 */
export function collectGateway({
  usageFile = defaultUsageFile(),
  historyFile = null,
  devicesFile = null,
  pruneDays = 730,
  now = Date.now(),
} = {}) {
  const locals = localAddresses();
  const names = loadDeviceNames(devicesFile);
  const rows = readUsageRows(usageFile);

  const hist = new Map();
  if (historyFile && fs.existsSync(historyFile)) {
    try {
      for (const line of fs.readFileSync(historyFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r && r.id != null) hist.set(String(r.id), r);
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 读不到就当空库 */ }
  }
  const before = hist.size;

  let added = 0;
  for (const r of rows) {
    if (isLocalIp(r.ip, locals)) continue;   // 本机流量：已有会话存档那份，别重复计
    const k = String(r.id);
    if (!hist.has(k)) {
      hist.set(k, { id: k, t: r.t, ip: r.ip, p: r.provider, m: r.model, u: r.u, a: r.agent });
      added += 1;
    }
  }

  const cutoff = now - pruneDays * 86400000;
  const kept = [...hist.values()].filter((r) => r.t >= cutoff).sort((a, b) => a.t - b.t);
  if (historyFile && (added || kept.length !== hist.size)) {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const tmp = `${historyFile}.tmp`;
    fs.writeFileSync(tmp, `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`);
    fs.renameSync(tmp, historyFile);
  }

  const records = kept.map((r) => ({
    id: r.id,
    t: r.t,
    ip: r.ip,
    provider: r.p || 'unknown',
    model: r.m || 'unknown',
    device: names[r.ip] || `设备 ${r.ip}`,
    u: r.u,
  }));

  return {
    records,
    names,
    locals: [...locals],
    usageFile,
    historyFile,
    added,
    total: records.length,
    before,
  };
}