/**
 * 本地真实试跑（2026-10-26 新增）
 *
 * 目的：让你在搞 GitHub 之前，先花 30 秒确认「微博到底能不能抓到」。
 *
 * 用法（Windows Git Bash）：
 *   WEIBO_COOKIE="你的cookie" node scripts/try-local.js
 *
 * 会做三件事：
 *   1. 检查 Cookie 格式（有没有 SUB）
 *   2. 真的去微博抓一次，打印每个源抓了几条、抓到的正文前 80 字
 *   3. 打印抓到的条目里的日期线索，人工扫一眼对不对
 *
 * ⚠️ 抓不到时的常见原因：
 *   · Cookie 里没有 SUB      → 微博一律 432
 *   · Cookie 过期            → 微博返回 ok=-100
 *   · 复制少了（只复制了一部分）→ 重新复制完整 Cookie
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_FILE = path.join(ROOT, 'data', 'raw-weibo.json');

const COOKIE = (process.env.WEIBO_COOKIE || '').trim() || readCookieFile();

/**
 * Cookie 也可以放在仓库根目录的 cookie.txt 里（已被 .gitignore 排除）。
 *
 * 为什么不只靠环境变量：
 *   · PowerShell 里 `FOO=bar node x.js` 这种写法**不生效**（那是 bash 语法）
 *     → 必须写成 $env:FOO="bar"; node x.js，用错会直接白跑一趟
 *   · 把 Cookie 粘进命令行会留在 PowerShell 历史记录里 → 落到文件更安全
 */
function readCookieFile() {
  try {
    const p = path.join(ROOT, 'cookie.txt');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}

function line(s) { console.log(s); }

async function main() {
  line('========================================');
  line(' 微博日程 · 本地试跑');
  line('========================================');

  // ===== 1. Cookie 检查 =====
  line('\n[1/3] 检查 Cookie');
  if (!COOKIE) {
    line('  ✗ 没有找到 Cookie');
    line('');
    line('  【怎么拿 Cookie】');
    line('    1. 浏览器登录微博（小号也行，能看到这三个号的动态就够）');
    line('    2. 打开 https://m.weibo.cn/u/5523180767');
    line('    3. F12 → Network 面板 → 点任意一个请求 → Request Headers');
    line('    4. 复制 Cookie 那一整行（形如 SUB=xxx; SSOLoginState=xxx; ...）');
    line('');
    line('  【放哪里 —— 二选一】');
    line('');
    line('  方式 A（推荐，PowerShell / Git Bash 都能用）：');
    line('    把 Cookie 存成这个文件：');
    line('      ' + path.join(ROOT, 'cookie.txt'));
    line('    然后直接运行：');
    line('      node scripts\\try-local.js');
    line('    （cookie.txt 已在 .gitignore 里，不会被提交上去）');
    line('');
    line('  方式 B（临时用一下）：');
    line('    PowerShell：');
    line('      $env:WEIBO_COOKIE="SUB=xxx; ..."');
    line('      node scripts\\try-local.js');
    line('    Git Bash / CMD：');
    line('      WEIBO_COOKIE="SUB=xxx; ..." node scripts/try-local.js');
    line('');
    line('  ⚠️ PowerShell 里不能写 WEIBO_COOKIE="..." node xxx.js（那是 bash 语法，不生效）');
    process.exit(1);
  }

  const hasSub = /(^|;\s*)SUB=/.test(COOKIE);
  line('  Cookie 长度：' + COOKIE.length + ' 字符');
  if (hasSub) {
    line('  ✓ 包含 SUB（这是最关键的一项）');
  } else {
    line('  ✗ 没有 SUB —— 微博会直接返回 432，必抓不到');
    line('    请重新复制完整的 Cookie，别只复制一半');
    process.exit(1);
  }
  if (/SSOLoginState/.test(COOKIE)) line('  ✓ 包含 SSOLoginState');
  else line('  ! 没有 SSOLoginState（可能有影响，建议补上）');

  // ===== 2. 抓取 =====
  line('\n[2/3] 正在抓取微博（可能需要 20-40 秒）...');
  line('');

  const child = spawn('node', [path.join(__dirname, 'fetch-weibo.js')], {
    env: { ...process.env, WEIBO_COOKIE: COOKIE },
    cwd: ROOT
  });
  let stdout = '', stderr = '';
  // ⚠️ 必须显式指定 utf8：Windows PowerShell 5.1 默认按 GBK 解码子进程输出，
  // 不指定的话中文日志全是乱码（父进程自己 console.log 的部分不受影响）。
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const code = await new Promise((resolve) => child.on('close', resolve));

  // ===== 3. 结果解读 =====
  line('\n[3/3] 结果');
  if (!fs.existsSync(RAW_FILE)) {
    line('  ✗ 没有生成 data/raw-weibo.json');
    line(stderr.slice(0, 500));
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const items = data.items || [];

  if (items.length === 0) {
    line('  ✗ 一条都没抓到（退出码 ' + code + '）');
    line('');
    line('  排错：');
    line('   · 微博返回 432 → Cookie 缺 SUB 或已失效，重新复制');
    line('   · 微博返回 ok=-100 → Cookie 过期了，重新登录再复制');
    line('   · 超时/网络 → 检查网络代理');
    line('');
    line('  完整日志：');
    line(stdout.slice(-1500));
    process.exit(1);
  }

  line('  ✓ 共抓到 ' + items.length + ' 条（本次新抓 ' + data.freshCount + ' 条）');
  line('');

  // 按源统计
  const bySource = {};
  items.forEach(it => {
    bySource[it.sourceName] = bySource[it.sourceName] || { n: 0, newest: 0 };
    bySource[it.sourceName].n++;
    bySource[it.sourceName].newest = Math.max(bySource[it.sourceName].newest, it.pubTs || 0);
  });
  Object.keys(bySource).forEach(name => {
    const s = bySource[name];
    const d = s.newest ? new Date(s.newest).toLocaleString('zh-CN') : '未知';
    line('  · ' + name + '：' + s.n + ' 条，最新一条 ' + d);
  });

  // 打印有日期线索的条目，人工确认
  line('');
  line('  看起来像日程的条目（人工确认一下对不对）：');
  const withDate = items.filter(it =>
    /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年|\d{1,2}\/\d{1,2}|开售|开票|预售|上线|发行|演出|官宣/.test(it.content || '')
  );
  if (withDate.length === 0) {
    line('  （没有明显的日期线索 —— 可能这几个号最近确实没发日程相关的内容）');
  } else {
    withDate.slice(0, 8).forEach(it => {
      const d = it.published ? it.published.slice(0, 16).replace('T', ' ') : '?';
      line('    [' + d + '] ' + String(it.content).slice(0, 90));
    });
    if (withDate.length > 8) line('    ... 还有 ' + (withDate.length - 8) + ' 条');
  }

  line('');
  line('========================================');
  line(' 抓取正常。下一步：');
  line('   1. 把这个 Cookie 存进 GitHub 仓库的 Secret（名字：WEIBO_COOKIE）');
  line('   2. 触发一次 Actions，确认 data/weibo-schedules.json 有内容');
  line('   3. 在小程序 utils/serverApi.js 里填上仓库地址');
  line('========================================');
}

main().catch((e) => {
  console.error('[try-local] fatal:', e);
  process.exit(1);
});
