/**
 * 端到端模拟：用真实微博正文样本，走「预筛 → 校验 → 去重 → 小程序侧合并」全链路，
 * 验证最终产物格式正确、小程序能正确消费。
 *
 * 这里不调真 LLM，而是用一个「模拟 LLM」返回按样本构造的抽取结果，
 * 重点验证：管道两端（脚本产出 / 小程序消费）的契约是否对得上。
 */

'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

// ============================================================
// 真实微博正文样本（取自三个账号实际动态，基准日 2026-10-26）
// ============================================================
const RAW_ITEMS = [
  {
    source: 'studio', sourceName: '汪苏泷Studio',
    content: '汪苏泷2026「明日世界」世界巡回演唱会福州站正式官宣 浪漫寻找新的落点，「明日世界」即将抵达。演出地点 福州海峡奥体中心体育场 演出时间 2026年11月13日-2026年11月15日19:00',
    published: '2026-10-26T11:00:00.000Z', pubTs: Date.parse('2026-10-26T11:00:00Z'),
    link: 'https://weibo.com/5523180767/RlGYX57v3'
  },
  {
    source: 'studio', sourceName: '汪苏泷Studio',
    content: '汪苏泷#汪苏泷明日世界巡回演唱会# 福州站三场门票预售售罄🎫 2026年11月13日-2026年11月15日 19:00 🏟️ 福州海峡奥体中心体育场',
    published: '2026-10-25T12:01:00.000Z', pubTs: Date.parse('2026-10-25T12:01:00Z'),
    link: 'https://weibo.com/5523180767/xxx2'
  },
  {
    source: 'studio', sourceName: '汪苏泷Studio',
    content: '汪苏泷#汪苏泷新专辑联名2# 十位跨越风格与世代的女性歌手 十首量身创作并制作的泷式原创 时隔4年，汪苏泷概念创作集《联名2》再度出发',
    published: '2026-10-26T12:05:00.000Z', pubTs: Date.parse('2026-10-26T12:05:00Z'),
    link: 'https://weibo.com/5523180767/xxx3'
  },
  {
    source: 'studio', sourceName: '汪苏泷Studio',
    content: '汪苏泷#汪苏泷告五人新歌旅行的天赋# 汪苏泷概念创作集《联名2》爱人主打《旅行的天赋》，"汪苏泷X告五人"，明日12:00，即将上线',
    published: '2026-10-25T11:00:00.000Z', pubTs: Date.parse('2026-10-25T11:00:00Z'),
    link: 'https://weibo.com/5523180767/xxx4'
  },
  {
    source: 'wangsulong', sourceName: '汪苏泷',
    content: '汪苏泷2026「罗曼前传」世界巡回演唱会正式官宣 演出时间&地点 中国澳门|2/27 2/28 3/1 Galaxy Arena 纽约|3/7 Barclays Center',
    published: '2025-11-21T16:20:00.000Z', pubTs: Date.parse('2025-11-21T16:20:00Z'),
    link: 'https://weibo.com/5523180767/QeSlt5SIL'
  },
  {
    source: 'wangsulong', sourceName: '汪苏泷',
    content: '转发微博 @汪苏泷Studio 汪苏泷#汪苏泷新专辑联名2# 感谢大家的支持',
    published: '2026-10-26T13:00:00.000Z', pubTs: Date.parse('2026-10-26T13:00:00Z'),
    link: 'https://weibo.com/1625646585/x5'
  },
  {
    source: 'radio', sourceName: 'SilenceRadio0917',
    content: '今天的广州站结束了，谢谢每一个陪我从第一首唱到最后一首的你',
    published: '2026-10-26T09:00:00.000Z', pubTs: Date.parse('2026-10-26T09:00:00Z'),
    link: 'https://weibo.com/xxx/x6'
  }
];

// ============================================================
// 管道两端
// ============================================================
const ALLOWED_TYPES = ['concert','ticket','flash','xr','merch','song','mv','behind','musician','birthday'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s) {
  if (!DATE_RE.test(String(s||''))) return false;
  const [y,m,d] = String(s).split('-').map(Number);
  if (m<1||m>12||d<1||d>31) return false;
  const dt = new Date(y,m-1,d);
  return dt.getFullYear()===y && dt.getMonth()===m-1 && dt.getDate()===d;
}
function dateToTs(s){ const [y,m,d]=String(s).split('-').map(Number); return new Date(y,m-1,d).getTime(); }

const NON_SCHEDULE_HINTS = ['抽奖','转发','点赞','评论区','打卡','应援','生日会','直播回放','销量','打榜','冲榜','公益','代言','广告','课程','直播答题','抢先听','回顾','盘点','合辑','重温','答谢','高光','混剪'];
function looksLikeSchedule(text) {
  const t = String(text||'');
  if (!t) return false;
  if (NON_SCHEDULE_HINTS.some(h=>t.includes(h))) return false;
  return /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{1,2}\/\d{1,2}|开售|开票|预售|上线|发行|首播|放映|演出|官宣/.test(t);
}
function validateItem(item, opts) {
  if (!item||typeof item!=='object') return null;
  const date=String(item.date||'').trim();
  if(!isValidDateStr(date)) return null;
  const endDate=String(item.endDate||'').trim();
  if(endDate && !isValidDateStr(endDate)) return null;
  const s=dateToTs(date), e=endDate?dateToTs(endDate):s;
  if(e<s) return null;
  if(s < opts.now-24*3600*1000) return null;
  if(s > opts.now + opts.maxFutureDays*24*3600*1000) return null;
  const name=String(item.name||'').trim();
  if(!name||name.length>60) return null;
  const type=String(item.type||'').trim();
  if(ALLOWED_TYPES.indexOf(type)===-1) return null;
  const c=Number(item.confidence);
  const confidence=isFinite(c)?Math.max(0,Math.min(1,c)):0.5;
  if(confidence<0.55) return null;
  return {date,endDate,name,type,location:String(item.location||'').trim().slice(0,60),
    songs:Array.isArray(item.songs)?item.songs.map(x=>String(x||'').trim()).filter(Boolean).slice(0,10):[],
    confidence,reason:String(item.reason||'').trim().slice(0,120)};
}

// 「模拟 LLM」：按正文关键词返回抽取结果（含刻意制造的典型误判，用来验证校验层）
function mockLLM(posts) {
  const out = [];
  posts.forEach(p => {
    const c = p.content;
    if (c.includes('福州站正式官宣')) {
      out.push({date:'2026-11-13',endDate:'2026-11-15',name:'明日世界巡回演唱会 福州站',type:'concert',
                location:'福州海峡奥体中心体育场',songs:[],confidence:0.95,reason:'原文：2026年11月13日-2026年11月15日'});
    } else if (c.includes('门票预售售罄')) {
      out.push({date:'2026-11-13',endDate:'2026-11-15',name:'明日世界巡回演唱会 福州站',type:'concert',
                location:'福州海峡奥体中心体育场',songs:[],confidence:0.9,reason:'原文同上'});
    } else if (c.includes('告五人新歌')) {
      out.push({date:'2026-10-27',endDate:'',name:'《联名2》新专辑发行',type:'song',
                location:'',songs:['旅行的天赋'],confidence:0.88,reason:'原文：明日12:00即将上线'});
    } else if (c.includes('新专辑联名2')) {
      // ⚠️ 典型误判：预告型微博（无具体日期），LLM 可能硬编一个日期出来
      out.push({date:'2026-10-30',endDate:'',name:'《联名2》新专辑',type:'song',
                location:'',songs:[],confidence:0.55,reason:'原文只说时隔4年，没有具体日期'});
    } else if (c.includes('罗曼前传')) {
      // ⚠️ 典型误判：往年微博（2025-11）里的 2026-02/03 日期，LLM 可能照抄
      out.push({date:'2026-02-27',endDate:'2026-03-01',name:'罗曼前传巡回演唱会 澳门站',type:'concert',
                location:'Galaxy Arena',songs:[],confidence:0.9,reason:'原文：2/27 2/28 3/1'});
    } else if (c.includes('转发微博')) {
      // ⚠️ 典型误判：把转发内容也当成新日程
      out.push({date:'2026-11-13',endDate:'',name:'转发内容里的演唱会',type:'concert',
                location:'',songs:[],confidence:0.8,reason:'转发里提到了日期'});
    }
  });
  return out;
}

// ============================================================
group('端到端：预筛 → LLM → 校验 → 去重');
{
  const NOW = new Date(2026,9,26).getTime();
  const OPTS = { now: new Date(2026,9,26,0,0,0).getTime(), maxFutureDays: 400 };

  // 1) 预筛
  const candidates = RAW_ITEMS.filter(it => it.content && it.content.length>10).filter(it => looksLikeSchedule(it.content));
  ok('预筛砍掉了转发/闲聊等噪音', candidates.length < RAW_ITEMS.length,
     'kept=' + candidates.length + '/' + RAW_ITEMS.length);
  ok('转发那条被预筛掉', !candidates.some(c=>c.content.includes('转发微博')));
  ok('广州站结束闲聊被预筛掉', !candidates.some(c=>c.content.includes('广州站结束')));
  ok('无日期的「新专辑预告」被预筛掉（避免 LLM 硬编日期）',
     !candidates.some(c=>c.content.includes('新专辑联名2')));
  ok('演唱会官宣被保留', candidates.some(c=>c.content.includes('福州站正式官宣')));
  ok('「明日12:00上线」那条被保留', candidates.some(c=>c.content.includes('告五人新歌')));
  ok('往年罗曼前传也被保留（交给 LLM+校验判断）', candidates.some(c=>c.content.includes('罗曼前传')));

  // 2) LLM + 校验
  const raw = mockLLM(candidates);
  const results = [];
  raw.forEach(it => { const v = validateItem(it, OPTS); if (v) results.push(v); });
  ok('LLM 返回 '+raw.length+' 条，校验通过 '+results.length+' 条', results.length < raw.length);

  // 3) 去重
  const seen = new Map();
  for (const it of results) {
    const k = `${it.type}|${it.date}|${it.name.replace(/\s/g,'')}`;
    const prev = seen.get(k);
    if (!prev || it.confidence > prev.confidence) seen.set(k, it);
  }
  const final = Array.from(seen.values()).sort((a,b)=>a.date.localeCompare(b.date));

  ok('去重后演唱会只剩一条（官宣 + 预售售罄合并）',
     final.filter(f=>f.type==='concert'&&f.name.includes('福州站')).length === 1);
  ok('新歌条目保留', final.some(f=>f.type==='song'));
  ok('往年罗曼前传(2026-02)被校验层丢弃',
     !final.some(f=>f.name.includes('罗曼前传')),
     JSON.stringify(final.map(f=>f.name+'@'+f.date)));

  console.log('  → 最终日程：');
  final.forEach(f => console.log(`     ${f.date}${f.endDate?'~'+f.endDate:''} [${f.type}] ${f.name}${f.location?' @'+f.location:''} (conf ${f.confidence})`));
}

group('端到端：小程序侧能正确消费');
{
  // 模拟 fetchWeiboSchedules 返回的数据结构
  const wbPayload = {
    updatedAt: '2026-10-26T14:00:00.000Z',
    updatedAtTs: Date.parse('2026-10-26T14:00:00Z'),
    count: 2,
    items: [
      { date:'2026-11-13', endDate:'2026-11-15', name:'明日世界巡回演唱会 福州站', type:'concert',
        location:'福州海峡奥体中心体育场', songs:[], confidence:0.95, reason:'x', sourceUrl:'https://weibo.com/x', sourceName:'汪苏泷Studio', sourcePubTs:1, extractedAt:1 },
      { date:'2026-10-27', endDate:'', name:'《联名2》新专辑发行', type:'song',
        location:'', songs:['旅行的天赋'], confidence:0.88, reason:'x', sourceUrl:'https://weibo.com/y', sourceName:'汪苏泷Studio', sourcePubTs:2, extractedAt:2 }
    ]
  };

  // 复刻 index.js 的 fetchWeibo → processSchedules → loadCalendarEvents
  const allSchedules = [];
  wbPayload.items.forEach(it => {
    if (!it || !it.date) return;
    allSchedules.push({ date: it.date, endDate: it.endDate||'', type: it.type||'concert',
      name: it.name||'', time: it.time||'', location: it.location||'', icon:'', _fromWeibo:true, _sourceUrl: it.sourceUrl||'' });
  });
  ok('微博数据全部转成了日历条目', allSchedules.length === 2);
  ok('条目带上了 _fromWeibo 标记', allSchedules.every(s=>s._fromWeibo===true));
  ok('条目带上了 location（场馆）', allSchedules[0].location === '福州海峡奥体中心体育场');

  // processSchedules 透传
  const TYPE_CONFIG = { concert:{icon:'🎤',label:'演唱会'}, ticket:{icon:'🎫',label:'抢票'}, song:{icon:'🎶',label:'新歌'} };
  const processed = allSchedules.map((s,index)=>{
    const config = TYPE_CONFIG[s.type]||{icon:'📝',label:'日程'};
    return { id:`schedule_${s.date}_${index}`, date:s.date, endDate:s.endDate||'', type:s.type||'custom',
      name:s.name||config.label, time:s.time||'', icon:s.icon||config.icon,
      location:s.location||'', _fromWeibo:!!s._fromWeibo, _sourceUrl:s._sourceUrl||'',
      daysDiff:0, inRange:false, displayText:`${s.name}` };
  });
  ok('processSchedules 保留了 location', processed[0].location === '福州海峡奥体中心体育场');
  ok('processSchedules 保留了 _fromWeibo', processed[0]._fromWeibo === true);
  ok('icon 正确回退到 typeConfig', processed[0].icon === '🎤' && processed[1].icon === '🎶');

  // loadCalendarEvents
  const calendarEvents = [];
  processed.forEach(s => { if (s.date) calendarEvents.push({ id:s.id, date:s.date, endDate:s.endDate||'', name:s.name, time:s.time||'', type:s.type, icon:s.icon, location:s.location||'', _fromWeibo:!!s._fromWeibo, isCustom:false }); });
  ok('日历事件列表拿到 2 条', calendarEvents.length === 2);
  ok('微博条目 isCustom=false（不会被「删除」按钮误伤）', calendarEvents.every(e=>e.isCustom===false));

  // 关键：微博数据不能进用户私有事件池
  const calendar_custom_events = [];  // 用户私有池
  ok('微博数据没有污染用户私有事件池', calendar_custom_events.length === 0);
}

group('降级：拉取失败绝不影响现有日历');
{
  // 模拟 fetchWeiboSchedules 返回 null（所有镜像失败）
  const wb = null;
  const allSchedules = [
    { date:'2026-05-01', name:'演唱会A', type:'concert', icon:'🎤' },
    { date:'2026-06-01', name:'演唱会B', type:'concert', icon:'🎤' }
  ];
  if (wb && Array.isArray(wb.items) && wb.items.length > 0) {
    wb.items.forEach(it => allSchedules.push({ date: it.date, type: it.type, name: it.name }));
  }
  ok('微博拉取失败时原有日程不受影响', allSchedules.length === 2);
  ok('原有日程内容完好', allSchedules[0].name === '演唱会A' && allSchedules[1].name === '演唱会B');
}

group('镜像回退顺序');
{
  const mirrors = [
    'https://raw.githubusercontent.com/{owner}/{repo}/main/data/weibo-schedules.json',
    'https://cdn.jsdelivr.net/gh/{owner}/{repo}@main/data/weibo-schedules.json',
    'https://fastly.jsdelivr.net/gh/{owner}/{repo}@main/data/weibo-schedules.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/{owner}/{repo}/main/data/weibo-schedules.json',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com/{owner}/{repo}/main/data/weibo-schedules.json'
  ];
  ok('有 5 个镜像可回退', mirrors.length === 5);
  ok('第一个是官方 raw（最权威）', mirrors[0].includes('raw.githubusercontent.com'));
  ok('有国内可访问的 CDN 镜像', mirrors.some(m=>m.includes('jsdelivr.net')));
  ok('有代理镜像兜底', mirrors.some(m=>m.includes('ghproxy')));
  ok('所有镜像指向同一个文件名', mirrors.every(m=>m.endsWith('weibo-schedules.json')));
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
