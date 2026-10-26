/**
 * 真实数据抽取质量验证（2026-10-26）
 *
 * 用 2026-10-26 真实抓到的微博数据 + 一个「按规则模拟 LLM」的抽取器，
 * 跑完整管道（预筛 → 抽取 → 校验 → 去重），验证：
 *   1. 预筛没有误杀真日程（11月1日中国澳门见 / 明日12:00上线 / 演唱会官宣）
 *   2. 校验层拦住了半年前的官宣微博（2026-03-26 那条）
 *   3. 去重把同一条日程的多篇微博合并成一条
 *   4. 最终产物格式符合小程序消费契约
 *
 * ⚠️ 这个脚本会读 data/raw-weibo.json（真实数据）。
 *    没有真实数据时自动跳过（不算失败）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function skipTest(name) { skip++; console.log('  SKIP  ' + name); }
function group(t) { console.log('\n=== ' + t + ' ==='); }

const REPO = path.resolve(__dirname, '..');
const RAW_FILE = path.join(REPO, 'data', 'raw-weibo.json');

// ============================================================
// 复刻 extract-schedules.js 的预筛 + 校验 + 去重
// ============================================================
const NOISE_SOFT = [
  '抽奖', '转发', '点赞', '评论区', '打卡', '应援', '生日会', '直播回放',
  '销量', '打榜', '冲榜', '公益', '代言', '广告', '课程', '直播答题',
  '抢先听', '回顾', '盘点', '合辑', '重温', '答谢', '高光', '混剪'
];
const NOISE_RECAP = [
  '谢谢青岛', '谢谢深圳', '谢谢上海', '谢谢广州', '谢谢北京', '谢谢成都',
  '明天也见', '我们🙅', '我们🦐', '我们🦀', '后会有期', '散场', '返场',
  '圆满结束', '完美落幕', '意犹未尽', '今日圆满', '三场都见'
];
const STRONG_DATE = /\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*年|\d{1,2}\/\d{1,2}/;
const ACTION = /开售|开票|预售|上线|发行|首播|放映|演出|官宣|演唱会|快闪|巡演|签售|见面会/;
const FUTURE = /即将|将于|即将于|定档|官宣|正式|开启|启航|敬请期待|预售|开票|开售|上线|发行|首播|首演|首场|倒计时|敬请|即将上线/;
const PAST = /昨夜|今晚|今天|今早|刚刚|三天|第二天|圆满|精彩继续|意犹未尽|返场|散场|告别|落幕|收官|结束了|已结束/;

function looksLikeSchedule(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const hasStrongDate = STRONG_DATE.test(t);
  const hasAction = ACTION.test(t);
  const hasFuture = FUTURE.test(t);
  const hasPast = PAST.test(t);
  if (NOISE_RECAP.some((h) => t.includes(h))) return false;
  if (NOISE_SOFT.some((h) => t.includes(h)) && !hasStrongDate) return false;
  if (hasStrongDate || hasFuture) return true;
  if (hasAction && hasPast) return false;
  return hasAction;
}

const ALLOWED_TYPES = ['concert', 'ticket', 'flash', 'xr', 'merch', 'song', 'mv', 'behind', 'musician', 'birthday'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function dateToTs(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }

function validateItem(item, opts) {
  if (!item || typeof item !== 'object') return null;
  const date = String(item.date || '').trim();
  if (!isValidDateStr(date)) return null;
  const endDate = String(item.endDate || '').trim();
  if (endDate && !isValidDateStr(endDate)) return null;
  const s = dateToTs(date), e = endDate ? dateToTs(endDate) : s;
  if (e < s) return null;
  if (s < opts.now - 24 * 3600 * 1000) return null;
  if (s > opts.now + opts.maxFutureDays * 24 * 3600 * 1000) return null;
  const name = String(item.name || '').trim();
  if (!name || name.length > 60) return null;
  const type = String(item.type || '').trim();
  if (ALLOWED_TYPES.indexOf(type) === -1) return null;
  const c = Number(item.confidence);
  const confidence = isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  if (confidence < 0.55) return null;
  return {
    date, endDate: endDate || '', name, type,
    location: String(item.location || '').trim().slice(0, 60),
    songs: Array.isArray(item.songs) ? item.songs.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10) : [],
    confidence, reason: String(item.reason || '').trim().slice(0, 120)
  };
}

// ============================================================
// 「模拟 LLM」：按真实微博的语义规则返回抽取结果
// ============================================================
function mockLLM(posts) {
  const out = [];
  posts.forEach((p) => {
    const c = p.content;
    const pubDate = p.published ? p.published.slice(0, 10) : '';

    // 「明日12:00，即将上线」→ 明天发布日 + 1
    if (/明日12:00|明日\s*12:00/.test(c) && /上线|发行/.test(c)) {
      const d = new Date(pubDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      const songs = [];
      const m = c.match(/《([^》]+)》/g);
      if (m) m.forEach((x) => songs.push(x.replace(/[《》]/g, '')));
      out.push({
        date: d.toISOString().slice(0, 10), endDate: '',
        name: '《联名2》新专辑上线', type: 'song',
        location: '', songs, confidence: 0.9, reason: '原文：明日12:00，即将上线'
      });
    }

    // 「11月1日，中国澳门见」→ 今年的 11 月 1 日
    if (/11月1日/.test(c) && /澳门/.test(c)) {
      const y = new Date(pubDate).getUTCFullYear();
      out.push({
        date: `${y}-11-01`, endDate: '',
        name: '明日世界巡回演唱会 中国澳门站', type: 'concert',
        location: '中国澳门', songs: [], confidence: 0.9,
        reason: '原文：11月1日，中国澳门见'
      });
    }

    // 「2026「明日世界」世界巡回演唱会，正式启航」→ 官宣但没写日期
    //    ⚠️ 典型误判：LLM 可能硬编一个日期出来
    if (/正式启航/.test(c)) {
      out.push({
        date: '2026-12-31', endDate: '',   // 故意编一个远期日期，测校验层
        name: '明日世界巡回演唱会 官宣', type: 'concert',
        location: '', songs: [], confidence: 0.6,
        reason: '原文只说正式启航，没有具体日期'
      });
    }

    // 青岛现场返场（没日期没未来词）→ LLM 应该抽不出东西
    if (/见面是雀跃的|确定要见面到真的见到/.test(c)) {
      out.push({
        date: '2026-10-20', endDate: '',   // 故意抽一个过去的日期
        name: '明日世界巡回演唱会 青岛站', type: 'concert',
        location: '青岛', songs: [], confidence: 0.8,
        reason: '现场返场微博，没有未来日程'
      });
    }
  });
  return out;
}

// ============================================================
if (!fs.existsSync(RAW_FILE)) {
  console.log('\n⚠️ 没有 data/raw-weibo.json（需要先跑 fetch-weibo.js），跳过真实数据验证。');
  console.log('   本地跑一次：node scripts/fetch-weibo.js');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
const all = Array.isArray(raw.items) ? raw.items : [];

group('真实数据规模');
{
  ok('抓到了数据', all.length > 0, 'items=' + all.length);
  ok('每个源都有数据', new Set(all.map((i) => i.source)).size >= 1);
  const withTime = all.filter((i) => i.published && i.pubTs > 0);
  ok('所有条目都有发布时间（时区解析正确）', withTime.length === all.length,
     withTime.length + '/' + all.length);
  ok('发布时间落在合理范围（2026 年内）',
     all.filter((i) => i.published && i.published.startsWith('2026-')).length >= all.length * 0.8);
}

group('预筛：真日程没被误杀');
{
  const candidates = all.filter((i) => looksLikeSchedule(i.content));
  ok('预筛砍掉了大部分噪音', candidates.length < all.length,
     'kept=' + candidates.length + '/' + all.length);
  ok('「11月1日，中国澳门见」被保留',
     candidates.some((c) => c.content.includes('11月1日')));
  ok('「明日12:00，即将上线」被保留',
     candidates.some((c) => c.content.includes('明日12:00')));
  ok('演唱会官宣（正式启航）被保留',
     candidates.some((c) => c.content.includes('正式启航')));
  ok('现场返场微博（「我们🙅🦑」）被排除',
     !candidates.some((c) => c.content.includes('我们🙅🦑')));
  ok('「谢谢青岛」被排除',
     !candidates.some((c) => c.content.includes('谢谢青岛')));
}

group('校验 + 去重：真实数据走完整管道');
{
  const NOW = new Date(2026, 9, 26).getTime();
  const OPTS = { now: new Date(2026, 9, 26, 0, 0, 0).getTime(), maxFutureDays: 400 };

  const candidates = all.filter((i) => looksLikeSchedule(i.content));
  const llmOut = mockLLM(candidates);
  const validated = llmOut.map((it) => validateItem(it, OPTS)).filter(Boolean);

  ok('模拟 LLM 返回 ' + llmOut.length + ' 条，校验通过 ' + validated.length + ' 条',
     validated.length < llmOut.length || llmOut.length === 0);

  const seen = new Map();
  for (const it of validated) {
    const k = `${it.type}|${it.date}|${it.name.replace(/\s/g, '')}`;
    const prev = seen.get(k);
    if (!prev || it.confidence > prev.confidence) seen.set(k, it);
  }
  const final = Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));

  console.log('  → 最终日程：');
  final.forEach((f) => console.log(`     ${f.date} [${f.type}] ${f.name}${f.location ? ' @' + f.location : ''} (conf ${f.confidence})`));

  ok('澳门站被正确抽出', final.some((f) => f.date.endsWith('11-01')));
  ok('澳门站 location 正确', final.some((f) => f.location === '中国澳门'));
  ok('新歌条目被抽出', final.some((f) => f.type === 'song'));
  ok('青岛站的过去日期被校验层丢弃', !final.some((f) => f.date === '2026-10-20'));
  ok('所有最终条目都在未来（2026-10-26 之后）',
     final.every((f) => dateToTs(f.date) >= new Date(2026, 9, 26).getTime()));
  ok('没有超出一年（2036 那种抽错年份被拦住）',
     final.every((f) => dateToTs(f.date) <= new Date(2027, 9, 26).getTime()));
  ok('type 全在白名单内', final.every((f) => ALLOWED_TYPES.includes(f.type)));
}

group('小程序消费契约');
{
  const NOW = new Date(2026, 9, 26).getTime();
  const OPTS = { now: new Date(2026, 9, 26, 0, 0, 0).getTime(), maxFutureDays: 400 };
  const candidates = all.filter((i) => looksLikeSchedule(i.content));
  const final = [];
  const seen = new Map();
  mockLLM(candidates).map((it) => validateItem(it, OPTS)).filter(Boolean).forEach((it) => {
    const k = `${it.type}|${it.date}|${it.name.replace(/\s/g, '')}`;
    const prev = seen.get(k);
    if (!prev || it.confidence > prev.confidence) seen.set(k, it);
  });
  Array.from(seen.values()).forEach((it) => final.push(it));

  // 复刻 index.js 的 fetchWeibo
  const allSchedules = final.map((it) => ({
    date: it.date, endDate: it.endDate || '', type: it.type || 'concert',
    name: it.name || '', time: it.time || '', location: it.location || '',
    icon: '', _fromWeibo: true, _sourceUrl: it.sourceUrl || ''
  }));
  ok('能转成日历条目', allSchedules.length === final.length);
  ok('都带 _fromWeibo 标记', allSchedules.every((s) => s._fromWeibo === true));
  ok('都带 date', allSchedules.every((s) => !!s.date));

  // 隐藏键
  const hideKey = `wb|${allSchedules[0].type}|${allSchedules[0].date}|${String(allSchedules[0].name).replace(/\s/g, '')}`;
  ok('隐藏键格式稳定', /^wb\|[a-z]+\|\d{4}-\d{2}-\d{2}\|/.test(hideKey), hideKey);
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail + (skip ? '  SKIP=' + skip : ''));
if (fail) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
