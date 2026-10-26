/**
 * LLM 通道与分批逻辑验证（2026-10-26）
 *
 * 覆盖 extract-schedules.js 里的关键部分：
 *   1. 通道选择：LLM_API_KEY 优先，然后智谱 / 硅基流动 / 阿里云百炼
 *      （⚠️ GitHub Models 已于 2026-07-30 下线，不再是通道）
 *   2. 分批：既要受条数上限约束，也要受字符预算约束
 *      （免费通道单次输入上限通常 8K token，提示词就占掉一大半，
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
// ⚠️ GitHub Models 已于 2026-07-30 下线，测试同步更新
// ============================================================
function pickChannel(env) {
  const LLM_API_KEY = (env.LLM_API_KEY || '').trim();
  const ZHIPUAI_API_KEY = (env.ZHIPUAI_API_KEY || '').trim();
  const SILICONFLOW_API_KEY = (env.SILICONFLOW_API_KEY || '').trim();
  const DASHSCOPE_API_KEY = (env.DASHSCOPE_API_KEY || '').trim();

  if (LLM_API_KEY) {
    return {
      name: '自定义 API',
      baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
      model: env.LLM_MODEL || 'deepseek-chat',
      token: LLM_API_KEY,
      charBudget: Number(env.LLM_CHAR_BUDGET || 12000),
      maxTokens: 4000
    };
  }
  if (ZHIPUAI_API_KEY) {
    return {
      name: '智谱',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: env.LLM_MODEL || 'glm-4-flash',
      token: ZHIPUAI_API_KEY,
      charBudget: Number(env.LLM_CHAR_BUDGET || 12000),
      maxTokens: 3000
    };
  }
  if (SILICONFLOW_API_KEY) {
    return {
      name: '硅基流动',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: env.LLM_MODEL || 'Qwen/Qwen2.5-7B-Instruct',
      token: SILICONFLOW_API_KEY,
      charBudget: Number(env.LLM_CHAR_BUDGET || 8000),
      maxTokens: 3000
    };
  }
  if (DASHSCOPE_API_KEY) {
    return {
      name: '阿里云百炼',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: env.LLM_MODEL || 'qwen-plus',
      token: DASHSCOPE_API_KEY,
      charBudget: Number(env.LLM_CHAR_BUDGET || 12000),
      maxTokens: 3000
    };
  }
  return null;
}

group('通道选择：优先级');
{
  const all = pickChannel({ LLM_API_KEY: 'sk-xxx', ZHIPUAI_API_KEY: 'z-xxx', SILICONFLOW_API_KEY: 's-xxx' });
  ok('多个都有时优先用自定义 LLM_API_KEY', all.baseUrl.includes('deepseek'), all.baseUrl);

  const zh = pickChannel({ ZHIPUAI_API_KEY: 'z-xxx' });
  ok('只有智谱 key 时走智谱', zh.baseUrl === 'https://open.bigmodel.cn/api/paas/v4', zh.baseUrl);
  ok('智谱默认模型是免费不限量的 glm-4-flash', zh.model === 'glm-4-flash', zh.model);
  ok('智谱用的是自己的 key', zh.token === 'z-xxx');

  const sf = pickChannel({ SILICONFLOW_API_KEY: 's-xxx' });
  ok('只有硅基流动 key 时走硅基流动', sf.baseUrl === 'https://api.siliconflow.cn/v1', sf.baseUrl);

  const ds = pickChannel({ DASHSCOPE_API_KEY: 'd-xxx' });
  ok('只有百炼 key 时走百炼', ds.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1', ds.baseUrl);

  const none = pickChannel({});
  ok('一个都没有时不调 LLM（脚本会退出报错）', none === null);

  const gh = pickChannel({ GITHUB_TOKEN: 'ghs_yyy' });
  ok('⚠️ GITHUB_TOKEN 不再被当作 LLM 通道（GitHub Models 已下线）', gh === null);

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

  // 最小字符预算（硅基流动免费模型 8000 字预算）：100 条 1000 字的长文也必须被切开
  const veryLong = Array.from({ length: 100 }, (_, i) => ({ content: 'y'.repeat(1000) }));
  const b2 = makeBatches(veryLong, 15, 8000);
  ok('小预算下每批字符数不超 8000', b2.every(b =>
     b.reduce((s, p) => s + p.content.length + 60, 0) <= 8000),
     JSON.stringify(b2.map(b => b.reduce((s, p) => s + p.content.length + 60, 0))));
  // 100 条 × 1060 字 = 106000 字，÷8000 → 至少要 14 批
  ok('超长文本被切成足够多的批（不挤爆单次请求）', b2.length >= 13, 'batches=' + b2.length);
  ok('所有超长条目都分配到了某一批（不丢数据）',
     b2.reduce((s, b) => s + b.length, 0) === 100,
     'total=' + b2.reduce((s, b) => s + b.length, 0));

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

  // 用临时的输入/输出文件驱动 —— 绝不能碰真实的数据文件！
  // ⚠️ 之前直接写 data/raw-weibo.json 和 data/weibo-schedules.json，
  //    结果每次跑测试都留下一个假的 weibo-schedules.json 待提交，
  //    导致 git push 冲突（而且提交上去的是测试假数据，污染线上）。
  const fs = require('fs');
  const rawPath = path.join(REPO, 'data', 'raw-weibo.json');
  const outPath = path.join(REPO, 'data', 'weibo-schedules.json');

  // 备份真实文件，跑完还原
  const rawBackup = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : null;
  const outBackup = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;

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
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    ok('产出了 weibo-schedules.json', Array.isArray(out.items));
    ok('抽到了 1 条日程', out.items.length === 1, 'len=' + out.items.length);
    ok('日期正确', out.items[0] && out.items[0].date === '2026-11-13');
    ok('多日区间保留 endDate', out.items[0] && out.items[0].endDate === '2026-11-15');
    ok('场馆保留', out.items[0] && out.items[0].location === '福州海峡奥体中心体育场');
    ok('count 字段正确', out.count === out.items.length);

    // ⚠️ 还原两个文件（不还原的话测试假数据会留在仓库里，
    //    既是 git 冲突源，也会污染线上小程序读到的数据）
    if (rawBackup !== null) fs.writeFileSync(rawPath, rawBackup, 'utf8');
    else { try { fs.unlinkSync(rawPath); } catch (e) {} }
    if (outBackup !== null) fs.writeFileSync(outPath, outBackup, 'utf8');
    else { try { fs.unlinkSync(outPath); } catch (e) {} }

    // 防污染自检：还原后文件必须与备份完全一致
    ok('输出文件已还原（没留下测试假数据）', (() => {
      if (outBackup === null) return !fs.existsSync(outPath);
      return fs.readFileSync(outPath, 'utf8') === outBackup;
    })());
    ok('输入文件已还原', (() => {
      if (rawBackup === null) return !fs.existsSync(rawPath);
      return fs.readFileSync(rawPath, 'utf8') === rawBackup;
    })());

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
