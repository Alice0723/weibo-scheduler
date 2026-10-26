/**
 * LLM 通道与分批逻辑验证（2026-10-26）
 *
 * 覆盖 extract-schedules.js 里新引入、此前没有测试覆盖的部分：
 *   1. 通道选择：有 LLM_API_KEY 用自己的；没有就用 GITHUB_TOKEN 走 GitHub Models
 *   2. 分批：既要受条数上限约束，也要受字符预算约束
 *      （GitHub Models 免费层单次输入上限 8000 token，提示词就占掉一大半，
 *        正文塞太多会直接 400 —— 这是真实的坑）
 *   3. 真实 HTTP 交互：mock 一个 OpenAI 兼容端点，验证请求体与响应解析
 */
'use strict';

const http = require('http');
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
const SCRIPT = path.join(REPO, 'scripts', 'extract-schedules.js');

// ============================================================
// 复刻 extract-schedules.js 的通道选择逻辑
// ============================================================
function pickChannel(env) {
  const LLM_API_KEY = (env.LLM_API_KEY || '').trim();
  const GITHUB_TOKEN = (env.GITHUB_TOKEN || '').trim();
  if (LLM_API_KEY) {
    return {
      name: '自有 API',
      baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      model: env.LLM_MODEL || 'deepseek-chat',
      token: LLM_API_KEY,
      charBudget: Number(env.LLM_CHAR_BUDGET || 12000),
      maxTokens: 4000
    };
  }
  if (GITHUB_TOKEN) {
    return {
      name: 'GitHub Models',
      baseUrl: 'https://models.github.ai/inference',
      model: env.LLM_MODEL || 'openai/gpt-4o-mini',
      token: GITHUB_TOKEN,
      charBudget: Number(env.LLM_CHAR_BUDGET || 4500),
      maxTokens: 3000
    };
  }
  return null;
}

group('通道选择：优先级');
{
  const both = pickChannel({ LLM_API_KEY: 'sk-xxx', GITHUB_TOKEN: 'ghs_yyy' });
  ok('两个都有时优先用自有 API', both.baseUrl.includes('deepseek'), both.baseUrl);
  ok('自有 API 用的是自己的 key', both.token === 'sk-xxx');

  const onlyGh = pickChannel({ GITHUB_TOKEN: 'ghs_yyy' });
  ok('只有 GITHUB_TOKEN 时走 GitHub Models', onlyGh.baseUrl === 'https://models.github.ai/inference', onlyGh.baseUrl);
  ok('GitHub Models 的模型 id 带 provider 前缀', onlyGh.model === 'openai/gpt-4o-mini', onlyGh.model);
  ok('GitHub Models 用仓库自带的 token', onlyGh.token === 'ghs_yyy');

  const none = pickChannel({});
  ok('两个都没有时不调 LLM（脚本会退出报错）', none === null);

  const custom = pickChannel({ LLM_API_KEY: 'sk-x', LLM_BASE_URL: 'https://api.qingyunai.com/v1/', LLM_MODEL: 'qwen-plus' });
  ok('自定义 base url 生效', custom.baseUrl === 'https://api.qingyunai.com/v1', custom.baseUrl);
  ok('尾斜杠被去掉（避免拼出 //chat/completions）', !custom.baseUrl.endsWith('/'));
  ok('自定义模型生效', custom.model === 'qwen-plus');
}

group('分批：字符预算不能被突破');
{
  // 复刻 makeBatches
  function makeBatches(candidates, BATCH_SIZE, CHAR_BUDGET) {
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const p of candidates) {
      const len = (p.content || '').length + 60;
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

  // 60 条长微博，每条 500 字
  const long = Array.from({ length: 60 }, (_, i) => ({ content: 'x'.repeat(500) }));
  const b1 = makeBatches(long, 15, 12000);
  ok('长文本被切成多批', b1.length > 1, 'batches=' + b1.length);
  ok('每批条数不超过 15', b1.every(b => b.length <= 15));
  ok('每批字符数不超过预算', b1.every(b =>
     b.reduce((s, p) => s + p.content.length + 60, 0) <= 12000));
  ok('所有条目都被分配到某一批（不丢数据）',
     b1.reduce((s, b) => s + b.length, 0) === 60,
     'total=' + b1.reduce((s, b) => s + b.length, 0));

  // GitHub Models 的 4500 字预算：100 条 1000 字的长文也必须被切开
  const veryLong = Array.from({ length: 100 }, (_, i) => ({ content: 'y'.repeat(1000) }));
  const b2 = makeBatches(veryLong, 15, 4500);
  ok('GitHub Models 预算下每批字符数不超 4500', b2.every(b =>
     b.reduce((s, p) => s + p.content.length + 60, 0) <= 4500),
     JSON.stringify(b2.map(b => b.reduce((s, p) => s + p.content.length + 60, 0))));
  ok('超长文本不会挤爆单次请求', b2.length >= 20, 'batches=' + b2.length);

  // 短文本：应该能塞满一批
  const short = Array.from({ length: 10 }, () => ({ content: '短' }));
  const b3 = makeBatches(short, 15, 12000);
  ok('短文本合并成一批', b3.length === 1, 'batches=' + b3.length);
  ok('短文本批次内容完整', b3[0].length === 10);

  // 空数组
  const b4 = makeBatches([], 15, 12000);
  ok('空输入不产生批次', b4.length === 0);
}

group('真实 HTTP 交互：mock 一个 OpenAI 兼容端点');
{
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d.toString());
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"items":[{"date":"2026-11-13","endDate":"2026-11-15","name":"明日世界巡回演唱会 福州站","type":"concert","location":"福州海峡奥体中心体育场","songs":[],"confidence":0.95,"reason":"官宣"}]}' } }]
      }));
    });
  });

  const run = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const child = spawn('node', [SCRIPT], {
        env: {
          ...process.env,
          LLM_API_KEY: 'sk-test',
          LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
          LLM_MODEL: 'test-model',
          MAX_POSTS: '5'
        },
        cwd: REPO
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  });

  // 用一个临时的 raw-weibo.json 驱动
  const fs = require('fs');
  const rawPath = path.join(REPO, 'data', 'raw-weibo.json');
  const backup = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : null;
  fs.writeFileSync(rawPath, JSON.stringify({
    updatedAt: '2026-10-26T00:00:00.000Z',
    items: [
      { source: 'studio', sourceName: '汪苏泷Studio', content: '汪苏泷2026「明日世界」巡回演唱会福州站 2026年11月13日-15日 官宣', published: '2026-10-26T11:00:00.000Z', pubTs: Date.parse('2026-10-26T11:00:00Z'), link: 'https://weibo.cn/detail/x1' },
      { source: 'studio', sourceName: '汪苏泷Studio', content: '转发微博 感谢大家支持', published: '2026-10-26T12:00:00.000Z', pubTs: Date.parse('2026-10-26T12:00:00Z'), link: 'https://weibo.cn/detail/x2' }
    ]
  }, null, 2), 'utf8');

  run.then((r) => {
    server.close();

    ok('脚本正常退出', r.code === 0, 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 300));
    ok('打出了所用通道', r.stdout.includes('LLM 通道'), r.stdout.slice(0, 300));
    ok('请求打到了 /chat/completions', received.length > 0 && received[0].url === '/v1/chat/completions',
       received.length ? received[0].url : 'no request');
    ok('带上了 Bearer 鉴权', received.length > 0 && /^Bearer /.test(received[0].auth || ''));
    ok('用了指定的模型', received.length > 0 && received[0].body.model === 'test-model',
       received.length ? received[0].body.model : '');
    ok('请求里有 system 提示词', received.length > 0 && received[0].body.messages[0].role === 'system');
    ok('请求里有 json_object 格式约束', received.length > 0 && received[0].body.response_format &&
       received[0].body.response_format.type === 'json_object');

    // 预筛：转发那条不该进 LLM
    const userMsg = received.length ? received[0].body.messages[1].content : '';
    ok('转发那条被预筛掉，没进 LLM 请求', !userMsg.includes('转发微博'), userMsg.slice(0, 200));
    ok('演唱会那条进了 LLM 请求', userMsg.includes('福州站'));

    // 产出文件
    const outPath = path.join(REPO, 'data', 'weibo-schedules.json');
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    ok('产出了 weibo-schedules.json', Array.isArray(out.items));
    ok('抽到了 1 条日程', out.items.length === 1, 'len=' + out.items.length);
    ok('日期正确', out.items[0] && out.items[0].date === '2026-11-13');
    ok('多日区间保留 endDate', out.items[0] && out.items[0].endDate === '2026-11-15');
    ok('场馆保留', out.items[0] && out.items[0].location === '福州海峡奥体中心体育场');
    ok('count 字段正确', out.count === out.items.length);

    // 还原
    if (backup !== null) fs.writeFileSync(rawPath, backup, 'utf8');
    else { try { fs.unlinkSync(rawPath); } catch (e) {} }

    console.log('\n========================================');
    console.log('PASS=' + pass + '  FAIL=' + fail);
    if (fail) {
      console.log('\n失败项:');
      failures.forEach(f => console.log('  - ' + f));
      process.exit(1);
    }
    console.log('ALL GREEN');
  });
}
