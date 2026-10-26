/**
 * workflow YAML 校验（2026-10-26 新增）
 *
 * ⚠️ 为什么必须有这个：
 *   GitHub 解析 workflow YAML 失败时，**不会报错提示**，
 *   表现是「Actions 里完全看不到这个 workflow」（No workflows found）。
 *   排查这个现象极费时间 —— 曾因为内联 JS 的单引号串里带冒号
 *   （'否  ← 问题在这'）导致整份 YAML 解析失败。
 *
 *   所以：**改完 workflow 一定要跑这个脚本。**
 *
 * 依赖：python3 + pyyaml。若没有 pyyaml，脚本会跳过（不算失败）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function skipTest(name, why) { skip++; console.log('  SKIP  ' + name + (why ? ' (' + why + ')' : '')); }
function group(t) { console.log('\n=== ' + t + ' ==='); }

const REPO = path.resolve(__dirname, '..');
const WF_DIR = path.join(REPO, '.github', 'workflows');

console.log('\n=== workflow YAML 校验 ===');

if (!fs.existsSync(WF_DIR)) {
  console.log('  没有 .github/workflows 目录，跳过');
  process.exit(0);
}

const wfFiles = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
ok('至少有一个 workflow 文件', wfFiles.length > 0, 'files=' + wfFiles.length);

// ===== YAML 能否被解析 =====
let yamlAvailable = true;
try {
  execFileSync('python', ['-c', 'import yaml'], { stdio: 'ignore' });
} catch (e) {
  yamlAvailable = false;
}

const parsed = {};
wfFiles.forEach((f) => {
  const p = path.join(WF_DIR, f);
  if (!yamlAvailable) { skipTest('解析 ' + f, '没有 pyyaml'); return; }

  const script = `
import yaml, io, json, sys
try:
    d = yaml.safe_load(io.open(sys.argv[1], encoding='utf-8').read())
    # on: 在 YAML 1.1 里会被解析成布尔 True，两个键都取
    trig = d.get('on') or d.get(True) or {}
    out = {
        'ok': True,
        'name': d.get('name', ''),
        'triggers': list(trig.keys()) if isinstance(trig, dict) else [],
        'permissions': list((d.get('permissions') or {}).keys()),
        'jobs': {k: len(v.get('steps', [])) for k, v in (d.get('jobs') or {}).items()},
        'steps': [s.get('name', '') for j in (d.get('jobs') or {}).values() for s in j.get('steps', [])]
    }
    print(json.dumps(out, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
`;
  try {
    const out = execFileSync('python', ['-c', script, p], { encoding: 'utf8' });
    const r = JSON.parse(out.trim());
    ok('解析 ' + f, r.ok === true, r.error);
    if (r.ok) parsed[f] = r;
  } catch (e) {
    ok('解析 ' + f, false, e.message);
  }
});

// ===== 内容断言 =====
const main = parsed['fetch-weibo.yml'];
if (main) {
  group('fetch-weibo.yml 内容');

  ok('有名字', !!main.name, main.name);
  ok('有定时触发', main.triggers.includes('schedule'), JSON.stringify(main.triggers));
  ok('有手动触发', main.triggers.includes('workflow_dispatch'), JSON.stringify(main.triggers));
  ok('有 contents: write 权限（要提交数据回仓库）',
     main.permissions.includes('contents'), JSON.stringify(main.permissions));
  ok('有一个 job', Object.keys(main.jobs).length === 1, JSON.stringify(Object.keys(main.jobs)));

  const steps = main.steps;
  ok('有「检出代码」', steps.some((s) => s.includes('检出')), JSON.stringify(steps));
  ok('有「环境自检」', steps.some((s) => s.includes('环境自检')), JSON.stringify(steps));
  ok('有「抓取微博动态」', steps.some((s) => s.includes('抓取微博动态')), JSON.stringify(steps));
  ok('有「LLM 抽取日程」', steps.some((s) => s.includes('LLM 抽取')), JSON.stringify(steps));
  ok('有「提交结果」', steps.some((s) => s.includes('提交结果')), JSON.stringify(steps));
}

// ===== 内联 JS 的雷 =====
group('内联 JS 检查（YAML 解析失败的常见原因）');
wfFiles.forEach((f) => {
  const src = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
  // run: 后面直接跟 node -e "..." 的写法 → 里面任何引号/冒号都可能炸
  const inlineJs = /run:\s*.*node\s+-e\s+"/.test(src);
  ok(f + ' 没有内联 node -e（避免引号/冒号炸 YAML）', !inlineJs,
     '内联 JS 极易踩 YAML 坑，请拆成独立 .js 文件');
});

// ===== 引用的脚本必须存在 =====
group('workflow 引用的脚本必须存在');
wfFiles.forEach((f) => {
  const src = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
  const refs = [...src.matchAll(/node\s+(scripts\/[\w.-]+)/g)].map((m) => m[1]);
  refs.forEach((r) => {
    ok(f + ' 引用的 ' + r + ' 存在', fs.existsSync(path.join(REPO, r)));
  });
});

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail + (skip ? '  SKIP=' + skip : ''));
if (fail) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  console.log('\n⚠️ GitHub 解析 workflow 失败时不会提示，只会「看不到这个 workflow」。');
  console.log('   改完 workflow 一定要跑这个脚本。');
  process.exit(1);
}
console.log('ALL GREEN');
