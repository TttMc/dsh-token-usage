// 静态导出：扫描 DSH 会话 → 累积历史库 → 生成单文件 dist/index.html（数据内联，可直接扔到任何静态托管）
//
// 为什么要独立历史库：DSH 的会话存档会被清理/归档，如果每次都只统计现存会话，
// 趋势图会随会话消失而塌陷。这里把每条 usage 按「会话ID + 事件序号」去重后永久累积，
// 之后即使原始会话文件被删，历史用量也还在。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scan, buildBundle, RANGE_KEYS } from './aggregate.mjs';
import { collectGateway, defaultUsageFile } from './gateway.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const DSH_HOME = arg('dsh-home', process.env.DSH_HOME || 'F:\\workspace\\DSH\\dsh-data');
const OUT = path.resolve(ROOT, arg('out', 'dist/index.html'));
const HISTORY = path.resolve(ROOT, arg('history', 'data/history.jsonl'));
const CACHE = path.resolve(ROOT, 'data/usage-cache.json');
const WITH_TITLES = flag('with-titles');
const PRUNE_DAYS = Number(arg('prune-days', 730));
const TZ_OFFSET = 8 * 3600 * 1000;

// 网关那一路：magpie 逐条记账的 usage.jsonl，只取「非本机」设备（Mac 等）。
// 独立历史库兜住 magpie 日志被轮转/重建的情况。
const GW_USAGE = arg('magpie-usage', process.env.MAGPIE_USAGE || defaultUsageFile());
const GW_HISTORY = path.resolve(ROOT, arg('gateway-history', 'data/gateway-history.jsonl'));
const GW_DEVICES = path.resolve(ROOT, arg('gateway-devices', 'gateway-devices.json'));
const NO_GATEWAY = flag('no-gateway');

/* ---------- 1. 扫描现存会话（增量） ---------- */
const t0 = Date.now();
const { cache, parsed, files } = scan({ dshHome: DSH_HOME, cacheFile: CACHE });

/* ---------- 2. 并入历史库 ---------- */
/** key = sessionId#seq，缺 seq 时退化为 sessionId#时间戳 */
function keyOf(sid, it) {
  return `${sid}#${it.seq != null ? it.seq : it.t}`;
}

const history = new Map();
if (fs.existsSync(HISTORY)) {
  for (const line of fs.readFileSync(HISTORY, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      history.set(`${r.sid}#${r.seq}`, r);
    } catch { /* 坏行跳过 */ }
  }
}
const historyBefore = history.size;

let added = 0;
const merged = { version: 1, sessions: {} };
for (const [file, rec] of Object.entries(cache.sessions)) {
  const sid = rec.id || path.basename(path.dirname(file));
  if (!merged.sessions[sid]) {
    merged.sessions[sid] = { id: sid, origin: rec.origin || 'user', title: rec.title || null, cwd: rec.cwd || null, usages: [] };
  }
  const target = merged.sessions[sid];
  for (const it of rec.usages || []) {
    // 先落历史库（永久）
    const k = keyOf(sid, it);
    const row = {
      sid, seq: it.seq != null ? String(it.seq) : String(it.t),
      t: it.t, p: it.provider, m: it.model, o: rec.origin || 'user',
      ti: rec.title || null, u: it.u,
    };
    if (!history.has(k)) { history.set(k, row); added += 1; }
    target.usages.push({ t: it.t, provider: it.provider, model: it.model, u: it.u, seq: it.seq });
  }
}

// 现存会话已覆盖的 key
const liveKeys = new Set();
for (const [file, rec] of Object.entries(cache.sessions)) {
  const sid = rec.id || path.basename(path.dirname(file));
  for (const it of rec.usages || []) liveKeys.add(keyOf(sid, it));
}

// 历史库里「原会话已消失」的部分也要计入统计
let revived = 0;
for (const [k, r] of history) {
  if (liveKeys.has(k)) continue;
  if (!merged.sessions[r.sid]) {
    merged.sessions[r.sid] = { id: r.sid, origin: r.o || 'user', title: r.ti || null, cwd: null, usages: [] };
  }
  merged.sessions[r.sid].usages.push({ t: r.t, provider: r.p, model: r.m, u: r.u });
  revived += 1;
}

/* ---------- 3. 历史库落盘（按天数裁剪，控制体积） ---------- */
const cutoff = Date.now() - PRUNE_DAYS * 86400000;
const kept = [...history.entries()].filter(([, r]) => r.t >= cutoff);
if (added || revived || kept.length !== history.size) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  const tmp = `${HISTORY}.tmp`;
  fs.writeFileSync(tmp, kept.map(([, r]) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, HISTORY);
}

/* ---------- 3.5 并入网关外部设备用量（Mac 等） ---------- */
let gw = { records: [], names: {}, locals: [], added: 0, total: 0, error: null };
if (!NO_GATEWAY) {
  try {
    gw = collectGateway({
      usageFile: GW_USAGE,
      historyFile: GW_HISTORY,
      devicesFile: GW_DEVICES,
      pruneDays: PRUNE_DAYS,
    });
  } catch (e) {
    gw.error = e && e.message ? e.message : String(e);
    console.log(`[gateway] 读取失败，本次按「无外部设备」导出：${gw.error}`);
  }
}

/* ---------- 4. 生成数据包 ---------- */
const bundle = buildBundle(merged, {
  withTitles: WITH_TITLES,
  external: gw.records,
  gatewayMeta: {
    devices: gw.names,
    externalDevices: [...new Set(gw.records.map((r) => r.device))],
    localIps: gw.locals || [],
    source: NO_GATEWAY ? null : GW_USAGE,
    historyRows: gw.total || 0,
    error: gw.error || null,
  },
});

// 数据指纹：只算「承载数据本身」的字段。
// 不能直接把 ranges 整个哈希进去——里面的 generatedAt / range.sinceMs 是时间戳，
// 每跑一次都不同，那样指纹永远在变，等于没有去重。
// 外部设备（网关）按天汇总后进指纹：Mac 那边有新增用量时也要算「变了」，
// 否则数据没变时会沿用旧时间戳，页面上的更新时刻会骗人。
const extDigest = (() => {
  const m = new Map();
  for (const g of gw.records) {
    const k = Math.floor(g.t / 86400000);
    const cur = m.get(k) || [0, 0];
    cur[0] += 1;
    cur[1] += g.u.totalTokens || 0;
    m.set(k, cur);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
})();

const fingerprint = createHash('sha256')
  .update(JSON.stringify({
    withTitles: WITH_TITLES,
    days: bundle.ranges.all.byDay.map((d) => [d.day, d.total, d.input, d.output, d.cacheRead, d.requests]),
    models: bundle.ranges.all.byModel.map((m) => [m.model, m.total, m.input, m.output, m.cacheRead, m.requests]),
    totals: [bundle.ranges.all.totals.total, bundle.ranges.all.totals.requests, bundle.ranges.all.totals.sessions],
    heat: bundle.heatmap.cells.map((c) => [c.day, c.total]),
    ext: extDigest,
  }))
  .digest('hex')
  .slice(0, 16);

// 数据没变就沿用上次的 generatedAt：让导出产物逐字节稳定，
// 否则每 30 分钟都会因为时间戳变化而产生一次无意义的提交。
const statePath = path.join(ROOT, 'data', 'export-state.json');
const prevState = fs.existsSync(statePath)
  ? (() => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } })()
  : null;
const dataChanged = !prevState || prevState.fingerprint !== fingerprint;
if (!dataChanged && prevState?.generatedAt) {
  // 整包沿用旧时间戳，保证导出产物逐字节稳定（页面上的「更新于」也不会假装刚刚更新过）
  bundle.generatedAt = prevState.generatedAt;
  for (const key of RANGE_KEYS) bundle.ranges[key].generatedAt = prevState.generatedAt;
  for (const key of ['7d', '30d']) {
    const r = bundle.ranges[key]?.range;
    if (r && prevState.sinceMs?.[key]) r.sinceMs = prevState.sinceMs[key];
  }
}

/* ---------- 5. 注入单文件 HTML ---------- */
const tpl = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const payload = JSON.stringify(bundle).replace(/<\//g, '<\\/'); // 防止标题里出现 </script>
const injected = tpl.replace(
  '<!--__DSH_USAGE_DATA__-->',
  `<script>window.__DSH_USAGE__=${payload};</script>`,
);
if (injected === tpl) throw new Error('模板里找不到 <!--__DSH_USAGE_DATA__--> 占位符，导出未生效');

/* ---------- 6. 记录导出状态 ---------- */
const exportState = {
  fingerprint,
  generatedAt: bundle.generatedAt,
  sinceMs: {
    '7d': bundle.ranges['7d']?.range?.sinceMs ?? null,
    '30d': bundle.ranges['30d']?.range?.sinceMs ?? null,
  },
  total: bundle.ranges.all.totals.total,
  requests: bundle.ranges.all.totals.requests,
  sessions: bundle.ranges.all.totals.sessions,
  gateway: {
    usageFile: GW_USAGE,
    historyRows: gw.total || 0,
    added: gw.added || 0,
    devices: bundle.ranges.all.byDevice.map((d) => ({ device: d.device, ip: d.ip, total: d.total, requests: d.requests })),
    error: gw.error || null,
  },
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(statePath, JSON.stringify(exportState, null, 2));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, injected);

// 图标与 PWA manifest 也复制到 dist：静态托管上它们是相对路径引用，缺了会 404（浏览器标签图标、添加到主屏都受影响）
const DIST_DIR = path.dirname(OUT);
for (const name of ['icon.svg', 'manifest.webmanifest']) {
  const src = path.join(ROOT, 'web', name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST_DIR, name));
}

/* ---------- 7. 报告 ---------- */
const all = bundle.ranges.all.totals;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log([
  `数据源    ${path.join(DSH_HOME, 'sessions')}`,
  `会话文件  ${files} 个（本次重新解析 ${parsed} 个）`,
  `历史库    ${historyBefore} → ${history.size} 条（新增 ${added}，会话已删但保留 ${revived}）`,
  NO_GATEWAY
    ? '外部设备  已禁用（--no-gateway）'
    : `外部设备  ${bundle.ranges.all.byDevice.map((d) => `${d.device}/${d.ip}`).join('、') || '无'}`
      + `（网关历史 ${gw.total || 0} 条，本次新增 ${gw.added || 0}${gw.error ? `，读取失败：${gw.error}` : ''}）`,
  `总消耗    ${all.total.toLocaleString()} Token / ${all.requests} 次请求 / ${all.sessions} 个会话`,
  `数据指纹  ${fingerprint}${dataChanged ? '（有变化）' : '（未变，沿用上次时间戳）'}`,
  `时间窗    ${RANGE_KEYS.join(' / ')}`,
  `热力图    ${bundle.heatmap.weeks} 周 × 7 天`,
  `输出      ${OUT}（${kb(injected.length)}）`,
  `耗时      ${Date.now() - t0} ms`,
].join('\n'));
