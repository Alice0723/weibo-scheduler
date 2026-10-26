/**
 * Cookie 格式识别验证（2026-10-26）
 *
 * 用户从 DevTools 复制出来的东西格式五花八门，
 * 脚本必须都能认出来，不能让人卡在「到底复制哪一段」。
 */
'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
function group(t) { console.log('\n=== ' + t + ' ==='); }

// 直接测真模块（不是复刻），保证改代码后测试依然有效
const { extractCookie, hasSub } = require('./cookie-utils');

const REAL = 'SUB=abc123XYZ; SSOLoginState=1730000000; SCF=Ab12Cd34; MWEIBOCN_FROM=111';

group('格式 ①：直接复制 Cookie 值');
{
  const r = extractCookie(REAL);
  ok('原样保留', r === REAL, r);
  ok('含 SUB', /(^|;\s*)SUB=/.test(r));
}

group('格式 ②：DevTools「复制为 cURL (bash)」');
{
  const curl = `curl 'https://m.weibo.cn/api/container/getIndex?type=uid&value=5523180767' \\
  -H 'accept: application/json' \\
  -H 'cookie: ${REAL}' \\
  -H 'referer: https://m.weibo.cn/u/5523180767' \\
  -H 'user-agent: Mozilla/5.0'`;
  const r = extractCookie(curl);
  ok('从 cURL 里抠出 cookie', r === REAL, r);
  ok('不含 curl 前缀', !r.startsWith('curl'));
}

group('格式 ③：带 "Cookie:" 前缀');
{
  const r = extractCookie('Cookie: ' + REAL);
  ok('去掉前缀', r === REAL, r);
  ok('大小写不敏感', extractCookie('cookie: ' + REAL) === REAL);
  ok('冒号后无空格也行', extractCookie('Cookie:' + REAL) === REAL);
}

group('格式 ④：整段请求头（多行）');
{
  const headers = `accept: application/json
accept-encoding: gzip, deflate
cookie: ${REAL}
referer: https://m.weibo.cn/u/5523180767
user-agent: Mozilla/5.0`;
  const r = extractCookie(headers);
  ok('只取 Cookie 那一行', r === REAL, r);
  ok('不含其它请求头', !r.includes('user-agent'), r);
}

group('格式 ⑤：cURL 用 -b 参数');
{
  const curl = `curl 'https://m.weibo.cn/x' -b '${REAL}' -H 'accept: */*'`;
  const r = extractCookie(curl);
  ok('-b 也能认', r === REAL, r);
}

group('格式 ⑥：末尾兜底（前面有别的内容）');
{
  const messy = `Cookie:
${REAL}`;
  const r = extractCookie(messy);
  ok('换行后仍能找到', r === REAL, r);
}

group('边界情况');
{
  ok('空输入返回空', extractCookie('') === '');
  ok('null 不炸', extractCookie(null) === '');
  ok('undefined 不炸', extractCookie(undefined) === '');
  ok('不含 SUB 时不瞎猜（返回原文让人自己看）',
     extractCookie('accept: application/json') === 'accept: application/json');
  ok('cURL 里 cookie 用双引号也能认', (() => {
    const c = `curl 'https://x' -H "cookie: ${REAL}"`;
    return extractCookie(c) === REAL;
  })());
  ok('cURL 里 cookie 单独一行（行尾换行）', (() => {
    const c = `curl 'https://x' \\\n  -H 'cookie: ${REAL}' \\\n  -H 'x: y'`;
    return extractCookie(c) === REAL;
  })());
}

group('SUB 存在性判断（脚本据此决定能不能用）');
{
  ok('识别出 SUB', hasSub(extractCookie(REAL)));
  ok('没有 SUB 时判为 false', !hasSub(extractCookie('SSOLoginState=1; SCF=2')));
  ok('cURL 里也能识别出 SUB', hasSub(extractCookie(`curl 'x' -H 'cookie: ${REAL}'`)));
}

console.log('\n========================================');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL GREEN');
