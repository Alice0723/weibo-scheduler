/**
 * 年份推断修正验证（2026-10-26 新增）
 *
 * ⚠️ 真实运行暴露的问题：
 *   微博发布于 2026-10-20，正文写「11月1日，中国澳门见」（没写年份）
 *   → LLM 抽成 2025-11-01（凭直觉猜年份）
 *   → 校验层判定「过去的日期」→ 丢弃
 *   → **真日程就这么漏了**
 *
 * 修法：fixGuessedYear() —— 原文有月日、LLM 的月日对得上、但年份与发布时间
 *       差 1 年以上且原文本没提年份 → 把年份改回发布时间的年份。
 */
'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

// ===== 复刻 extract-schedules.js 的 fixGuessedYear =====
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function fixGuessedYear(dateStr, endDateStr, content, pubTs) {
  if (!pubTs || !dateStr) return { date: dateStr, endDate: endDateStr, fixed: false };

  const text = String(content || '');

  if (/\d{4}\s*年/.test(text) || /\b(19|20)\d{2}\b/.test(text)) {
    return { date: dateStr, endDate: endDateStr, fixed: false };
  }

  const md = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (!md) return { date: dateStr, endDate: endDateStr, fixed: false };

  const srcMonth = Number(md[1]);
  const srcDay = Number(md[2]);

  const pub = new Date(pubTs);
  const pubYear = pub.getFullYear();

  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return { date: dateStr, endDate: endDateStr, fixed: false };
  const [ly, lm, ld] = parts;

  if (lm !== srcMonth || ld !== srcDay) {
    return { date: dateStr, endDate: endDateStr, fixed: false };
  }
  if (ly === pubYear) return { date: dateStr, endDate: endDateStr, fixed: false };

  const corrected = `${pubYear}-${String(lm).padStart(2, '0')}-${String(ld).padStart(2, '0')}`;
  if (!isValidDateStr(corrected)) {
    return { date: dateStr, endDate: endDateStr, fixed: false };
  }

  let correctedEnd = endDateStr;
  if (endDateStr) {
    const ep = endDateStr.split('-').map(Number);
    if (ep.length === 3) {
      const cEnd = `${pubYear}-${String(ep[1]).padStart(2, '0')}-${String(ep[2]).padStart(2, '0')}`;
      if (isValidDateStr(cEnd)) correctedEnd = cEnd;
    }
  }

  return { date: corrected, endDate: correctedEnd, fixed: true };
}

// ===== 复刻 validateItem（含修正步骤）=====
function dateToTs(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
const ALLOWED_TYPES = ['concert', 'ticket', 'flash', 'xr', 'merch', 'song', 'mv', 'behind', 'musician', 'birthday'];

function validateItem(item, opts) {
  if (!item || typeof item !== 'object') return null;
  let date = String(item.date || '').trim();
  if (!isValidDateStr(date)) return null;
  let endDate = String(item.endDate || '').trim();
  if (endDate && !isValidDateStr(endDate)) return null;

  if (opts.content && opts.sourcePubTs) {
    const fixed = fixGuessedYear(date, endDate, opts.content, opts.sourcePubTs);
    if (fixed.fixed) { date = fixed.date; endDate = fixed.endDate; }
  }

  const startTs = dateToTs(date);
  const endTs = endDate ? dateToTs(endDate) : startTs;
  if (endTs < startTs) return null;
  if (startTs < opts.now - 24 * 3600 * 1000) return null;
  if (startTs > opts.now + opts.maxFutureDays * 24 * 3600 * 1000) return null;

  const name = String(item.name || '').trim();
  if (!name || name.length > 60) return null;
  const type = String(item.type || '').trim();
  if (ALLOWED_TYPES.indexOf(type) === -1) return null;
  const c = Number(item.confidence);
  const confidence = isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  if (confidence < 0.55) return null;

  return { date, endDate: endDate || '', name, type, confidence };
}

const NOW = new Date(2026, 9, 26).getTime();
const OPTS = { now: NOW, maxFutureDays: 400 };
const PUB_1020 = Date.parse('2026-10-20T14:27:00Z');

group('核心场景：澳门站被漏掉的那个');
{
  const content = '11月1日，中国澳门见 @MixWei @W中文版';

  // 不带修正逻辑时（旧的 validateItem 行为）→ 被丢弃，这就是漏掉的原因
  const legacyValidate = (item) => {
    if (!item || typeof item !== 'object') return null;
    const date = String(item.date || '').trim();
    if (!isValidDateStr(date)) return null;
    const startTs = dateToTs(date);
    if (startTs < OPTS.now - 24 * 3600 * 1000) return null;
    if (startTs > OPTS.now + OPTS.maxFutureDays * 24 * 3600 * 1000) return null;
    const type = String(item.type || '').trim();
    if (ALLOWED_TYPES.indexOf(type) === -1) return null;
    return { date };
  };

  const llmItem = { date: '2025-11-01', endDate: '', name: '明日世界巡回演唱会 中国澳门站', type: 'concert', confidence: 0.9 };

  const legacy = legacyValidate(llmItem);
  ok('旧逻辑（无年份修正）确实会丢弃这条真日程', legacy === null,
     '这正是 2026-10-26 漏掉澳门站的原因');

  // 修正后：年份被纠正 → 通过
  const after = validateItem(llmItem, { ...OPTS, content, sourcePubTs: PUB_1020 });
  ok('⚠️ 加了年份修正后通过校验', after !== null, JSON.stringify(after));
  ok('⚠️ 日期被改成 2026-11-01', after && after.date === '2026-11-01', after && after.date);
}

group('不该改的情况');
{
  const PUB = Date.parse('2026-10-20T14:27:00Z');

  // 原文明确写了年份 → 尊重原文
  const r1 = fixGuessedYear('2025-11-01', '', '2025年11月1日，中国澳门见', PUB);
  ok('原文写了年份时不改', r1.fixed === false && r1.date === '2025-11-01', JSON.stringify(r1));

  // 月日对不上 → 不是同一天
  const r2 = fixGuessedYear('2025-12-25', '', '11月1日，中国澳门见', PUB);
  ok('月日对不上时不改', r2.fixed === false && r2.date === '2025-12-25', JSON.stringify(r2));

  // 年份本来就对
  const r3 = fixGuessedYear('2026-11-01', '', '11月1日，中国澳门见', PUB);
  ok('年份已经对时不改', r3.fixed === false && r3.date === '2026-11-01', JSON.stringify(r3));

  // 原文没有月日（相对表述）→ 不动
  const r4 = fixGuessedYear('2025-10-27', '', '明日12:00，即将上线', PUB);
  ok('相对表述不改', r4.fixed === false && r4.date === '2025-10-27', JSON.stringify(r4));

  // 没有发布时间 → 不动
  const r5 = fixGuessedYear('2025-11-01', '', '11月1日', 0);
  ok('没有发布时间时不改', r5.fixed === false && r5.date === '2025-11-01', JSON.stringify(r5));

  // 空内容
  const r6 = fixGuessedYear('2025-11-01', '', '', PUB);
  ok('空内容时不改', r6.fixed === false, JSON.stringify(r6));
}

group('多日区间也要一起修正');
{
  const PUB = Date.parse('2026-10-20T14:27:00Z');
  const r = fixGuessedYear('2025-11-13', '2025-11-15', '11月13日-15日 演出', PUB);
  ok('endDate 一起被修正', r.endDate === '2026-11-15', JSON.stringify(r));
}

group('真实数据回归');
{
  const fs = require('fs');
  const path = require('path');
  const RAW = path.resolve(__dirname, '..', 'data', 'raw-weibo.json');

  if (!fs.existsSync(RAW)) {
    console.log('  (没有 data/raw-weibo.json，跳过 —— 先跑 node scripts/fetch-weibo.js)');
  } else {
    const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
    const hit = (raw.items || []).filter((i) => (i.content || '').includes('11月1日'));
    if (!hit.length) {
      console.log('  (真实数据里没有「11月1日」那条，跳过)');
    } else {
      const src = hit[0];
      const r = validateItem(
        { date: '2025-11-01', endDate: '', name: '明日世界巡回演唱会 中国澳门站', type: 'concert', confidence: 0.9 },
        { ...OPTS, content: src.content, sourcePubTs: src.pubTs }
      );
      ok('真实微博里的澳门站现在能抽出来', r !== null, JSON.stringify(r));
      ok('日期正确', r && r.date === '2026-11-01', r && r.date);
    }
  }
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
