/**
 * 抓取脚本验证（2026-10-26 重写）
 *
 * 用本地 mock HTTP server 模拟 m.weibo.cn 的 container/getIndex 接口，
 * 验证 fetch-weibo.js 的「两步请求 / 清洗 / 去重 / 时间解析 / 分页 / 降级」逻辑。
 *
 * mock 的两个接口：
 *   1) ?type=uid&value=<uid>                        → 返回 userInfo + tabsInfo + containerid
 *   2) ?type=uid&value=<uid>&containerid=<cid>      → 返回 cards（含 mblog）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'fetch-weibo.js');

// ===== mock 响应 =====
// 汪苏泷Studio(5523180767) → 正常，含一条 HTML 标签正文
// 汪苏泷(1004061625646585) → 含重复条目 + 纯空白正文，测清洗与去重
// 未知 uid(999) → 500，测失败降级
const USER_INFO = {
  '5523180767': { id: 5523180767, screen_name: '汪苏泷Studio' },
  '1004061625646585': { id: 1004061625646585, screen_name: '汪苏泷' },
  'SilenceRadio0917': { id: 7000000001, screen_name: 'SilenceRadio0917' }
};

function mblog(text, createdAt, bid) {
  return { mblog: { text, created_at: createdAt, bid, id: bid } };
}

const CARDS = {
  '5523180767': [
    mblog('<p>汪苏泷2026「明日世界」世界巡回演唱会福州站正式官宣 演出时间 2026年11月13日-2026年11月15日19:00</p>',
      '10月26日 11:00', 'AAA111'),
    mblog('汪苏泷#汪苏泷告五人新歌旅行的天赋# 明日12:00，即将上线', '10月25日 11:00', 'BBB222')
  ],
  '1004061625646585': [
    mblog('第一条 &amp; 第二条 <br/>内容', '10月26日 09:00', 'CCC333'),
    // 完全重复（同 bid 同内容）
    mblog('第一条 &amp; 第二条 <br/>内容', '10月26日 09:00', 'CCC333'),
    // 纯空白正文 → 应被丢弃
    mblog('   ', '10月26日 08:00', 'DDD444')
  ],
  '7000000001': [
    mblog('今天的广州站结束了，谢谢每一个陪我从第一首唱到最后一首的你', '10月26日 09:00', 'EEE555')
  ]
};

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const value = url.searchParams.get('value') || '';
      const containerid = url.searchParams.get('containerid') || '';

      // 解析账号标识 → 数字 UID（containerid=100505{标识}）
      if (containerid.startsWith('100505')) {
        const ident = containerid.slice('100505'.length);
        const info = USER_INFO[ident];
        if (!info) { res.writeHead(500); res.end('err'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: 1,
          data: { userInfo: { id: info.id, screen_name: info.screen_name } }
        }));
        return;
      }

      // 第一步：查用户信息 + containerid
      if (!containerid) {
        const info = USER_INFO[value];
        if (!info) { res.writeHead(500); res.end('err'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: 1,
          data: {
            userInfo: { id: info.id, screen_name: info.screen_name },
            tabsInfo: { tabs: [{ tab_type: 'weibo', containerid: '107603' + info.id }] }
          }
        }));
        return;
      }

      // 第二步：查卡片列表
      const cid = String(containerid).replace('107603', '');
      const list = CARDS[cid];
      if (!list) { res.writeHead(500); res.end('err'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: 1,
        data: {
          since_id: '',   // 没有游标 → 只有一页
          cards: list.map(c => Object.assign({ card_type: 9 }, c))
        }
      }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runFetch(env, keepExisting) {
  return new Promise((resolve) => {
    const outFile = path.join(REPO, 'data', 'raw-weibo.json');
    // keepExisting=false 时才清空（模拟首次运行）；true 时保留，用来测「失败时历史不丢」
    if (!keepExisting) { try { fs.unlinkSync(outFile); } catch (e) {} }

    const child = spawn('node', [SCRIPT], {
      env: { ...process.env, ...env },
      cwd: REPO
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

(async function main() {
  const { server, port } = await startMock();
  const base = `http://127.0.0.1:${port}/api/container/getIndex`;

  group('抓取：正常路径');
  {
    const r = await runFetch({
      WEIBO_API_BASE: base,
      WEIBO_COOKIE: 'SUB=fake; SSOLoginState=fake',
      MAX_ITEMS_PER_SOURCE: '60'
    });
    ok('脚本退出码正常（0）', r.code === 0, 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 200));

    const outFile = path.join(REPO, 'data', 'raw-weibo.json');
    ok('生成了 raw-weibo.json', fs.existsSync(outFile));
    if (!fs.existsSync(outFile)) { server.close(); return; }

    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    ok('输出结构正确（有 items 数组）', Array.isArray(data.items));
    ok('记录了抓取时间', !!data.updatedAt && !!data.updatedAtTs);
    ok('记录了三个源账号', Array.isArray(data.sources) && data.sources.length === 3);

    const studio = data.items.filter(i => i.source === 'studio');
    ok('Studio 抓到 2 条', studio.length === 2, 'got ' + studio.length);

    const wl = data.items.filter(i => i.source === 'wangsulong');
    ok('主号抓到 1 条（完全重复的 + 空内容的都被剔掉）', wl.length === 1, 'got ' + wl.length);

    const radio = data.items.filter(i => i.source === 'radio');
    ok('自定义域名被解析出数字 UID 并抓到 1 条', radio.length === 1, 'got ' + radio.length);
    ok('解析后的 UID 是数字', radio.length === 1 && /^\d+$/.test(radio[0].uid), 'uid=' + (radio[0] && radio[0].uid));
  }

  group('清洗：HTML 标签与实体');
  {
    const data = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    const wl = data.items.find(i => i.source === 'wangsulong');
    ok('HTML 标签被去掉', wl && !/<[^>]+>/.test(wl.content), 'content=' + (wl && wl.content));
    ok('&amp; 被还原成 &', wl && wl.content.includes('&'), 'content=' + (wl && wl.content));
    ok('多余空白被压缩', wl && !/\s{2,}/.test(wl.content), 'content=' + JSON.stringify(wl && wl.content));
  }

  group('元数据：链接与发布时间');
  {
    const data = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    const item = data.items.find(i => i.source === 'studio');
    ok('保留了原微博链接', item && item.link.includes('weibo.cn/detail/'), 'link=' + (item && item.link));
    ok('发布时间转成了 ISO', item && /^\d{4}-\d{2}-\d{2}T/.test(item.published), 'published=' + (item && item.published));
    ok('时间戳可用于排序', item && item.pubTs > 0);
    ok('发布时间落在 2026-10-25/26（月份/日期解析正确）',
       item && /2026-10-2[56]/.test(item.published), 'published=' + (item && item.published));
  }

  group('排序：按时间倒序');
  {
    const data = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    let sorted = true;
    for (let i = 1; i < data.items.length; i++) {
      if (data.items[i].pubTs > data.items[i - 1].pubTs) { sorted = false; break; }
    }
    ok('条目按发布时间倒序', sorted);
  }

  group('失败降级：历史数据必须保留');
  {
    const first = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    ok('第一次有数据', first.items.length > 0);

    // 第二次跑：mock 全部 500 → 抓不到新数据，但历史要留住
    const dead = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
    await new Promise(r => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;

    const r2 = await runFetch({
      WEIBO_API_BASE: `http://127.0.0.1:${deadPort}/api/container/getIndex`,
      WEIBO_COOKIE: 'SUB=fake'
    }, true);   // 保留历史文件
    dead.close();

    ok('全部抓取失败时退出码非 0（让 CI 报错提醒）', r2.code === 2, 'code=' + r2.code);

    const after = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    ok('历史数据被完整保留（不会被清空）', after.items.length === first.items.length,
       'before=' + first.items.length + ' after=' + after.items.length);
    ok('标记了本次新抓 0 条', after.freshCount === 0, 'freshCount=' + after.freshCount);
  }

  group('去重：同一条微博只留一份');
  {
    const data = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'raw-weibo.json'), 'utf8'));
    const links = data.items.map(i => i.link);
    ok('没有重复链接', new Set(links).size === links.length,
       'total=' + links.length + ' unique=' + new Set(links).size);
  }

  group('未配置 Cookie 时的行为');
  {
    const r = await runFetch({
      WEIBO_API_BASE: base,
      WEIBO_COOKIE: ''
    });
    ok('不崩溃（只是抓不到）', r.code === 0 || r.code === 2, 'code=' + r.code);
    ok('给了明确的提示', r.stdout.includes('WEIBO_COOKIE') || r.stdout.includes('未配置'),
       r.stdout.slice(0, 200));
  }

  group('Cookie 缺少 SUB 时的提醒');
  {
    const r = await runFetch({
      WEIBO_API_BASE: base,
      WEIBO_COOKIE: 'SCF=abc; _T_WM=def'
    });
    ok('提示了缺少 SUB', r.stdout.includes('SUB'), r.stdout.slice(0, 300));
  }

  server.close();
  console.log('\n========================================');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) {
    console.log('\n失败项:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL GREEN');
})();
