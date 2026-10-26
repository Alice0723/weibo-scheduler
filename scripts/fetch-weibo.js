/**
 * 微博动态抓取（直连 m.weibo.cn）
 *
 * 输出：data/raw-weibo.json（原始动态，供后续 LLM 抽取）
 *
 * 三个源账号：
 *   @汪苏泷            1004061625646585  本人主号
 *   @汪苏泷Studio      5523180767        工作室官方（演唱会官宣主力）
 *   @SilenceRadio0917  走自定义域名解析    官方对接号
 *
 * ⚠️ 为什么直连而不用 RSSHub：
 *   RSSHub 的微博路由本质就是两个 m.weibo.cn JSON 请求，
 *   为了这两个请求去起 Docker + Chromium + Redis 不划算（内存 2G 起不来、
 *   拉镜像慢、还得配 Redis 容器）。这里直接复刻它的请求逻辑：
 *     1) GET container/getIndex?type=uid&value=<uid>  → 拿 containerid + 账号名
 *     2) GET container/getIndex?type=uid&value=<uid>&containerid=<cid> → 拿卡片列表
 *   Cookie 必须带 SUB（登录态），匿名访问一律 432。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'raw-weibo.json');

// ===== 源账号 =====
// uid 可以是数字 UID，也可以是自定义域名（会被自动解析成数字 UID）。
const SOURCES = [
  { key: 'wangsulong', name: '汪苏泷', uid: '1004061625646585' },
  { key: 'studio', name: '汪苏泷Studio', uid: '5523180767' },
  { key: 'radio', name: 'SilenceRadio0917', uid: 'SilenceRadio0917' }
];

// 环境变量可覆盖（用于换号调试）
const RADIO_UID = process.env.WEIBO_RADIO_UID || '';

const API_BASE = (process.env.WEIBO_API_BASE || 'https://m.weibo.cn/api/container/getIndex').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.WEIBO_TIMEOUT || 20000);
const RETRIES = Number(process.env.WEIBO_RETRIES || 3);
// 每个账号最多翻几页（每页约 10-20 条）
const MAX_PAGES = Number(process.env.WEIBO_MAX_PAGES || 4);
const MAX_ITEMS_PER_SOURCE = Number(process.env.MAX_ITEMS_PER_SOURCE || 60);

const WEIBO_COOKIE = require('./cookie-utils').loadCookie(ROOT);

// 微博移动端接口要求的请求头（照抄 RSSHub 的 apiHeaders）
const API_HEADERS = {
  'MWeibo-Pwa': '1',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1'
};

function log(...args) {
  console.log('[fetch-weibo]', ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 调 m.weibo.cn 接口
 * @returns {object} 解析后的 JSON
 * @throws 带上可读的错误信息（区分「Cookie 失效」「被限流」「网络不通」）
 */
async function apiGet(params, refererUid) {
  const qs = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const url = `${API_BASE}?${qs}`;

  let lastErr = null;
  for (let i = 0; i < RETRIES; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...API_HEADERS,
          Referer: `https://m.weibo.cn/u/${refererUid}`,
          ...(WEIBO_COOKIE ? { Cookie: WEIBO_COOKIE } : {})
        }
      });
      clearTimeout(timer);

      if (resp.status === 432) {
        // 微博的「需要登录/被风控」响应
        lastErr = new Error('HTTP 432 —— 微博要求登录态，Cookie 可能已失效或缺少 SUB');
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        await sleep(1500 * (i + 1));
        continue;
      }

      const text = await resp.text();
      if (!text || !text.trim()) {
        lastErr = new Error('empty body');
        await sleep(1500 * (i + 1));
        continue;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        lastErr = new Error('返回的不是 JSON（可能被跳转到了登录页）');
        await sleep(1500 * (i + 1));
        continue;
      }

      // ok === -100 是微博的「Cookie 失效/需要重新登录」
      if (json && json.ok === -100) {
        lastErr = new Error('微博返回 ok=-100 —— Cookie 已过期，请重新复制一份');
        // 这类错误重试没用，直接抛出
        throw lastErr;
      }
      if (json && json.ok === 0) {
        // 没有内容（比如 uid 写错）
        lastErr = new Error('微博返回 ok=0 —— 没有取到内容，可能是 uid 有误');
        throw lastErr;
      }

      return json;
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.name === 'AbortError') ? new Error('timeout') : e;
      // 上面主动抛出的业务错误不要再重试
      if (e && /Cookie 已过期|uid 有误/.test(e.message || '')) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr || new Error('unknown error');
}

/** 把微博正文里的 HTML 标签与实体清掉 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把微博的 created_at（形如 "10月26日 12:30" / "今天 12:30" / "刚刚"）转成时间戳
 * 微博只给「月日 时分」，年份要靠推断：超过当前月份的一律认为是去年。
 */
function parseWeiboTime(createdAt) {
  const raw = String(createdAt || '').trim();
  if (!raw) return 0;

  // 已经是完整 ISO / 带年份
  const isoMatch = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (isoMatch) {
    return new Date(
      Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]),
      Number(isoMatch[4]), Number(isoMatch[5])
    ).getTime();
  }

  const now = new Date();
  const year = now.getFullYear();

  // 形如 "10月26日 12:30" 或 "10-26 12:30"
  let m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) m = raw.match(/(\d{1,2})-(\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const h = m[3] != null ? Number(m[3]) : 0;
    const mi = m[4] != null ? Number(m[4]) : 0;
    let ts = new Date(year, mo - 1, d, h, mi).getTime();
    // 月份比当前还大 → 去年发的（微博时间线不会给未来时间）
    if (mo > now.getMonth() + 1 + 1) ts = new Date(year - 1, mo - 1, d, h, mi).getTime();
    return ts;
  }

  // "今天 12:30" / "昨天 12:30" / "刚刚" / "5分钟前"
  const hm = raw.match(/(\d{1,2}):(\d{2})/);
  if (/刚刚/.test(raw)) return Date.now();
  if (/分钟前/.test(raw)) {
    const mm = raw.match(/(\d+)\s*分钟前/);
    return Date.now() - (Number(mm ? mm[1] : 1)) * 60 * 1000;
  }
  if (/小时前/.test(raw)) {
    const hh = raw.match(/(\d+)\s*小时前/);
    return Date.now() - (Number(hh ? hh[1] : 1)) * 3600 * 1000;
  }
  if (/今天/.test(raw) && hm) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hm[1]), Number(hm[2])).getTime();
  }
  if (/昨天/.test(raw) && hm) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, Number(hm[1]), Number(hm[2])).getTime();
  }

  return 0;
}

/**
 * 把 mblog 卡片转成我们自己的条目
 */
function normalizeCard(card, source) {
  const mblog = card && card.mblog ? card.mblog : null;
  if (!mblog) return null;

  const content = stripHtml(mblog.text || mblog.longText && mblog.longText.longTextContent || '');
  // ⚠️ 占位/空正文直接丢弃，绝不回退到 title（「XX的微博」这种占位标题）
  if (!content || content.length < 4) return null;

  const ts = parseWeiboTime(mblog.created_at);
  const bid = mblog.bid || '';
  const link = bid
    ? `https://m.weibo.cn/detail/${bid}`
    : (mblog.id ? `https://m.weibo.cn/detail/${mblog.id}` : '');

  return {
    source: source.key,
    sourceName: source.name,
    uid: source.uid,
    title: source.name,
    content,
    link,
    published: ts > 0 ? new Date(ts).toISOString() : '',
    pubTs: ts
  };
}

/**
 * 第一步：把账号标识解析成「数字 UID + 真实昵称 + containerid」
 *
 * ⚠️ 标识可以是数字 UID，也可以是自定义域名（如 SilenceRadio0917）。
 * 微博的 container/getIndex?type=uid&value=xxx 里 value 必须是数字，
 * 所以自定义域名要先用 containerid=100505{标识} 换成数字 UID。
 */
async function resolveAccount(source) {
  let numericUid = '';
  let screenName = '';

  // 尝试 A：containerid=100505{标识} —— 数字 UID 和自定义域名都吃这一套
  try {
    const json = await apiGet({ containerid: `100505${source.uid}` }, source.uid);
    const info = json && json.data ? json.data.userInfo : null;
    if (info && info.id) {
      numericUid = String(info.id);
      screenName = info.screen_name || '';
    }
  } catch (e) {
    // 解析失败不致命：下面还有兜底
  }

  // 尝试 B：标识本身就是数字 UID 时，直接用 type=uid 拿 containerid
  if (!numericUid && /^\d+$/.test(source.uid)) {
    numericUid = source.uid;
  }

  if (!numericUid) {
    throw new Error(`无法把「${source.uid}」解析成数字 UID —— 请在仓库 Secrets 里配置 WEIBO_RADIO_UID`);
  }

  // 拿 containerid（拿不到就用默认的 107603{数字uid}）
  let containerId = '';
  try {
    const json = await apiGet({ type: 'uid', value: numericUid }, numericUid);
    const data = json && json.data ? json.data : {};
    if (data.userInfo && data.userInfo.screen_name && !screenName) {
      screenName = data.userInfo.screen_name;
    }
    if (data.tabsInfo && Array.isArray(data.tabsInfo.tabs)) {
      const tab = data.tabsInfo.tabs.find((t) => t.tab_type === 'weibo');
      if (tab && tab.containerid) containerId = String(tab.containerid);
    }
  } catch (e) {
    // 拿不到就用默认值继续
  }
  if (!containerId) containerId = `107603${numericUid}`;

  return { numericUid, screenName, containerId };
}

/** 第二步请求：翻页拿卡片 */
async function fetchSource(source) {
  const acc = await resolveAccount(source);
  const realName = acc.screenName || source.name;
  const uid = acc.numericUid;
  log(`拉取 ${realName} (${uid}) containerid=${acc.containerId} ...`);

  const out = [];
  const seen = new Set();
  let sinceId = '';
  let pages = 0;

  while (pages < MAX_PAGES) {
    const params = { type: 'uid', value: uid, containerid: acc.containerId };
    if (sinceId) params.since_id = sinceId;

    const json = await apiGet(params, uid);
    const data = json && json.data ? json.data : {};
    const cards = data.cards || (data.data && data.data.cards) || [];

    let got = 0;
    for (const card of cards) {
      const item = normalizeCard(card, { ...source, name: realName, uid });
      if (!item) continue;
      const k = item.link || `${item.source}:${item.pubTs}:${item.content.slice(0, 100)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
      got++;
    }

    pages++;
    const nextSince = data.since_id || (data.data && data.data.since_id) || '';
    if (!nextSince || nextSince === sinceId) break;   // 没有游标 = 到底了
    sinceId = nextSince;
    if (got === 0) break;                              // 这一页没内容也停
    await sleep(1200);                                 // 别把微博打爆
  }

  out.sort((a, b) => b.pubTs - a.pubTs);
  const capped = out.slice(0, MAX_ITEMS_PER_SOURCE);
  log(`  ${realName}: 抓到 ${capped.length} 条`);
  return capped;
}

async function main() {
  if (!WEIBO_COOKIE) {
    log('⚠️ 没有 Cookie —— 微博会返回 432，抓不到任何内容。');
    log('   本地试跑：node scripts/try-local.js（会一步步教你怎么做）');
    log('   GitHub 上跑：在仓库 Settings → Secrets and variables → Actions 里添加 WEIBO_COOKIE。');
  } else if (!require('./cookie-utils').hasSub(WEIBO_COOKIE)) {
    log('⚠️ Cookie 里没有 SUB —— 微博几乎一定返回 432。');
    log('   微博把 SUB 设成了 HttpOnly，只能从 DevTools 的「网络 → 请求标头」里复制。');
    log('   ⚠️ 别点成「预检」请求（OPTIONS），预检不带 Cookie。');
  }

  const sources = SOURCES.map((s) =>
    (s.key === 'radio' && RADIO_UID) ? { ...s, uid: RADIO_UID } : s
  );

  const all = [];
  for (const s of sources) {
    try {
      const items = await fetchSource(s);
      all.push(...items);
    } catch (e) {
      // 单个源失败不影响其它源
      log(`  ${s.name}: 失败 — ${e && e.message ? e.message : e}`);
    }
    await sleep(800);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 保留历史：某次抓取失败不该让旧日程全丢
  let previous = [];
  try {
    if (fs.existsSync(OUT_FILE)) {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      previous = Array.isArray(prev.items) ? prev.items : [];
    }
  } catch (e) {
    log('旧数据解析失败，将只用新数据');
  }

  const byKey = new Map();
  for (const it of previous) {
    const k = it.link || `${it.source}:${it.pubTs}:${String(it.content).slice(0, 80)}`;
    byKey.set(k, it);
  }
  for (const it of all) {
    const k = it.link || `${it.source}:${it.pubTs}:${String(it.content).slice(0, 80)}`;
    byKey.set(k, it);
  }
  const merged = Array.from(byKey.values())
    .sort((a, b) => b.pubTs - a.pubTs)
    .slice(0, 500);

  const payload = {
    updatedAt: new Date().toISOString(),
    updatedAtTs: Date.now(),
    sources: sources.map((s) => ({ key: s.key, name: s.name, uid: s.uid })),
    count: merged.length,
    freshCount: all.length,
    items: merged
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  log(`已写入 ${OUT_FILE}：共 ${merged.length} 条（本次新抓 ${all.length} 条）`);

  if (all.length === 0) {
    log('❌ 本次一条都没抓到 —— 多半是 Cookie 过期，或还没配 Cookie。');
    log('   已保留历史数据，流水线会标记失败并提醒你。');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('[fetch-weibo] fatal:', e);
  process.exit(1);
});
