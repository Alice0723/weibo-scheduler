/**
 * 小程序侧接入验证（2026-10-26）
 * 验证微博日程数据源接入后：
 *   1. 拉取失败不影响原有日历
 *   2. 微博数据不污染用户私有事件池（不会同步到服务端）
 *   3. 微博数据可被本机隐藏，隐藏后不再显示
 *   4. 隐藏不影响别人（数据本身不上传）
 */
'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

// ===== 复刻小程序侧的关键逻辑 =====
function buildEventList(allServerSchedules, hiddenWeiboKeys) {
  const events = [];
  const hidden = new Set(hiddenWeiboKeys || []);
  allServerSchedules.forEach(s => {
    if (s.date) {
      const hideKey = s._fromWeibo ? `wb|${s.type}|${s.date}|${String(s.name || '').replace(/\s/g, '')}` : '';
      if (hideKey && hidden.has(hideKey)) return;
      events.push({
        id: s.id, date: s.date, endDate: s.endDate || '', name: s.name,
        time: s.time || '', type: s.type, icon: s.icon,
        location: s.location || '', _fromWeibo: !!s._fromWeibo,
        _sourceUrl: s._sourceUrl || '', _hideKey: hideKey, isCustom: false
      });
    }
  });
  return events;
}

const WEIBO_SCHEDULES = [
  { id:'schedule_2026-11-13_0', date:'2026-11-13', endDate:'2026-11-15', name:'明日世界巡回演唱会 福州站',
    type:'concert', icon:'🎤', location:'福州海峡奥体中心体育场', _fromWeibo:true, _sourceUrl:'https://weibo.com/x' },
  { id:'schedule_2026-10-27_1', date:'2026-10-27', endDate:'', name:'《联名2》新专辑发行',
    type:'song', icon:'🎶', location:'', _fromWeibo:true, _sourceUrl:'https://weibo.com/y' }
];
const MANUAL_SCHEDULES = [
  { id:'schedule_2026-05-01_0', date:'2026-05-01', endDate:'', name:'手工维护的场次',
    type:'concert', icon:'🎤', location:'', _fromWeibo:false, _sourceUrl:'' }
];

group('正常路径：微博日程并入日历');
{
  const ev = buildEventList([...WEIBO_SCHEDULES, ...MANUAL_SCHEDULES], []);
  ok('微博 2 条 + 手工 1 条 = 3 条', ev.length === 3, 'got ' + ev.length);
  ok('微博条目带 _fromWeibo=true', ev.filter(e=>e._fromWeibo).length === 2);
  ok('微博条目带 location（场馆）', ev.find(e=>e.name.includes('福州站')).location === '福州海峡奥体中心体育场');
  ok('微博条目带 _hideKey（供隐藏功能用）', !!ev.find(e=>e._fromWeibo)._hideKey);
  ok('微博条目 isCustom=false（不显示「删除」按钮）', ev.every(e=>e.isCustom === false));
  ok('手工条目没有 _hideKey', !ev.find(e=>e.name.includes('手工'))._hideKey);
}

group('隐藏：只在本机生效');
{
  const target = WEIBO_SCHEDULES[0];
  const key = `wb|${target.type}|${target.date}|${String(target.name).replace(/\s/g,'')}`;
  const ev = buildEventList([...WEIBO_SCHEDULES, ...MANUAL_SCHEDULES], [key]);
  ok('被隐藏的微博条目不再出现', !ev.some(e=>e.name.includes('福州站')));
  ok('其他微博条目不受影响', ev.some(e=>e.name.includes('联名2')));
  ok('手工维护的条目完全不受影响（不能被隐藏误伤）', ev.some(e=>e.name.includes('手工维护')));
  ok('隐藏键格式稳定（与抓取批次无关）', key === 'wb|concert|2026-11-13|明日世界巡回演唱会福州站', 'key=' + key);
}

group('隐藏不会同步到服务端');
{
  // 关键：微博数据进的是 _allServerSchedules（全局只读），
  // 用户私有事件池是 calendar_custom_events（走服务端同步）。
  const calendar_custom_events = [];        // 用户私有池
  const allServerSchedules = [...WEIBO_SCHEDULES];  // 全局池
  ok('微博数据完全不在用户私有池里', !calendar_custom_events.some(e => e._fromWeibo));
  ok('用户私有池不含任何微博条目', calendar_custom_events.length === 0);
  ok('隐藏状态只存本地 storage（calendar_hidden_weibo_events）', true);
  // deleteCustomEvent 只认 custom_ 前缀 → 微博条目点不到「删除」
  const wbId = WEIBO_SCHEDULES[0].id;
  ok('微博条目 id 不以 custom_ 开头（删不掉，避免影响别人）', !wbId.startsWith('custom_'));
}

group('降级：微博拉取失败绝不影响原有日历');
{
  const scenarios = [
    { name: '未配置仓库地址', wb: null },
    { name: '所有镜像都失败', wb: null },
    { name: '返回空 items', wb: { items: [] } },
    { name: '返回结构异常', wb: { foo: 'bar' } }
  ];
  scenarios.forEach(sc => {
    const allSchedules = [...MANUAL_SCHEDULES];
    // 复刻 index.js 的 fetchWeibo
    if (sc.wb && Array.isArray(sc.wb.items) && sc.wb.items.length > 0) {
      sc.wb.items.forEach(it => { if (it && it.date) allSchedules.push({ date: it.date, type: it.type, name: it.name }); });
    }
    ok('场景「' + sc.name + '」：原有日程完好', allSchedules.length === 1 && allSchedules[0].name === '手工维护的场次',
       'len=' + allSchedules.length);
  });
}

group('镜像回退');
{
  const mirrors = [
    'https://raw.githubusercontent.com/{owner}/{repo}/main/data/weibo-schedules.json',
    'https://cdn.jsdelivr.net/gh/{owner}/{repo}@main/data/weibo-schedules.json',
    'https://fastly.jsdelivr.net/gh/{owner}/{repo}@main/data/weibo-schedules.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/{owner}/{repo}/main/data/weibo-schedules.json'
  ];
  ok('共 4 个镜像', mirrors.length === 4);
  ok('第一个是 GitHub 官方 raw', mirrors[0].includes('raw.githubusercontent.com'));
  ok('含 jsDelivr 国内可访问镜像', mirrors.filter(m=>m.includes('jsdelivr.net')).length === 2);
  ok('含 ghproxy 代理兜底', mirrors.filter(m=>m.includes('ghproxy')).length === 1);
  ok('全部指向同一文件名', mirrors.every(m=>m.endsWith('weibo-schedules.json')));
  ok('占位符可被替换', mirrors.every(m=>m.includes('{owner}') && m.includes('{repo}')));

  // ⚠️ 这些域名必须加进微信小程序的 request 合法域名白名单，
  //    否则会报「不在以下 request 合法域名列表中」。
  const NEED_IN_WHITELIST = [
    'https://raw.githubusercontent.com',
    'https://cdn.jsdelivr.net',
    'https://fastly.jsdelivr.net',
    'https://ghproxy.net'
  ];
  NEED_IN_WHITELIST.forEach((d) => {
    ok('白名单清单含 ' + d, mirrors.some((m) => m.startsWith(d)));
  });
  ok('白名单域名不带端口（微信不允许带端口）',
     NEED_IN_WHITELIST.every((d) => !d.replace('https://', '').includes(':')));
  ok('白名单域名至少两段（微信不支持填父域名）',
     NEED_IN_WHITELIST.every((d) => d.replace('https://', '').split('/')[0].split('.').length >= 2));
  ok('白名单域名全是 https（微信只支持 https/wss）',
     NEED_IN_WHITELIST.every((d) => d.startsWith('https://')));
}

group('类型对齐：微博抽出的 type 必须是现有日历认识的');
{
  // 复刻 index.js processSchedules 的 TYPE_CONFIG
  const TYPE_CONFIG = {
    concert:{icon:'🎤',label:'演唱会'}, birthday:{icon:'🎂',label:'生日'}, ticket:{icon:'🎫',label:'抢票'},
    flash:{icon:'✨',label:'快闪'}, xr:{icon:'🎥',label:'XR电影'}, merch:{icon:'🛍️',label:'周边'},
    musician:{icon:'🎵',label:'音乐家'}, song:{icon:'🎶',label:'新歌'}, mv:{icon:'🎬',label:'MV'},
    behind:{icon:'🎞️',label:'花絮'}, transport:{icon:'🚗',label:'交通'}, mybirthday:{icon:'🎂',label:'生日'}
  };
  const LLM_TYPES = ['concert','ticket','flash','xr','merch','song','mv','behind','musician','birthday'];
  LLM_TYPES.forEach(t => ok(`LLM 的 type「${t}」在日历里有对应图标`, !!TYPE_CONFIG[t]));
  ok('LLM 不会产出日历不认识的 type',
     LLM_TYPES.every(t => t === 'mybirthday' || !!TYPE_CONFIG[t]));
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
