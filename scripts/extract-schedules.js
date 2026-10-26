/**
 * 微博动态 → 结构化日历条目（LLM 抽取）
 *
 * 输入：data/raw-weibo.json
 * 输出：data/weibo-schedules.json
 *
 * 关键设计（防误判，由真实反馈驱动）：
 *   1. 微博正文里大量是「往年旧内容」「歌单盘点」「日常闲聊」→ 必须严格过滤，
 *      只保留「有明确未来日期的日程类信息」。
 *   2. 演唱会常常是「11月13日-15日」多场连演 → 必须输出 start/end 区间，不能拆条。
 *   3. 相对日期（「明日12:00」「今晚8点」）→ 以微博发布时间为基准换算成绝对日期。
 *   4. 「预约/预售/开票」和「演出当天」是两个不同事件 → 分成 ticket 与 concert 两条。
 *   5. LLM 会编造 → 抽取后必须做程序化校验（日期必须合法且在未来、字段不能空）。
 *      校验不过的直接丢弃，宁缺毋滥。
 *
 * ── LLM 通道（自动选择，优先级从高到低）──
 *   ① LLM_API_KEY 有值 → 用自带的 OpenAI 兼容接口（DeepSeek / 通义 / 智谱 等）
 *      LLM_BASE_URL 默认 https://api.deepseek.com/v1
 *      LLM_MODEL    默认 deepseek-chat
 *   ② 否则 GITHUB_TOKEN 有值 → 用 GitHub Models（免费，用仓库自带的 token）
 *      端点 https://models.github.ai/inference，模型 openai/gpt-4o-mini
 *      需在 workflow 里加 permissions: models: read
 *   ③ 都没有 → 报错退出（不会写出空文件覆盖旧数据）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT, 'data', 'raw-weibo.json');
const OUT_FILE = path.join(ROOT, 'data', 'weibo-schedules.json');

// ===== LLM 通道选择 =====
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();

let LLM_BASE_URL;
let LLM_MODEL;
let LLM_TOKEN;
let LLM_MAX_TOKENS = 4000;
// 每批的字符预算（不同通道的输入上限不一样，见下方注释）
let CHAR_BUDGET = 12000;

if (LLM_API_KEY) {
  LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
  LLM_TOKEN = LLM_API_KEY;
  // DeepSeek 上下文很大，但 max_tokens 4000 已经够抽 15 条
  CHAR_BUDGET = Number(process.env.LLM_CHAR_BUDGET || 12000);
} else if (GITHUB_TOKEN) {
  LLM_BASE_URL = 'https://models.github.ai/inference';
  LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o-mini';
  LLM_TOKEN = GITHUB_TOKEN;
  // ⚠️ GitHub Models 免费层每次请求输入上限 8000 token（中文约 1.5 字/token）
  //    提示词本身占 ~1200 token，留给正文的预算必须压到 ~4500 字
  CHAR_BUDGET = Number(process.env.LLM_CHAR_BUDGET || 4500);
  LLM_MAX_TOKENS = 3000;
} else {
  LLM_BASE_URL = '';
  LLM_MODEL = '';
  LLM_TOKEN = '';
  CHAR_BUDGET = 12000;
}

const LLM_TIMEOUT = Number(process.env.LLM_TIMEOUT || 120000);
const BATCH_SIZE = Number(process.env.LLM_BATCH_SIZE || 15);   // 每批最多几条
const MAX_POSTS = Number(process.env.MAX_POSTS || 200);       // 最多处理多少条（控成本）

// ===== 现有日历的类型（必须与 index.js 的 TYPE_CONFIG 对齐）=====
const ALLOWED_TYPES = [
  'concert',   // 演唱会/音乐节演出
  'ticket',    // 抢票/预售
  'flash',     // 快闪
  'xr',        // XR 电影
  'merch',     // 周边发售
  'song',      // 新歌上线
  'mv',        // MV 首发
  'behind',    // 花絮/幕后
  'musician',  // 合作音乐家
  'birthday'   // 生日
];

function log(...args) {
  console.log('[extract-schedules]', ...args);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// 提示词
// ⚠️ 用数组拼接而不是模板字符串：提示词里含大量 { } " " 引号，
// 模板字符串会被里面的 " 提前闭合，脚本报 Unexpected identifier。
const SYSTEM_PROMPT = [
  '你是汪苏泷粉丝小站的日程数据编辑。你的任务：从「微博动态原文」中抽取**日程类**信息，输出结构化 JSON。',
  '',
  '可用 type（只能用这些值）：',
  'concert 演唱会/音乐节演出当天 | ticket 抢票/门票预售/开票 | flash 快闪活动',
  'xr XR电影/线上放映 | merch 周边发售/开售 | song 新歌上线/发行 | mv MV首发',
  'behind 花絮/幕后/花絮视频 | musician 合作音乐家/feat. | birthday 生日',
  '',
  '严格的抽取规则：',
  '1. **只抽真正的「日程」**。以下一律不要抽：日常闲聊、粉丝互动、转发抽奖、往年旧活动的复盘、歌词感慨、图片分享、专辑销量战报、公益广告、代言广告、已经过去很久的活动回顾。',
  '2. **必须是未来或有明确日期的事件**。如果一条微博讲的是过去的活动（今年年初、上个月、去年），不要抽。',
  '3. **日期必须是绝对日期**。若原文只有相对表述（明日、后天、今晚、下周五），按该微博的 published 时间换算成 YYYY-MM-DD。',
  '4. **演唱会多场连演**（如「11月13日-15日」「13/14/15 三场」）：输出成 date/endDate 区间，type=concert；**不要拆成三条**。同时如果提到了开票/预售时间，**另外**输出一条 type=ticket。',
  '5. **一个事件一条记录**。name 用简洁中文短语（如「明日世界巡回演唱会 福州站」「《联名2》新专辑发行」），不要把整段原文塞进 name。',
  '6. **不要编造**。原文没写的信息留空，不要推测城市、场馆、票务平台。',
  '7. 如果原文有明确的场馆/城市，放进 location 字段；没有就留空字符串。',
  '8. 如果原文提到具体歌曲名，放进 songs 字段（数组）；没有就空数组。',
  '9. type 拿不准时，选语义最接近的一个，不要留空。',
  '',
  '输出格式（严格 JSON，不要 markdown 代码块，不要任何解释文字）：',
  '{"items":[{"date":"YYYY-MM-DD","endDate":"","name":"事件名","type":"concert","location":"","songs":[],"confidence":0.9,"reason":"一句话说明依据"}]}',
  '',
  '若无任何可抽取内容，输出 {"items":[]}。',
  'confidence 取 0~1 的小数，表示你对这条抽取的把握。',
  'reason 用中文简述你从原文里看到了什么日期依据。',
  'date 为空表示未知日期，这种情况通常应直接不输出。',
  'endDate 仅在确有多日区间时填写，否则留空字符串。',
  'date 和 endDate 必须是真实存在的日历日期。',
  'endDate 若填写则不得早于 date。',
  'items 里的 date 字段必填且非空。'
].join('\n');

function buildUserPrompt(posts) {
  const lines = posts.map((p, i) => {
    const d = p.published ? p.published.replace('T', ' ').slice(0, 16) : '未知时间';
    return `[${i + 1}] 发布于 ${d}（账号：${p.sourceName}）\n${p.content}`;
  });
  return `以下是 ${posts.length} 条微博动态，请抽取其中的日程信息。\n\n${lines.join('\n\n')}`;
}

// ============================================================
// 调 LLM
// ============================================================
async function callLLM(posts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT);
  try {
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_TOKEN}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.1,
        max_tokens: LLM_MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(posts) }
        ]
      })
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status} ${body.slice(0, 300)}`);
    }
    const json = await resp.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content : '';
    if (!content) throw new Error('LLM 返回空内容');

    // 去掉可能的 markdown 代码块
    const cleaned = String(content).replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('LLM 超时');
    throw e;
  }
}

/**
 * 分批：既受条数上限，也受字符预算约束
 * GitHub Models 免费层输入上限 8000 token，提示词占掉一大截，
 * 正文太多会直接 400 —— 所以必须按字符数切批，不能只按条数。
 */
function makeBatches(candidates) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const p of candidates) {
    const len = (p.content || '').length + 60;   // 60 是前缀开销
    if (cur.length >= BATCH_SIZE || (cur.length > 0 && curChars + len > CHAR_BUDGET)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(p);
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ============================================================
// 校验（防 LLM 编造 —— 这一步不能省）
// ============================================================
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  // 反查：防止 2026-02-30 这类溢出日期
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 把 YYYY-MM-DD 转成当天 00:00 的时间戳 */
function dateToTs(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function validateItem(item, opts) {
  const now = opts.now;
  const maxFutureDays = opts.maxFutureDays;

  if (!item || typeof item !== 'object') return null;

  const date = String(item.date || '').trim();
  if (!isValidDateStr(date)) return null;

  const endDate = String(item.endDate || '').trim();
  if (endDate && !isValidDateStr(endDate)) return null;

  const startTs = dateToTs(date);
  const endTs = endDate ? dateToTs(endDate) : startTs;
  if (endTs < startTs) return null;

  // 过去的事件一律丢弃（允许 1 天宽限，避免时区导致的当天误杀）
  if (startTs < now - 24 * 3600 * 1000) return null;

  // 太远的未来也不信（一年后的多半是抽错了）
  if (startTs > now + maxFutureDays * 24 * 3600 * 1000) return null;

  const name = String(item.name || '').trim();
  if (!name || name.length > 60) return null;

  const type = String(item.type || '').trim();
  if (ALLOWED_TYPES.indexOf(type) === -1) return null;

  const conf = Number(item.confidence);
  const confidence = isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;

  // 置信度太低的不收 —— 宁可漏也不要污染日历
  if (confidence < 0.55) return null;

  return {
    date,
    endDate: endDate || '',
    name,
    type,
    location: String(item.location || '').trim().slice(0, 60),
    songs: Array.isArray(item.songs)
      ? item.songs.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 10)
      : [],
    confidence,
    reason: String(item.reason || '').trim().slice(0, 120),
    sourceUrl: opts.sourceUrl || '',
    sourceName: opts.sourceName || '',
    sourcePubTs: opts.sourcePubTs || 0,
    extractedAt: Date.now()
  };
}

/** 用正文关键词做二次过滤：明显不是日程的一律丢 */
const NON_SCHEDULE_HINTS = [
  '抽奖', '转发', '点赞', '评论区', '打卡', '应援', '生日会', '直播回放',
  '销量', '打榜', '冲榜', '公益', '代言', '广告', '课程', '直播答题',
  '抢先听', '回顾', '盘点', '合辑', '重温', '答谢', '高光', '混剪'
];
// 出现这些词不代表一定是日程，只在「没有日期线索」时用来兜底剔除
function looksLikeSchedule(text) {
  const t = String(text || '');
  if (!t) return false;

  // ⚠️ 噪音词优先判断（2026-10-26 修正）：
  // 「直播回放已上线，点击观看…」含「上线/放映」这类动作词，会被误判成日程，
  // 但它讲的是已经发生的事。必须先排噪音，再找日期线索。
  if (NON_SCHEDULE_HINTS.some((h) => t.includes(h))) return false;

  // 日期/动作线索：明确说了「什么时候发生什么」
  const hasDateClue = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{1,2}\/\d{1,2}|开售|开票|预售|上线|发行|首播|放映|演出|官宣/.test(t);
  return hasDateClue;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  if (!LLM_TOKEN) {
    log('❌ 没有可用的 LLM 通道。');
    log('   请配置其中之一：');
    log('     · Secret LLM_API_KEY（自带的 DeepSeek 等 OpenAI 兼容接口）');
    log('     · 或让 workflow 带上 GITHUB_TOKEN（免费走 GitHub Models）');
    process.exit(1);
  }
  log(`LLM 通道：${LLM_BASE_URL} / ${LLM_MODEL}`);

  if (!fs.existsSync(RAW_FILE)) {
    log(`❌ 找不到 ${RAW_FILE}，请先跑 fetch-weibo.js`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const allItems = Array.isArray(raw.items) ? raw.items : [];
  log(`读到 ${allItems.length} 条原始动态`);

  // 只处理有正文、看起来像日程的，减少 LLM 成本
  const candidates = allItems
    .filter((it) => it && it.content && it.content.length > 10)
    .filter((it) => looksLikeSchedule(it.content))
    .slice(0, MAX_POSTS);

  log(`初筛出 ${candidates.length} 条候选（含日期线索或不含明显噪音词）`);

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const maxFutureDays = 400;

  if (candidates.length === 0) {
    log('没有候选，跳过 LLM 调用');
    writeOutput([], raw);
    return;
  }

  const batches = makeBatches(candidates);
  log(`分成 ${batches.length} 批（每批最多 ${BATCH_SIZE} 条 / ${CHAR_BUDGET} 字）`);

  const results = [];
  let failedBatches = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const idx = `批次 ${i + 1}/${batches.length}`;

    try {
      const items = await callLLM(batch);
      let kept = 0;
      items.forEach((it) => {
        const v = validateItem(it, {
          now: now.getTime(),
          maxFutureDays
        });
        if (v) { results.push(v); kept++; }
      });
      log(`${idx}: LLM 返回 ${items.length} 条，校验通过 ${kept} 条`);
    } catch (e) {
      failedBatches++;
      log(`${idx}: LLM 调用失败 — ${e && e.message ? e.message : e}（跳过这批）`);
    }

    if (i + 1 < batches.length) await sleep(1500); // 限流，别把 API 打爆
  }

  // 同一条日程可能被多次抽到（不同微博提到同一件事）→ 按 type+date+name 去重
  const seen = new Map();
  for (const it of results) {
    const k = `${it.type}|${it.date}|${it.name.replace(/\s/g, '')}`;
    const prev = seen.get(k);
    if (!prev || it.confidence > prev.confidence) seen.set(k, it);
  }
  const dedup = Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));

  log(`最终抽出 ${dedup.length} 条日程（原始 ${results.length} 条，去重后）`);

  writeOutput(dedup, raw, failedBatches);

  if (failedBatches > 0 && dedup.length === 0) {
    log('❌ 全部批次都失败了，检查 LLM 配置。');
    process.exitCode = 2;
  }
}

function writeOutput(items, raw, failedBatches) {
  const payload = {
    updatedAt: new Date().toISOString(),
    updatedAtTs: Date.now(),
    count: items.length,
    rawUpdatedAt: raw && raw.updatedAt ? raw.updatedAt : '',
    failedBatches: failedBatches || 0,
    items
  };
  if (!fs.existsSync(path.dirname(OUT_FILE))) fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  log(`已写入 ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('[extract-schedules] fatal:', e);
  process.exit(1);
});
