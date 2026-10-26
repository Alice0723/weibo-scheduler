/**
 * 微博日程抽取 · 验证脚本
 *
 * 用真实微博文本样本验证：
 *   1. 校验层能否挡住 LLM 的典型误判（编造日期、往年事件、非法日期、空字段、低置信度）
 *   2. 预筛层能否在送 LLM 之前就砍掉明显不是日程的噪音
 *   3. 归一化/清洗逻辑是否正确
 *
 * 注：这里不真的调 LLM（需要 key），而是直接测「喂进 LLM 之前」和「LLM 之后」两端的逻辑。
 * 抽取质量需要配好 key 后用真实数据再看。
 */

'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

// ============================================================
// 复刻 extract-schedules.js 的校验逻辑
// ============================================================
const ALLOWED_TYPES = [
  'concert', 'ticket', 'flash', 'xr', 'merch', 'song', 'mv', 'behind', 'musician', 'birthday'
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function dateToTs(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
function validateItem(item, opts) {
  if (!item || typeof item !== 'object') return null;
  const date = String(item.date || '').trim();
  if (!isValidDateStr(date)) return null;
  const endDate = String(item.endDate || '').trim();
  if (endDate && !isValidDateStr(endDate)) return null;
  const startTs = dateToTs(date);
  const endTs = endDate ? dateToTs(endDate) : startTs;
  if (endTs < startTs) return null;
  if (startTs < opts.now - 24 * 3600 * 1000) return null;
  if (startTs > opts.now + opts.maxFutureDays * 24 * 3600 * 1000) return null;
  const name = String(item.name || '').trim();
  if (!name || name.length > 60) return null;
  const type = String(item.type || '').trim();
  if (ALLOWED_TYPES.indexOf(type) === -1) return null;
  const conf = Number(item.confidence);
  const confidence = isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
  if (confidence < 0.55) return null;
  return {
    date, endDate, name, type,
    location: String(item.location || '').trim().slice(0, 60),
    songs: Array.isArray(item.songs) ? item.songs.map(s => String(s || '').trim()).filter(Boolean).slice(0, 10) : [],
    confidence,
    reason: String(item.reason || '').trim().slice(0, 120)
  };
}

// 复刻预筛逻辑
const NON_SCHEDULE_HINTS = [
  '抽奖', '转发', '点赞', '评论区', '打卡', '应援', '生日会', '直播回放',
  '销量', '打榜', '冲榜', '公益', '代言', '广告', '课程', '直播答题',
  '抢先听', '回顾', '盘点', '合辑', '重温', '答谢', '高光', '混剪'
];
function looksLikeSchedule(text) {
  const t = String(text || '');
  if (!t) return false;
  if (NON_SCHEDULE_HINTS.some((h) => t.includes(h))) return false;
  const hasDateClue = /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{1,2}\/\d{1,2}|开售|开票|预售|上线|发行|首播|放映|演出|官宣/.test(t);
  return hasDateClue;
}

// ============================================================
// 真实微博样本（取自三个账号的实际动态，日期基准 2026-10-26）
// ============================================================
const NOW = new Date(2026, 9, 26).getTime();   // 2026-10-26
const OPTS = { now: NOW, maxFutureDays: 400 };

group('预筛层：明显不是日程的噪音');
{
  const noise = [
    '转发微博 @汪苏泷Studio 汪苏泷#汪苏泷新专辑联名2# 感谢大家的支持',
    '抽奖！转发这条微博抽3位粉丝送哥哥鸟巢伴手手礼，微博官方唯一抽奖工具',
    '新专辑《联名2》实体专辑今日10:00全网开售，欢迎大家支持',
    '今天的广州站结束了，谢谢每一个陪我从第一首唱到最后一首的你',
    '直播回放已上线，点击观看汪苏泷明日世界巡回演唱会广州站完整版',
    '公益｜汪苏泷携手品牌为山区儿童捐书，温暖传递',
    '大家评论区都在问新歌名字，保密啦敬请期待',
    '回顾汪苏泷历年演唱会高光合辑，你最喜欢哪一场'
  ];
  const kept = noise.filter(t => looksLikeSchedule(t));
  // 期望：只有「新专辑开售」这种有明确日程线索的留下来
  ok('噪音样本被大部分预筛掉（≤3 条进入 LLM）', kept.length <= 3,
    'kept=' + kept.length + ' → ' + JSON.stringify(kept));
  ok('「新专辑开售」被保留（有明确开售线索）',
     kept.some(t => t.includes('开售')));
  ok('「转发抽奖」被预筛掉',
     !kept.some(t => t.includes('抽奖')));
  ok('「直播回放」被预筛掉',
     !kept.some(t => t.includes('直播回放')));
}

group('校验层：挡住 LLM 的典型误判');
{
  // 1) 往年事件（用户最烦的：老微博里的去年日期被当成未来）
  ok('往年日期被丢弃',
     validateItem({ date: '2025-11-13', endDate: '', name: '明日世界巡回演唱会 福州站', type: 'concert', confidence: 0.95 }, OPTS) === null);

  // 2) 已过去的事件
  ok('已过去的日期被丢弃',
     validateItem({ date: '2026-08-29', endDate: '', name: '北京站演唱会', type: 'concert', confidence: 0.95 }, OPTS) === null);

  // 3) 非法日期（LLM 常犯 2 月 30 日）
  ok('非法日期 2026-02-30 被丢弃',
     validateItem({ date: '2026-02-30', endDate: '', name: 'X', type: 'concert', confidence: 0.9 }, OPTS) === null);

  // 4) 缺日期（LLM 抽不出来时可能留空）
  ok('缺日期被丢弃',
     validateItem({ date: '', endDate: '', name: '某活动', type: 'concert', confidence: 0.9 }, OPTS) === null);

  // 5) 非法 type（LLM 幻觉出不存在的类型）
  ok('非法 type 被丢弃',
     validateItem({ date: '2026-11-13', endDate: '', name: 'X', type: 'movie', confidence: 0.9 }, OPTS) === null);

  // 6) 低置信度
  ok('低置信度(0.4)被丢弃',
     validateItem({ date: '2026-11-13', endDate: '', name: 'X', type: 'concert', confidence: 0.4 }, OPTS) === null);

  // 7) endDate 早于 date
  ok('endDate 早于 date 被丢弃',
     validateItem({ date: '2026-11-15', endDate: '2026-11-13', name: 'X', type: 'concert', confidence: 0.9 }, OPTS) === null);

  // 8) 太远的未来（LLM 抽错年份，比如把 2026 抽成 2036）
  ok('过远的未来(2036)被丢弃',
     validateItem({ date: '2036-11-13', endDate: '', name: 'X', type: 'concert', confidence: 0.9 }, OPTS) === null);

  // 9) name 空
  ok('name 为空被丢弃',
     validateItem({ date: '2026-11-13', endDate: '', name: '', type: 'concert', confidence: 0.9 }, OPTS) === null);

  // 10) name 过长（把整段原文塞进来）
  ok('name 超长(>60)被丢弃',
     validateItem({ date: '2026-11-13', endDate: '', name: '汪'.repeat(80), type: 'concert', confidence: 0.9 }, OPTS) === null);
}

group('校验层：正常条目必须通过');
{
  // 真实场景：福州站演唱会 11月13-15日（多日区间）
  const r = validateItem({
    date: '2026-11-13', endDate: '2026-11-15',
    name: '明日世界巡回演唱会 福州站', type: 'concert',
    location: '福州海峡奥体中心体育场', songs: [],
    confidence: 0.95, reason: '原文写明 2026年11月13日-2026年11月15日'
  }, OPTS);
  ok('演唱会多日区间通过', r !== null);
  ok('多日区间的 date 正确', r && r.date === '2026-11-13');
  ok('多日区间的 endDate 正确', r && r.endDate === '2026-11-15');
  ok('场馆信息保留', r && r.location === '福州海峡奥体中心体育场');

  // 抢票条目
  const t = validateItem({
    date: '2026-11-11', endDate: '', name: '福州站门票预售', type: 'ticket',
    location: '', songs: [], confidence: 0.9, reason: '预售时间正式公布'
  }, OPTS);
  ok('抢票条目通过', t !== null && t.type === 'ticket');

  // 新歌上线
  const s = validateItem({
    date: '2026-10-27', endDate: '', name: '《联名2》新专辑发行', type: 'song',
    location: '', songs: ['旅行的天赋'], confidence: 0.9, reason: '明日12:00 即将上线'
  }, OPTS);
  ok('新歌条目通过', s !== null && s.type === 'song');
  ok('歌曲名保留', s && s.songs.length === 1 && s.songs[0] === '旅行的天赋');

  // 今天的（当天，边界）
  const today = validateItem({
    date: '2026-10-26', endDate: '', name: '今天的活动', type: 'flash',
    location: '', songs: [], confidence: 0.9, reason: '今天'
  }, OPTS);
  ok('当天的条目通过（不被误杀）', today !== null);
}

group('去重：同一条日程被多次抽到');
{
  const items = [
    { date: '2026-11-13', endDate: '2026-11-15', name: '明日世界巡回演唱会 福州站', type: 'concert', confidence: 0.9 },
    { date: '2026-11-13', endDate: '2026-11-15', name: '明日世界巡回演唱会 福州站', type: 'concert', confidence: 0.95 },
    { date: '2026-11-13', endDate: '2026-11-15', name: '明日世界巡回演唱会福州站', type: 'concert', confidence: 0.8 },
    { date: '2026-11-11', endDate: '', name: '福州站门票预售', type: 'ticket', confidence: 0.9 }
  ];
  const seen = new Map();
  for (const it of items) {
    const k = `${it.type}|${it.date}|${it.name.replace(/\s/g, '')}`;
    const prev = seen.get(k);
    if (!prev || it.confidence > prev.confidence) seen.set(k, it);
  }
  const dedup = Array.from(seen.values());
  ok('同名同日期同类型合并为一条', dedup.length === 2, 'len=' + dedup.length);
  ok('保留置信度更高的那条', dedup.find(d => d.type === 'concert').confidence === 0.95);
}

group('脏数据不炸');
{
  ok('null 输入不炸', validateItem(null, OPTS) === null);
  ok('undefined 输入不炸', validateItem(undefined, OPTS) === null);
  ok('非对象输入不炸', validateItem('xxx', OPTS) === null);
  ok('confidence 是字符串能转', (() => {
    const r = validateItem({ date: '2026-11-13', endDate: '', name: 'X', type: 'concert', confidence: '0.9' }, OPTS);
    return r !== null && r.confidence === 0.9;
  })());
  ok('confidence 缺失按 0.5 处理（低于阈值被丢弃）',
     validateItem({ date: '2026-11-13', endDate: '', name: 'X', type: 'concert' }, OPTS) === null);
  ok('songs 不是数组不炸', (() => {
    const r = validateItem({ date: '2026-11-13', endDate: '', name: 'X', type: 'concert', confidence: 0.9, songs: 'abc' }, OPTS);
    return r !== null && Array.isArray(r.songs) && r.songs.length === 0;
  })());
}

group('日期合法性：覆盖各类边界');
{
  const cases = [
    ['2026-01-01', true], ['2026-12-31', true], ['2026-02-29', false], // 2026 非闰年
    ['2024-02-29', true],  // 闰年
    ['2026-04-31', false], ['2026-13-01', false], ['2026-00-10', false],
    ['2026-1-1', false],   // 必须补零
    ['26-01-01', false]
  ];
  cases.forEach(([d, expect]) => {
    ok(`日期 ${d} ${expect ? '合法' : '非法'}`, isValidDateStr(d) === expect);
  });
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
