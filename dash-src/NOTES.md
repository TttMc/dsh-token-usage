# 合并侧（company 机器）改造要点

家这台（home）每 30 分钟把本机快照推到 `TttMc/dsh-token-usage` 的 **main** 分支，数据内联在
`index.html` 的 `window.__DSH_USAGE__` 里。company 那台负责：拉 main 快照 → 与本地快照合并 →
推 `merged` 分支 → GitHub Pages 发布（Pages source = merged /）。

**2026-11-15 home 侧新增两项，company 侧要跟进，否则公网看不到：**

1. 新增时间窗 **`yesterday`**（过了 0 点「今日」清零，昨天的数据需要能回看）
2. 新增维度 **`byDevice`**：经 home 的 magpie 网关访问模型的其它设备（当前是 MacBook，
   走 `192.168.1.2` → home 网关 `[::]:3425`）。home 的每个 range 里 `totals` **已经包含**
   这批外部设备的 Token，`byDevice` 只是拆分展示，**不要再加一遍**。

参考实现（本仓库 `dash-src/` 下，与本机代码同源）：

- `dash-src/aggregate.mjs` — `RANGE_KEYS` / `rangeSince` / `rangeUntil` / `buildStats(…, external)` / `byDevice`
- `dash-src/gateway.mjs` — 网关采集与「剔除本机 IP」的去重逻辑
- `dash-src/web-index.html` — 页面模板（昨日页签 + 其他设备卡片）

## 1. 时间窗契约

```
RANGE_KEYS = ['today','yesterday','7d','30d','all']   // 顺序即页签顺序；month 另算
rangeSince('yesterday', now) = 昨日 00:00 (+08:00)
rangeUntil('yesterday', now) = 今日 00:00 (+08:00)     // 左闭右开，必须夹右边界
其它窗口 rangeUntil = null
includeLegacy：只有 all 与 month 为 true，滚动窗口（含 yesterday）为 false
```

合并时按时间窗逐个相加即可；`yesterday` 需要先在各自数据上按上面的边界切出来，再相加。

## 2. byDevice 契约

每个 range（含 month 下的每个月）带一个数组：

```json
{ "device": "MacBook", "ip": "192.168.1.2",
  "input": 999671, "output": 46030, "cacheRead": 6796544, "cacheWrite": 0,
  "total": 7842245, "requests": 67, "cacheHitRate": 0.8717748291959624,
  "first": 1794677044441, "last": 1794679102246,
  "models": [{ "model": "DeepSeek V4.1 Flash", "total": 7841806 }] }
```

合并规则：按 `device` 键并（不是按 ip，IP 会因 DHCP 变）：

- 数值字段相加：input/output/cacheRead/cacheWrite/total/requests
- `first` 取 min，`last` 取 max，`ip` 取 last 对应的那个
- `models` 按 model 名相加后排序
- `cacheHitRate` 重算 = cacheRead / (cacheRead + input)

另外：

- `totals.sessions` **不含**外部设备（外部设备不是会话），别把设备数加进会话数
- `byDay` / `byModel` / `byProvider` / heatmap 已包含外部设备；两边合并时按 day / model 键相加即可
- 顶层 `bundle.gateway` 是来源说明（`externalDevices`、`localIps`、`source`），页面只用来显示一行脚注

## 3. 渲染改动（web/index.html）

1. 页签顺序：`今日 / 昨日 / 7 天 / 30 天 / 月度 / 全部`，`data-range="yesterday"`
2. `rangeLabel` 增加 `yesterday: '昨日'`
3. 主指标 `hero-note` 追加：` · 含外部设备 <shortT>`（有 byDevice 时）
4. 卡片顺序末尾（模型占比之后）加「其他设备」卡片：复用 `.rk` 排行样式，
   每台设备一行 = 设备名 + `IP · N 次请求 · 缓存 X%` + 最近活跃时间 + Token 占比条；
   该时间窗内没有外部设备时整块不渲染
5. 页脚：`外部设备 <名单> 经本机网关接入`
6. 单日窗口（今日/昨日）只有一个数据点：折线画不出来，脉冲面板改画一个点、X 轴只标一个居中日期

## 4. 验收

- 点「昨日」：标题为「昨日 累计消耗」，数字 ≠ 今日，跨过 0 点后今天不归零
- 「全部」与「30 天」里能看到「其他设备 / MacBook」卡片，Token 与 home 那份 `byDevice` 对得上
- 模型占比、每日趋势、热力图的合计与「累计消耗」一致（含外部设备）
- `merged` 分支推上去后公网首页出现 6 个页签