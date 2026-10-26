/**
 * 环境自检（2026-10-26）
 *
 * 目的：workflow 失败时，直接告诉用户「断在哪一环」，
 *      而不是只丢一句 "Process completed with exit code 2"。
 *
 * ⚠️ 为什么要单独成文件：
 *      内联在 YAML 的 run: 里要同时躲 YAML 引号 + JS 引号 + 冒号，
 *      之前内联版本就因为单引号字符串里带冒号导致整个 workflow 解析失败
 *      （GitHub 解析失败的表现是「Actions 里完全看不到这个 workflow」）。
 *      拆成独立文件后，YAML 里只有一行 node 调用，零风险。
 *
 * ⚠️ 安全：只输出长度和布尔判断，**绝不输出 Cookie 内容**。
 */

'use strict';

const c = process.env.WEIBO_COOKIE || '';
const hasSub = /(^|;\s*)SUB=/.test(c);

console.log('--- 环境自检 ---');
console.log('WEIBO_COOKIE 长度: ' + c.length);
console.log('是否包含 SUB=: ' + (hasSub ? '是' : '否'));

const LLM_KEYS = ['LLM_API_KEY', 'ZHIPUAI_API_KEY', 'SILICONFLOW_API_KEY', 'DASHSCOPE_API_KEY'];
const found = LLM_KEYS.filter((k) => process.env[k]);
console.log('可用的 LLM Key: ' + (found.length ? found.join(', ') : '无'));
console.log('---');

let failed = false;

if (!c) {
  console.log('');
  console.log('[X] Secret 没读到。检查:');
  console.log('    1. 名称必须是 WEIBO_COOKIE (全大写, 下划线分隔)');
  console.log('    2. 要配在 Repository secrets, 不是 Environment secrets');
  console.log('    3. 配好 Secret 后必须重新触发一次 workflow');
  console.log('       已经在跑的 run 拿不到新加的 Secret');
  failed = true;
} else if (!hasSub) {
  console.log('');
  console.log('[X] Cookie 里没有 SUB= —— 微博会返回 432。');
  console.log('    微博把 SUB 设成了 HttpOnly, 只能从 DevTools 的网络面板请求标头里复制。');
  failed = true;
}

if (!found.length) {
  console.log('');
  console.log('[X] 没配 LLM Key, 无法抽取日程。');
  console.log('    推荐 ZHIPUAI_API_KEY (智谱 GLM-4-Flash 永久免费不限量):');
  console.log('    https://open.bigmodel.cn -> API Keys -> 创建 -> 复制 key');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('');
console.log('[OK] 环境就绪');
