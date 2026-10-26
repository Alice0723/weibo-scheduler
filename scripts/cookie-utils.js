/**
 * Cookie 提取工具（共用）
 *
 * 用户从 DevTools 复制出来的东西格式五花八门，这里统一识别：
 *   ① SUB=xxx; SSOLoginState=xxx; ...              ← 直接复制值
 *   ② curl 'https://...' -H 'cookie: SUB=xxx; ...' ← DevTools「复制为 cURL」
 *   ③ Cookie: SUB=xxx; ...                          ← 带前缀
 *   ④ 整段请求头（多行）
 *
 * ⚠️ 微博把 SUB 设成了 HttpOnly，JS 读不到，只能从请求头拿。
 *    少了 SUB= 微博一律返回 432。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} raw 原始文本
 * @returns {string} 抠出来的 Cookie 串（认不出就返回原文，让人自己看）
 */
function extractCookie(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  // ② cURL 命令：优先找 -H 'cookie: ...'，其次 -b '...'
  if (/curl\s/i.test(text)) {
    const h = text.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i)
           || text.match(/--header\s+['"]cookie:\s*([^'"]+)['"]/i);
    if (h) return h[1].trim();
    const b = text.match(/(?:^|\s)-b\s+['"]([^'"]+)['"]/);
    if (b) return b[1].trim();
  }

  // ③ / ④ 带 "cookie:" 前缀的（大小写不敏感）
  const withPrefix = text.match(/cookie:\s*([^\r\n'"]+)/i);
  if (withPrefix) return withPrefix[1].trim();

  // ① 本身就是 cookie 串：必须有 SUB= 才认
  if (/^\s*\S+=/.test(text) && /(^|;\s*)SUB=/.test(text)) {
    return text.replace(/^cookie:\s*/i, '').trim();
  }

  // 兜底：整段里找 SUB= 开始的那一段
  const sub = text.match(/(?:^|[\s'"])(SUB=[^\r\n'"]+)/);
  if (sub) return sub[1].trim();

  return text;
}

/** Cookie 里有没有 SUB（微博要的就是这个） */
function hasSub(cookie) {
  return /(^|;\s*)SUB=/.test(String(cookie || ''));
}

/**
 * 读取 Cookie：先看环境变量，再看项目根目录的 cookie.txt
 *
 * ⚠️ WEIBO_SKIP_COOKIE_FILE=1 可禁用文件回退 ——
 *    测试脚本要用（否则本机存在的 cookie.txt 会让「无 Cookie」用例失效）。
 *
 * @param {string} rootDir 项目根目录
 * @returns {string}
 */
function loadCookie(rootDir) {
  const fromEnv = (process.env.WEIBO_COOKIE || '').trim();
  if (fromEnv) return extractCookie(fromEnv);

  if (process.env.WEIBO_SKIP_COOKIE_FILE === '1') return '';

  try {
    const p = path.join(rootDir, 'cookie.txt');
    if (fs.existsSync(p)) {
      return extractCookie(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) { /* ignore */ }

  return '';
}

module.exports = { extractCookie, hasSub, loadCookie };
