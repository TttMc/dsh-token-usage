// DSH Token 用量聚合：扫描 $DSH_HOME/sessions/**/session.v4.jsonl.zstd，
// 按文件 mtime+size 做增量缓存，输出给前端用的汇总 JSON。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeSessionFile } from './frames.mjs';

const TZ = 'Asia/Shanghai';

/** 把毫秒时间戳格式化成指定时区的 YYYY-MM-DD / YYYY-MM-DDTHH */
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHour = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });

function dayKey(ms) { return fmtDay.format(new Date(ms)); }
function hourKey(ms) {
  // en-CA 的 hour12:false 可能给 24，统一成 00
  const parts = fmtHour.formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')}T${hh}`;
}

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 });

/**
 * 模型名归并：同一模型在各渠道有不同写法，统计时按同一模型合并。
 * 判定方式：去掉所有非字母数字后做前缀匹配，避免被 . - _ 的写法差异干扰。
 * 注意顺序——v41 必须排在 v4 之前，否则 v41 会被 v4 规则先吃掉。
 *
 * 2026-11-01 补充口径（用户确认）：
 *   - Qoder 渠道的 `dfmodel` 就是 DeepSeek-V4-Flash 的内部代号（插件模型表里 key→displayName）
 *   - 上游已把 V4 Flash 路由到 V4.1 Flash 上，两者实际是同一个模型，合并计
 *   - `sn-deepseek-v4-1-flash-1017` 是思考版变体，同样并入
 *   - 老名字 `deepseek-flash`（只出现在归档账本里）也归入
 *   - 除非自己部署，否则看不到真正的独立 V4 Flash
 */
const MODEL_RULES = [
  // V4.1 Flash 家族：v4.1-flash / v4-flash / deepseek-flash / dfmodel / sn-*-1017
  [/^(sn)?deepseekv41flash/, 'DeepSeek V4.1 Flash'],
  [/^(sn)?deepseekv4flash/, 'DeepSeek V4.1 Flash'],
  [/^deepseekflash/, 'DeepSeek V4.1 Flash'],
  [/^dfmodel/, 'DeepSeek V4.1 Flash'],
  // Pro 系列保持独立
  [/^(sn)?deepseekv41pro/, 'DeepSeek V4.1 Pro'],
  [/^(sn)?deepseekv4pro/, 'DeepSeek V4 Pro'],
  [/^dmodel/, 'DeepSeek V4 Pro'],
  // Qoder 的自动选择别名，实际落到哪个模型不确定，单独成一条更诚实
  [/^(balanced|default)model/, '自动路由（未指定模型）'],
];

export function canonicalModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return 'unknown';
  const k = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [re, name] of MODEL_RULES) if (re.test(k)) return name;
  return raw;
}

function add(into, u) {
  into.input += u.inputTokens || 0;
  into.output += u.outputTokens || 0;
  into.cacheRead += u.cacheReadTokens || 0;
  into.cacheWrite += u.cacheWriteTokens || 0;
  into.total += u.totalTokens || 0;
  into.requests += 1;
  return into;
}

function sessionFiles(sessionsRoot) {
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return out; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, ws.name);
    let entries = [];
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(wsDir, e.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(f);
        out.push({ file: f, id: e.name, workspace: ws.name, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* 没有会话文件 */ }
    }
  }
  return out;
}

/** 单个会话文件 → 精简记录（含逐条 usage，用于任意时间窗重算） */
function parseSession(file) {
  const events = decodeSessionFile(file);
  const head = events.find((e) => e.type === 'session') || {};
  const usages = [];
  let cfg = null;
  let title = null;
  for (const e of events) {
    if (e.type === 'request/header') {
      const c = e.data?.header?.config;
      if (c) cfg = { provider: c.provider || 'unknown', model: c.model || 'unknown' };
    } else if (e.type === 'assistant/message' && e.data?.usage?.totalTokens) {
      usages.push({
        seq: e.seq ?? null,
        t: e.time,
        provider: cfg?.provider || 'unknown',
        model: cfg?.model || 'unknown',
        u: e.data.usage,
      });
    } else if (e.type === 'session/title' && !title) {
      title = e.data?.title || null;
    }
  }
  return {
    id: head.id || null,
    createdAt: head.createdAt || (usages[0]?.t ?? null),
    cwd: head.cwd || null,
    origin: head.origin || 'user',        // user = 主会话；subagent = 子代理
    parentSession: head.parentSession || null,
    delegationDepth: head.delegationDepth || 0,
    agentPreset: head.agentPreset || null,
    title,
    usages,
  };
}

export function loadCache(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw && raw.version === 1 && raw.sessions) return raw;
  } catch { /* 无缓存 */ }
  return { version: 1, sessions: {} };
}

export function saveCache(cacheFile, cache) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, cacheFile);
}

export function scan({ dshHome, cacheFile, force = false }) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const cache = force ? { version: 1, sessions: {} } : loadCache(cacheFile);
  const files = sessionFiles(sessionsRoot);
  const seen = new Set();
  let parsed = 0;
  for (const f of files) {
    const key = f.file;
    seen.add(key);
    const prev = cache.sessions[key];
    if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue;
    try {
      const rec = parseSession(f.file);
      cache.sessions[key] = { ...rec, mtimeMs: f.mtimeMs, size: f.size, workspace: f.workspace };
      parsed += 1;
    } catch {
      if (!prev) cache.sessions[key] = { mtimeMs: f.mtimeMs, size: f.size, usages: [], error: true };
    }
  }
  // 清掉已删除的会话
  for (const k of Object.keys(cache.sessions)) if (!seen.has(k)) delete cache.sessions[k];
  if (parsed || force) saveCache(cacheFile, cache);
  return { cache, parsed, files: files.length };
}

/** 用缓存构建任意时间窗的汇总（sinceMs / untilMs 均可省略，窗口左闭右开）
 *  includeLegacy: 是否纳入「归档导入」的历史记录（provider==='archived'）。
 *  滚动窗口（今日/7天/30天）默认不纳——归档数据只有按天的粗粒度，
 *  落到「最近 N 天」里会让那些天凭空变大，属于假数据。
 *  「全部」和「月度」才纳入，因为它们的语义就是「这段历史一共用了多少」。
 */
export function buildStats(cache, { sinceMs = null, untilMs = null, now = Date.now(), includeLegacy = true, external = [] } = {}) {
  const all = [];
  for (const [file, rec] of Object.entries(cache.sessions)) {
    const sid = rec.id || path.basename(path.dirname(file));
    for (const it of rec.usages || []) {
      if (sinceMs != null && it.t < sinceMs) continue;
      if (untilMs != null && it.t >= untilMs) continue;
      if (!includeLegacy && it.provider === 'archived') continue;
      all.push({ ...it, file, origin: rec.origin || 'user', sessionId: sid, title: rec.title || null, cwd: rec.cwd || null });
    }
  }
  // 外部设备（经本机 magpie 网关的其它机器）：调用方已在 gateway.mjs 里剔除本机 IP，
  // 所以这批记录和上面的会话存档互斥，直接并入不会双算。
  for (const g of external) {
    if (sinceMs != null && g.t < sinceMs) continue;
    if (untilMs != null && g.t >= untilMs) continue;
    all.push({
      t: g.t, provider: g.provider, model: g.model, u: g.u,
      origin: 'gateway', sessionId: `gw:${g.device}`, title: null, cwd: null,
      device: g.device, ip: g.ip,
    });
  }

  all.sort((a, b) => a.t - b.t);

  const totals = zero();
  const byDay = new Map();
  const byHour = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const byClient = new Map();
  const bySession = new Map();
  const activeDays = new Set();
  const byDevice = new Map();   // 只装外部设备（origin === 'gateway'）

  for (const it of all) {
    add(totals, it.u);
    const d = dayKey(it.t);
    activeDays.add(d);
    if (!byDay.has(d)) byDay.set(d, zero());
    add(byDay.get(d), it.u);
    const h = hourKey(it.t);
    if (!byHour.has(h)) byHour.set(h, zero());
    add(byHour.get(h), it.u);

    const mk = canonicalModel(it.model);
    if (!byModel.has(mk)) byModel.set(mk, { ...zero(), provider: it.provider, model: mk, providers: new Set() });
    const mrec = byModel.get(mk);
    mrec.providers.add(it.provider);
    add(mrec, it.u);

    if (!byProvider.has(it.provider)) byProvider.set(it.provider, zero());
    add(byProvider.get(it.provider), it.u);

    if (it.origin === 'gateway') {
      // 外部设备：不计入会话数、不进会话排行，只按设备单独汇总
      const dk = it.device;
      if (!byDevice.has(dk)) byDevice.set(dk, { ...zero(), device: dk, ip: it.ip, first: it.t, last: it.t, models: new Map() });
      const dev = byDevice.get(dk);
      add(dev, it.u);
      dev.first = Math.min(dev.first, it.t);
      dev.last = Math.max(dev.last, it.t);
      dev.models.set(mk, (dev.models.get(mk) || 0) + (it.u.totalTokens || 0));
      continue;
    }

    const ck = it.origin === 'subagent' ? 'subagent' : 'main';
    if (!byClient.has(ck)) byClient.set(ck, { ...zero(), sessions: new Set() });
    add(byClient.get(ck), it.u);
    byClient.get(ck).sessions.add(it.sessionId);

    if (!bySession.has(it.sessionId)) bySession.set(it.sessionId, { ...zero(), id: it.sessionId, title: it.title, cwd: it.cwd, first: it.t, last: it.t, origin: it.origin });
    const s = bySession.get(it.sessionId);
    add(s, it.u);
    s.first = Math.min(s.first, it.t);
    s.last = Math.max(s.last, it.t);
  }

  // 按自然日补零：趋势图需要连续日期轴，缺的日子补 0（起点取时间窗起点，最长 90 天）
  const daySeries = [];
  if (byDay.size) {
    const keys = [...byDay.keys()].sort();
    let startMs = Date.parse(`${keys[0]}T00:00:00Z`);
    if (sinceMs != null) startMs = Math.max(startMs, Date.parse(`${dayKey(sinceMs)}T00:00:00Z`));
    const endMs = Date.parse(`${keys[keys.length - 1]}T00:00:00Z`);
    for (let cur = startMs; cur <= endMs; cur += 86400000) {
      const d = new Date(cur).toISOString().slice(0, 10);
      daySeries.push({ day: d, ...(byDay.get(d) || zero()) });
    }
  }

  const sortByTotal = (m) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.total - a.total);
  const sessionsOf = (m) => [...m.entries()].map(([k, v]) => ({
    key: k, ...v, sessions: v.sessions instanceof Set ? v.sessions.size : v.sessions,
  })).sort((a, b) => b.total - a.total);

  const cacheDenom = totals.cacheRead + totals.input;

  return {
    generatedAt: now,
    timeZone: TZ,
    range: { sinceMs, days: sinceMs == null ? null : Math.round((now - sinceMs) / 86400000) },
    totals: {
      ...totals,
      cacheHitRate: cacheDenom ? totals.cacheRead / cacheDenom : 0,
      sessions: bySession.size,
      activeDays: activeDays.size,
    },
    byDay: daySeries,
    byHour: [...byHour.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => (a.hour < b.hour ? -1 : 1)),
    byModel: sortByTotal(byModel).map((m) => {
      const providers = m.providers instanceof Set ? [...m.providers] : [];
      return {
        ...m,
        provider: providers.length === 1 ? providers[0] : providers.length > 1 ? 'multi' : m.provider,
        providerCount: providers.length,
        cacheHitRate: m.cacheRead + m.input ? m.cacheRead / (m.cacheRead + m.input) : 0,
      };
    }),
    byProvider: sortByTotal(byProvider),
    byClient: sessionsOf(byClient).map((c) => ({ ...c, cacheHitRate: c.cacheRead + c.input ? c.cacheRead / (c.cacheRead + c.input) : 0 })),
    // 外部设备（经本机网关的其它机器），已与会话存档去重；页面单独一块展示
    byDevice: [...byDevice.values()].map((d) => ({
      device: d.device,
      ip: d.ip,
      input: d.input,
      output: d.output,
      cacheRead: d.cacheRead,
      cacheWrite: d.cacheWrite,
      total: d.total,
      requests: d.requests,
      cacheHitRate: d.cacheRead + d.input ? d.cacheRead / (d.cacheRead + d.input) : 0,
      first: d.first,
      last: d.last,
      models: [...d.models.entries()].map(([model, total]) => ({ model, total })).sort((a, b) => b.total - a.total).slice(0, 3),
    })).sort((a, b) => b.total - a.total),
    topSessions: sessionsOf(bySession).slice(0, 20),
  };
}

/** 全量（不受时间窗限制）的活动热力图：按数据跨度自适应周数，最少 8 周 */
export function buildHeatmap(cache, { weeks = 0, now = Date.now(), external = [] } = {}) {
  const dayTotals = new Map();
  let earliest = now;
  for (const rec of Object.values(cache.sessions)) {
    for (const it of rec.usages || []) {
      const d = dayKey(it.t);
      dayTotals.set(d, (dayTotals.get(d) || 0) + (it.u.totalTokens || 0));
      if (it.t < earliest) earliest = it.t;
    }
  }
  // 外部设备（网关）也要进热力图，否则热力图和总量口径不一致
  for (const g of external) {
    const d = dayKey(g.t);
    dayTotals.set(d, (dayTotals.get(d) || 0) + (g.u.totalTokens || 0));
    if (g.t < earliest) earliest = g.t;
  }
  // 以「今天」所在周的周一为最后一列
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: TZ }));
  const dow = (local.getDay() + 6) % 7; // 周一=0
  const spanWeeks = Math.ceil(((now - earliest) / 86400000 + dow + 1) / 7);
  const useWeeks = Math.max(13, Math.min(weeks || spanWeeks, 52));
  const startMs = now - (dow + (useWeeks - 1) * 7) * 86400000;
  const cells = [];
  for (let i = 0; i < useWeeks * 7; i += 1) {
    const ms = startMs + i * 86400000;
    if (ms > now) break;
    const d = dayKey(ms);
    cells.push({ day: d, weekday: i % 7, total: dayTotals.get(d) || 0 });
  }
  const max = cells.reduce((m, c) => Math.max(m, c.total), 0);
  return { weeks: useWeeks, cells, max };
}

export function fileHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** 时间窗定义（服务端与静态导出共用，避免口径漂移）。month 由前端按月切换，见 buildBundle
 *  yesterday 独立成窗：过了 0 点 today 会清零，昨天的数据需要一个能回去看的口子。 */
export const RANGE_KEYS = ['today', 'yesterday', '7d', '30d', 'all'];

export function rangeSince(key, now = Date.now()) {
  if (key === 'today') return Date.parse(`${dayKey(now)}T00:00:00+08:00`); // 上海无夏令时，固定 +08:00
  if (key === 'yesterday') return Date.parse(`${dayKey(now - 86400000)}T00:00:00+08:00`);
  if (key === '7d') return now - 7 * 86400000;
  if (key === '30d') return now - 30 * 86400000;
  return null;
}

/** 右边界（左闭右开）：只有「昨日」需要夹到今日 0 点 */
export function rangeUntil(key, now = Date.now()) {
  if (key === 'yesterday') return Date.parse(`${dayKey(now)}T00:00:00+08:00`);
  return null;
}

/** 'YYYY-MM' 在 Asia/Shanghai 下的起止毫秒（左闭右开） */
export function monthBounds(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const sinceMs = Date.parse(`${ym}-01T00:00:00+08:00`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const untilMs = Date.parse(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+08:00`);
  return { sinceMs, untilMs };
}

/** 当前月 'YYYY-MM'（按上海时区） */
export function currentMonth(now = Date.now()) {
  return dayKey(now).slice(0, 7);
}

/** 生成前端直接可用的完整数据包（/api/data 与静态导出完全同一份结构） */
export function buildBundle(cache, { now = Date.now(), withTitles = false, external = [], gatewayMeta = null } = {}) {
  const ranges = {};
  for (const key of RANGE_KEYS) {
    // 滚动窗口不掺归档：今日/昨日/7天/30天只算磁盘上还能验证的真实请求
    const includeLegacy = key === 'all';
    ranges[key] = buildStats(cache, { sinceMs: rangeSince(key, now), untilMs: rangeUntil(key, now), now, includeLegacy, external });
  }

  // 月度：导出时把「有数据的每个月」都算好，前端切月不用再请求。
  // 只保留最近 N 个月控制体积（每月一个汇总，但不必永远全带）。
  const MAX_MONTHS = 24;
  const months = {};
  const monthSet = new Set();
  for (const rec of Object.values(cache.sessions)) {
    for (const it of rec.usages || []) if (it.t <= now) monthSet.add(dayKey(it.t).slice(0, 7));
  }
  const thisMonth = currentMonth(now);
  monthSet.add(thisMonth);
  const ordered = [...monthSet].sort().slice(-MAX_MONTHS);
  for (const ym of ordered) {
    const b = monthBounds(ym);
    if (!b || b.sinceMs > now) continue;
    const s = buildStats(cache, { sinceMs: b.sinceMs, untilMs: b.untilMs, now, includeLegacy: true, external });
    // 月度只需总量/构成/趋势/模型，会话明细不参与月度视图，剔掉能省一大截体积
    delete s.topSessions;
    delete s.byClient;
    delete s.byProvider;
    delete s.byHour;
    months[ym] = s;
  }
  ranges.month = {
    // 默认展示当前月，形态与其它时间窗一致，前端只多两个翻页按钮
    availableMonths: Object.keys(months).sort(),
    currentMonth: thisMonth,
    months,
    ...(months[thisMonth] || buildStats(cache, { sinceMs: monthBounds(thisMonth).sinceMs, untilMs: monthBounds(thisMonth).untilMs, now, external })),
  };

  if (!withTitles) {
    for (const r of Object.values(ranges)) {
      for (const s of r.topSessions || []) {
        delete s.title;
        delete s.cwd;
      }
    }
  }
  return {
    generatedAt: now,
    timeZone: TZ,
    ranges,
    heatmap: buildHeatmap(cache, { now, external }),
    // 网关来源说明：设备名映射 + 参与统计的外部设备数（页面可选展示）
    gateway: gatewayMeta,
  };
}
