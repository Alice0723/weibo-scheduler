# weibo-scheduler · 微博自动日程

从三个微博账号自动抓取动态，抽出日程条目，生成 `data/weibo-schedules.json`，
供「Silence with You」小程序直接读取。**你的服务器全程不参与。**

需要 2 个 Secret：微博 Cookie + 一个大模型 API Key（智谱 GLM-4-Flash 永久免费不限量）。

---

## 它是怎么跑的

```
GitHub Actions（每天 10:17）
  └─ node scripts/fetch-weibo.js
      └─ 直连 m.weibo.cn 的 container/getIndex 接口（带 Cookie）
          → data/raw-weibo.json
              └─ node scripts/extract-schedules.js
                  └─ LLM 抽取（智谱免费 / DeepSeek / 硅基流动 / 通义）
                      → data/weibo-schedules.json
                          └─ 自动提交回仓库
                              └─ 小程序读 raw.githubusercontent.com（5 镜像回退 + 本地缓存）
```

不需要 Docker、不需要 RSSHub、不需要 Chromium、不需要 Redis、不需要你的服务器。

---

## 部署步骤

### 第 0 步：本地先试一次（强烈建议，30 秒）

先确认微博到底能不能抓到，再折腾 GitHub。

**1. 拿 Cookie**

1. 浏览器登录微博（**小号也行**，只要能看到这三个号的动态就可以）
2. 地址栏打开 `https://m.weibo.cn/u/5523180767`
3. 按 `F12` → 切到 **「网络」** 标签 → **按 F5 刷新页面**
4. 在左边请求列表里点一条**名字带 `getIndex`** 的请求
   （也可以在筛选框输入 `getIndex`，只看匹配的）
5. 右边出现 **请求标头 → 请求方法**，下面有一条 **`Cookie:`**
6. **右键那一行 → 复制值**

> ⚠️ **必须有 `SUB=` 这一段**，否则微博一律返回 432，什么都抓不到。
> 微博把 SUB 设成了 HttpOnly，JS 读不到，**只能从请求头里复制**。

> ⚠️ **看到「显示的是预检标头」就点错请求了** ——
> 那是 CORS 预检（OPTIONS）请求，**预检不带 Cookie**。
> 解决：筛选框输入 `getIndex`，点类型是 `fetch`/`xhr` 的那条，不是「预检」。

**2. 试跑**

把复制到的东西粘进 `weibo-scheduler/cookie.txt`（脚本能自动认出各种格式）：

| 你复制到的 | 脚本认不认 |
|---|---|
| `SUB=xxx; SSOLoginState=xxx; ...` | ✓ |
| `Cookie: SUB=xxx; ...` | ✓ |
| `curl "..." -H "cookie: SUB=xxx; ..."`（DevTools「复制为 cURL」） | ✓ |
| 整段请求头（多行） | ✓ |

然后在项目目录下执行（PowerShell / Git Bash 都行）：

```bash
node scripts/try-local.js
```

PowerShell 用户也可以直接跑 `.\try-local.ps1`（会自动处理中文乱码）。

成功的话会看到：

```
[3/3] 结果
  ✓ 共抓到 47 条（本次新抓 47 条）

  · 汪苏泷：20 条，最新一条 2026/10/26 20:14
  · 汪苏泷Studio：15 条，最新一条 2026/10/26 19:02
  · SilenceRadio0917：12 条，最新一条 2026/10/26 18:30

  看起来像日程的条目（人工确认一下对不对）：
    [2026-10-26 19:00] 汪苏泷2026「明日世界」世界巡回演唱会福州站正式官宣 演出时间 2026年11月13日-15日...
```

**如果抓不到**，脚本会直接告诉你原因（Cookie 缺 SUB / 过期 / 网络问题），按提示处理即可。
**本地能抓到，后面就一定能抓到。**

---

### 第 1 步：建仓库

在 GitHub 新建一个**公开**仓库（小程序要能匿名读 raw 文件），名字随意，例如 `weibo-scheduler`。

把本目录的全部内容推上去：

```bash
cd weibo-scheduler
git init
git add .
git commit -m "init: 微博日程抓取"
git remote add origin https://github.com/你的用户名/weibo-scheduler.git
git push -u origin main
```

> 公开仓库的 Actions 是**免费**的（私有仓库每月也有 2000 分钟免费额度）。

---

### 第 2 步：配 Secret（只要一个）

仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| 名称 | 必填 | 说明 |
|---|---|---|
| `WEIBO_COOKIE` | ✅ | 第 0 步复制的 Cookie 全文 |
| `WEIBO_RADIO_UID` | 一般不用 | @SilenceRadio0917 的数字 UID（脚本能自动解析，解析失败才需要填） |
| `ZHIPUAI_API_KEY` | ✅ 建议 | **智谱 GLM-4-Flash 永久免费不限量**，国内直连不用绑卡。注册 https://open.bigmodel.cn → API Keys → 创建 |
| `LLM_API_KEY` | 二选一 | 任意 OpenAI 兼容接口（DeepSeek / 硅基流动 / 通义…）。DeepSeek 新用户送 10 元 |
| `SILICONFLOW_API_KEY` | 二选一 | 硅基流动，送 14 元 + 多个模型永久免费 |
| `DASHSCOPE_API_KEY` | 二选一 | 阿里云百炼通义，100 万 token 额度 |

---

### 第 3 步：跑一次

**Actions** 标签 → **微博日程抓取** → 右边 **Run workflow** → 手动触发一次。

跑完后仓库里会出现 `data/weibo-schedules.json`，内容长这样：

```json
{
  "updatedAt": "2026-10-26T11:17:23.000Z",
  "count": 3,
  "items": [
    {
      "date": "2026-11-13",
      "endDate": "2026-11-15",
      "name": "明日世界巡回演唱会 福州站",
      "type": "concert",
      "location": "福州海峡奥体中心体育场",
      "songs": [],
      "confidence": 0.95
    }
  ]
}
```

打开这个文件看一眼，确认内容是你想要的。**这一步是最后一道人工校验**——
自动抽取难免有误差，发现不对就调整提示词或直接删掉这条，下一次抓取会重新生成。

---

### 第 4 步：接进小程序

编辑 `miniprogram-1/utils/serverApi.js`，找到这两行：

```js
const WEIBO_SCHEDULE_REPO = {
  owner: 'YOUR_GITHUB_USER',
  repo: 'weibo-scheduler'
};
```

改成你的：

```js
const WEIBO_SCHEDULE_REPO = {
  owner: '你的GitHub用户名',
  repo: 'weibo-scheduler'
};
```

改完用微信开发者工具上传发版即可。

> **没填这个值时该数据源会自动跳过**，小程序完全不受影响。
> 日历里现有的演唱会/音乐节照常显示，只是不会多出微博抓来的条目。

---

## 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| Actions 标红，日志说 432 | Cookie 缺 `SUB` 或已失效 | 重新登录微博，重新复制完整 Cookie 更新 Secret |
| DevTools 里找不到 Cookie | 点成了「预检」请求 | 预检（OPTIONS）不带 Cookie，改点 `getIndex` 那条 |
| `document.cookie` 里没有 SUB | 微博把 SUB 设成 HttpOnly | 只能从 DevTools「网络 → 请求标头」复制 |
| Actions 标红，日志说 `ok=-100` | Cookie 过期 | 同上 |
| Actions 标红，LLM 报 401 | 没配 API Key 或 Key 无效 | 配 `ZHIPUAI_API_KEY`（智谱免费）。日志里的「环境自检」会直接告诉你是哪一环 |
| Actions 标红，LLM 报 400 token 超限 | 微博正文太长 | 调小 `scripts/extract-schedules.js` 顶部的 `LLM_CHAR_BUDGET` |
| 日历里没有微博条目 | 仓库地址没填 / 填错 | 检查 `utils/serverApi.js` 的 `WEIBO_SCHEDULE_REPO` |
| 日历里条目重复了 | 抽取时同一件事被抽了两次 | 脚本已按 `类型+日期+名称` 去重，若仍有重复请反馈 |
| 日历里出现了去年的旧活动 | 抽取误判 | 直接在日历里点「隐藏」（只影响你自己，不影响别人） |

**Cookie 多久过期一次？** 大约 1-3 个月。过期后按第 0 步重新复制一次更新 Secret 就行。

---

## 调参

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEIBO_LIMIT` | 30 | 每个账号抓多少条（Actions 里可临时改） |
| `MAX_ITEMS_PER_SOURCE` | 60 | 每个账号最多保留多少条 |
| `MAX_POSTS` | 200 | 最多送多少条进 LLM（控成本） |
| `LLM_BATCH_SIZE` | 15 | 每次 LLM 请求塞多少条 |
| `LLM_CHAR_BUDGET` | 12000 / 8000 | 每批正文字符预算（硅基流动免费模型自动降到 8000） |
| `WEIBO_MAX_PAGES` | 4 | 每个账号翻几页 |

改长期默认值 → 编辑 `scripts/fetch-weibo.js` / `scripts/extract-schedules.js` 顶部。
想省钱 → 把 workflow 的 `schedule` 改成每两天一次（`cron: '17 10 */2 * *'`）。

---

## 误判防护

自动抽取最大的风险是「把老微博里的去年日期当成未来的日程」。已做四层防护：

1. **预筛**：正文不含日期线索、或含「抽奖/转发/直播回放」等噪音词 → 根本不会送进 LLM
   （噪音词**优先**判断：否则「直播回放已上线」会因为含「上线」被误判成日程）
2. **提示词约束**：明确要求「只抽未来事件」「多日连演输出区间而非拆条」「不要编造」
3. **程序化校验**：日期必须合法且在未来、一年内；`endDate` 不得早于 `date`；type 必须在白名单；confidence < 0.55 直接丢弃
4. **去重**：同 `类型+日期+名称` 合并，保留置信度最高的

另外：微博正文为空时**绝不回退到 title**（微博的 title 是「汪苏泷的微博」这种占位标题，回退会塞一堆无意义条目）。

---

## 目录

```
scripts/
  fetch-weibo.js        抓取（直连 m.weibo.cn）
  extract-schedules.js  LLM 抽取 + 校验 + 去重（OFFLINE=1 可离线预览预筛结果）
  cookie-utils.js       Cookie 格式识别（多种复制格式都能认）
  try-local.js          本地试跑（配 GitHub 之前先验证 Cookie）
  verify-fetch.js       抓取逻辑验证
  verify-extract.js     抽取逻辑验证
  verify-llm.js         LLM 通道与分批验证
  verify-cookie.js      Cookie 格式识别验证
  verify-real.js        真实数据抽取质量验证（需先跑一次 fetch-weibo）
  verify-e2e.js         端到端管道验证
  verify-miniprogram.js 小程序侧接入验证
try-local.ps1           Windows 一键试跑（自动处理编码）
data/
  raw-weibo.json        原始动态（自动生成，不进版本库）
  weibo-schedules.json  最终日程（自动生成，小程序读这个）
cookie.txt              本地放 Cookie（自动 gitignore，别提交）
.github/workflows/
  fetch-weibo.yml       定时任务
```

跑全部验证：

```bash
node scripts/verify-fetch.js && node scripts/verify-extract.js && \
node scripts/verify-llm.js && node scripts/verify-cookie.js && \
node scripts/verify-e2e.js && node scripts/verify-miniprogram.js && \
node scripts/verify-real.js
```

> `verify-real.js` 需要 `data/raw-weibo.json`（先跑一次 `fetch-weibo.js`），
> 没有真实数据时会自动跳过。

---

## 已实测确认的行为（2026-10-26 用真实 Cookie 跑通）

| 项 | 结论 |
|---|---|
| @汪苏泷 | UID = **1625646585**（不是 1004061625646585，那个多了 100 前缀） |
| @汪苏泷Studio | UID = 5523180767 ✓ |
| @SilenceRadio0917 | **搜不到、主页 404** → 该号可能已改名或注销，默认关闭；配 `WEIBO_RADIO_UID` 可启用 |
| 微博时间字段 | 真实格式是 `Mon Oct 26 12:10:53 +0800 2026`（英文 RFC + 时区），已按此时区解析 |
| 抓取量 | 两个号一次能抓 20+ 条，预筛后剩 3-5 条候选 |
| 预筛效果 | 23 条 → 5 条，现场返场微博（「谢谢青岛」「我们🙅🦑」）全部排除 |
