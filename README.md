# App Review PRD Lab

基于 **Next.js 14 + TypeScript** 构建的 App Store 评论分析工作台。

本项目支持两种数据入口：

1. **实时采集**：从美国区 App Store RSS 采集公开评论；
2. **文件导入**：上传 JSON/CSV 评论数据。

采集或导入的评论会经过本地清洗与去重，随后通过服务端调用阿里云 DashScope 千问模型完成：

- 主题发现（findings）
- 需求推导（requirements）
- PRD Markdown 生成
- 测试用例生成
- 端到端追溯校验

---

## 目录

1. [项目结构](#1-项目结构)
2. [如何本地运行](#2-如何本地运行)
3. [如何配置环境变量](#3-如何配置环境变量)
4. [App Store 评论数据来源和限制](#4-app-store-评论数据来源和限制)
5. [使用的模型、Provider、Prompt、模型配置](#5-使用的模型providerprompt模型配置)
6. [如何减少幻觉](#6-如何减少幻觉)
7. [JSON/CSV 导入格式与样本缓存说明](#7-jsoncsv-导入格式与样本缓存说明)
8. [常见问题排查](#8-常见问题排查)

---

## 1. 项目结构

```
app-review-prd-lab/
├── app/
│   ├── api/
│   │   ├── app-store-reviews/     # App Store RSS 采集接口
│   │   │   └── route.ts           # POST /api/app-store-reviews
│   │   ├── findings/              # 模型主题发现接口
│   │   │   └── route.ts           # POST /api/findings
│   │   └── prd/                   # 模型 PRD 生成接口
│   │       └── route.ts           # POST /api/prd
│   ├── globals.css                # 全局样式
│   ├── layout.tsx                 # 根布局
│   └── page.tsx                   # 前端工作台主页面
├── lib/
│   ├── app-store-reviews.ts       # Apple RSS 采集、App ID 解析、分页逻辑
│   ├── reviews.ts                 # 评论解析、清洗、去重、字段规范化
│   ├── model-findings.ts          # 千问主题发现实现与输出校验
│   ├── model-prd.ts               # 千问 PRD 生成实现与输出校验
│   └── traceability.ts            # review → finding → requirement → test case 追溯校验
├── sample-data/                   # JSON/CSV 导入样本与离线演示缓存
│   ├── README.md                  # 样本数据使用说明
│   ├── offline-reviews.sample.json
│   ├── offline-reviews.sample.csv
│   └── offline-cache.sample.json
├── .env.example                   # 环境变量示例
├── .env.local                     # 本地环境变量（不提交）
├── next.config.js                 # Next.js 配置
├── package.json                   # 依赖与脚本
├── tsconfig.json                  # TypeScript 配置
└── README.md                      # 本文件
```

### 1.1 核心模块职责

| 文件/目录 | 职责 |
| --- | --- |
| `app/api/app-store-reviews/route.ts` | 接收 `appUrl`、`limit`、`maxPages`、`delayMs`，调用 `lib/app-store-reviews.ts` 采集评论 |
| `app/api/findings/route.ts` | 接收 `cleanedReviews` 和 `analysisGoal`，调用 `lib/model-findings.ts` 进行主题发现 |
| `app/api/prd/route.ts` | 接收 `cleanedReviews`、`findings`、`requirements` 等，调用 `lib/model-prd.ts` 生成 PRD |
| `lib/app-store-reviews.ts` | 解析 App ID、构建 RSS URL、分页请求、重试、超时处理 |
| `lib/reviews.ts` | JSON/CSV/RSS 评论解析、字段规范化、空评论过滤、内容指纹去重 |
| `lib/model-findings.ts` | 千问主题发现 Prompt、模型调用、findings 结构化校验 |
| `lib/model-prd.ts` | 千问 PRD 生成 Prompt、模型调用、PRD 结构与追溯校验 |
| `lib/traceability.ts` | 验证 finding/requirement/test case 与 review 之间的引用关系 |
| `app/page.tsx` | 前端工作台 UI、状态管理、Tab 切换、调用上述三个 API |

---

## 2. 如何本地运行

### 2.1 前置依赖

- **Node.js**：18.x 或更高版本（Next.js 14 的最低要求）。
- **npm**：随 Node.js 自带。
- **DashScope API Key**：调用千问模型必需，见第 3 节。
- **网络环境**：
  - 采集评论需访问 `itunes.apple.com`；
  - 调用模型需访问 `dashscope.aliyuncs.com`。

### 2.2 安装与启动

```bash
# 进入项目根目录
cd app-review-prd-lab

# 安装依赖
npm install

# 复制并编辑环境变量
cp .env.example .env.local
# 编辑 .env.local，填入 DASHSCOPE_API_KEY

# 启动开发服务器
npm run dev
```

打开浏览器访问 `http://localhost:3000`。

### 2.3 可用脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务器（需先 build） |
| `npm run typecheck` | TypeScript 类型检查 |

### 2.4 Windows PowerShell 注意事项

PowerShell 不支持 `&&` 连接命令，请使用分号 `;` 或分步执行：

```powershell
npm install; npm run dev
```

---

## 3. 如何配置环境变量

环境变量通过项目根目录的 `.env.local` 管理。Next.js 启动时自动加载，但修改后必须重启 dev server。

### 3.1 必填变量

#### `DASHSCOPE_API_KEY`

你的阿里云 DashScope API Key。

- 获取方式：登录 [DashScope 控制台](https://dashscope.console.aliyun.com/) 创建并复制。
- 示例：
  ```bash
  DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  ```

### 3.2 可选变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QWEN_MODEL` | `qwen-plus` | 模型名称，可改为 `qwen-turbo`、`qwen-max` 等 |
| `QWEN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | DashScope OpenAI 兼容 Base URL |
| `QWEN_PRD_MAX_TOKENS` | 自适应 | PRD 生成最大输出 token，默认按需求数自动估算，范围 1200-16000 |
| `QWEN_REQUEST_TIMEOUT_MS` | `180000` | 千问请求超时时间，范围 10000-180000 |

### 3.3 完整示例

```bash
# .env.local
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
QWEN_MODEL=qwen-plus
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_REQUEST_TIMEOUT_MS=180000
```

### 3.4 排查环境变量未生效

- 确认文件名为 `.env.local`；
- 确认 API Key 无多余空格或换行；
- 修改后必须完全停止并重新启动 dev server；
- 环境变量仅在服务端 API（`app/api/*`）中读取，浏览器前端无法直接访问。

---

## 4. App Store 评论数据来源和限制

### 4.1 数据来源

评论采集由 `lib/app-store-reviews.ts` 实现，请求 Apple 公开的 iTunes Customer Reviews RSS Feed：

```
https://itunes.apple.com/us/rss/customerreviews/page={page}/id={appId}/sortby=mostrecent/json
```

- 固定拉取 **美国区（us）** 评论；
- 按 `mostrecent` 排序；
- 前端通过 `POST /api/app-store-reviews` 触发采集。

### 4.2 采集流程（对应 `lib/app-store-reviews.ts`）

1. 从用户输入的 App Store 链接中解析 App ID（`parseAppStoreAppId`）；
2. 根据用户设置的「采集数量」（默认 100，范围 1-500）循环构建 RSS URL，最多请求 10 页；
3. 每页请求带 `Accept: application/json` 和自定义 User-Agent；
4. 默认 12 秒超时，失败时最多重试 2 次；
5. 每页之间默认等待 600ms，避免触发频率限制；
6. 解析 `feed.entry` 后交给 `lib/reviews.ts` 清洗去重。

### 4.3 数据限制

#### 4.3.1 每页最多 50 条，实际可能更少

Apple RSS 单页上限为 50 条，但实际返回数量取决于该 App 在美国区当前可用的最新评论数。因此设置 3 页不代表固定 150 条。

#### 4.3.2 只包含公开评论

RSS 仅返回 App Store 上公开可见的评论，不包含已删除、被隐藏、开发者回复或纯评分无文字的评论。

#### 4.3.3 RSS 缓存与延迟

Apple RSS 数据非实时同步，新评论可能需要数小时才会出现在 Feed 中。

#### 4.3.4 网络可达性

采集需要访问 `itunes.apple.com`。若网络受限（防火墙、DNS、代理），可能导致超时或返回空数据。

### 4.4 清洗与去重（对应 `lib/reviews.ts`）

| 步骤 | 说明 |
| --- | --- |
| 字段解析 | 从 RSS entry 提取 `id`、`title`、`content`、`im:rating`、`im:version`、`updated`、`author/name` |
| 规范化 | 评分截断到 0-5；版本去除 `version` / `v` 前缀；日期转 ISO 8601；文本去首尾空白和空字符 |
| 空评论过滤 | `title` 和 `body` 均为空则丢弃 |
| 去重 | 基于 `reviewId`/`externalId` 和内容指纹（标题、正文、评分、版本、时间、作者、国家）去重 |

界面会展示：原始 X 条 · 清洗 Y 条 · 删除空评论 Z 条 · 去重 W 条。

---

## 5. 使用的模型、Provider、Prompt、模型配置

### 5.1 Provider 与模型

| 项目 | 默认值 |
| --- | --- |
| Provider | 阿里云 DashScope（OpenAI 兼容接口） |
| 模型 | `qwen-plus` |
| Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 调用接口 | `/chat/completions` |

可通过环境变量覆盖模型与 Base URL。

### 5.2 两阶段模型调用

| 阶段 | 入口 | 实现文件 | 用途 |
| --- | --- | --- | --- |
| 主题发现 | `POST /api/findings` | `lib/model-findings.ts` | 从清洗后的评论中归纳 findings |
| PRD 生成 | `POST /api/prd` | `lib/model-prd.ts` | 基于 findings/requirements 生成 PRD Markdown |

### 5.3 主题发现输出字段（`lib/model-findings.ts`）

```ts
{
  findingId: string;          // 主题唯一编号
  title: string;              // 主题标题
  summary: string;            // 主题摘要
  severity: "critical" | "high" | "medium" | "low";
  confidence: number;         // 0-1
  supportingReviewIds: string[];
  evidenceQuotes: { reviewId: string; quote: string }[];
  contradictionReviewIds: string[];
  uncertainty: string;
}
```

### 5.4 Prompt 设计

#### 5.4.1 主题发现 Prompt（`lib/model-findings.ts`）

核心约束：

- 只能使用输入评论中真实存在的 `reviewId`；
- `evidenceQuotes.quote` 必须逐字来自对应评论原文；
- 证据不足或存在推断时，必须在 `uncertainty` 中说明；
- 输出必须是合法 JSON object，不要 Markdown；
- 主题必须由评论语义动态归纳，不能按固定关键词套类目。

#### 5.4.2 PRD 生成 Prompt（`lib/model-prd.ts` 中 `PRD_SYSTEM_PROMPT`）

核心约束：

- 所有需求 100% 来源于输入评论，禁止自创需求；
- 每条需求必须包含数据溯源、样本量、置信度、冲突反馈、痛点、根因、需求边界、解决方案、验收标准、风险权衡；
- 固定三级版本结构：V1.0 Critical、V2.0 Optimization、V3.0 Advanced；
- 需求 ID 固定为 `REQ-v1-01`、`REQ-v2-01`、`REQ-v3-01` 格式，并必须关联 `findingId` 与 `sourceReviewIds`；
- 验收标准必须可量化、可测试、可落地；
- 样本量 < 10 必须标注「样本有限，结论仅供参考」；
- 存在正反冲突评论时必须显性标注冲突点。

### 5.5 模型配置

#### 主题发现

| 参数 | 值 |
| --- | --- |
| `temperature` | `0.2` |
| `response_format` | `{"type": "json_object"}` |
| 单条评论最大长度 | 900 字符 |
| 最大输入评论数 | 220 条（超出截断，标记 `truncated: true`） |
| 最大 findings 数 | 8 个 |

#### PRD 生成

| 参数 | 值 |
| --- | --- |
| `temperature` | `0.2` |
| `max_tokens` | 默认自适应：`max(7000, 需求数 × 2200)`，上限 16000，可通过 `QWEN_PRD_MAX_TOKENS` 调整 |
| 每条需求发送给模型的来源评论数 | 最多 35 条 |

#### 为什么限制为 35 条

这个限制只作用于发送给千问的 PRD 上下文，不会删除本地的原始评论、清洗评论或完整 `sourceReviewIds`。原因是：

- 每条评论正文都会被截断到固定长度，多个需求如果携带全部来源评论，Prompt 很容易超过模型上下文或触发较长响应；
- 上下文过大时，模型更容易在输出末尾遗漏需求，出现部分 `requirementId` 没有生成的情况；
- 35 条可以保留足够的代表性证据，同时降低请求超时、响应截断和 PRD 结构不完整的概率；
- 本地 traceability validator 仍使用完整 `sourceReviewIds` 校验，不以模型上下文截断替代真实数据溯源。

需求输入在调用 PRD 模型前会做契约校验：`requirementId` 必须匹配 `REQ-v1/v2/v3-xx`，优先级必须为 `P0/P1/P2`，目标版本必须能映射到 `V1.0/V2.0/V3.0`。如果模型输出缺少固定章节、需求模块、findingId 或 sourceReviewIds，接口会返回明确错误，不会把不完整 PRD 标记为成功。

---

## 6. 如何减少幻觉

本项目通过 **Prompt 约束 + 结构化输出 + 多层后验校验** 降低模型幻觉风险。

### 6.1 Prompt 层约束

- 主题发现要求只能引用输入中的 `reviewId`；
- PRD 生成要求禁止使用输入外事实，禁止虚构评论/需求/ID；
- 证据引用必须来自评论原文。

### 6.2 输出格式约束

- 主题发现强制输出 JSON object；
- PRD 生成强制固定模板标题结构。

### 6.3 后验校验（`lib/model-findings.ts` 与 `lib/model-prd.ts`）

| 校验项 | 实现位置 | 说明 |
| --- | --- | --- |
| 评论 ID 存在性 | `lib/model-findings.ts` | 模型返回的 `supportingReviewIds`、`contradictionReviewIds`、`evidenceQuotes.reviewId` 必须在输入评论中存在 |
| 证据引用原文校验 | `lib/model-findings.ts` | `evidenceQuotes.quote` 必须能在对应评论原文中找到；无法定位的引用会被移除 |
| PRD 固定结构校验 | `lib/model-prd.ts` | 校验 PRD 是否包含版本总览、V1.0/V2.0/V3.0 三个固定版本章节 |
| Requirement ID 覆盖校验 | `lib/model-prd.ts` | 校验 PRD 是否包含所有输入的 `REQ-v1/v2/v3-xx` |
| Finding ID 覆盖校验 | `lib/model-prd.ts` | 校验每条需求是否保留对应的 `findingId` |
| Source Review ID 覆盖校验 | `lib/model-prd.ts` | 校验 PRD 是否保留本次发送给 PRD 模型的 `sourceReviewIds`；完整 `sourceReviewIds` 仍由本地 traceability validator 校验 |
| 需求模块校验 | `lib/model-prd.ts` | 校验每条需求是否包含溯源、真实问题、根因、边界、方案、验收、风险七个模块 |

### 6.4 追溯校验（`lib/traceability.ts`）

`validateTraceability` 会进一步校验：

- finding 引用的 reviewId 是否都存在；
- requirement 是否关联了存在的 findingId 和 reviewId；
- requirement 的 sourceReviewIds 是否能追溯到对应 finding 的证据；
- test case 是否关联了存在的 requirementId；
- test case 的 sourceReviewIds 是否覆盖了 requirement 的 sourceReviewIds。

### 6.5 置信度与不确定性标注

- 样本量 ≥ 30：高置信；
- 样本量 10-29：中置信；
- 样本量 < 10：低置信，必须标注「样本有限，结论仅供参考」。

当满足以下任一条件时，系统会自动追加 `uncertainty`：

- 支持评论少于 2 条；
- 有效证据引用少于 1 条；
- 置信度低于 0.55；
- 输入评论被截断。

---

## 7. JSON/CSV 导入格式与样本缓存说明

### 7.1 JSON 导入格式（对应 `lib/reviews.ts`）

支持三种结构：

#### 结构一：评论数组

```json
[
  {
    "id": "review-001",
    "title": "很好用的应用",
    "body": "界面清晰，功能也很全。",
    "rating": 5,
    "version": "2.1.0",
    "updatedAt": "2026-07-01T08:00:00Z",
    "author": "user123",
    "country": "us"
  }
]
```

#### 结构二：包含 `reviews` 字段的对象

```json
{
  "reviews": [
    { "id": "review-001", "title": "...", "body": "...", "rating": 5 }
  ]
}
```

#### 结构三：包含 `data` 或 `items` 字段的对象

```json
{
  "data": [
    { "id": "review-001", "title": "...", "body": "...", "rating": 5 }
  ]
}
```

### 7.2 CSV 导入格式（对应 `lib/reviews.ts`）

CSV 需要包含表头，系统会模糊匹配常见字段名（不区分大小写，忽略空格、下划线、连字符、点、冒号）。

#### 支持的字段映射

| 含义 | 支持的字段名 |
| --- | --- |
| 评论 ID | `id`、`reviewid`、`review_id`、`评论id`、`评论ID` |
| 标题 | `title`、`reviewtitle`、`review_title`、`subject`、`标题`、`评论标题` |
| 内容 | `body`、`content`、`review`、`text`、`comment`、`description`、`评论`、`评论内容`、`内容` |
| 评分 | `rating`、`score`、`stars`、`star`、`imrating`、`评分`、`星级` |
| 版本 | `version`、`appversion`、`app_version`、`imversion`、`版本`、`应用版本` |
| 日期/时间 | `updatedat`、`updated_at`、`updated`、`date`、`createdat`、`created_at`、`time`、`日期`、`时间` |
| 作者 | `author`、`user`、`username`、`nickname`、`name`、`用户`、`昵称` |
| 国家/地区 | `country`、`locale`、`region`、`国家`、`地区` |

#### CSV 示例

```csv
id,title,body,rating,version,date,author,country
review-001,闪退问题,每次打开都闪退，完全用不了,1,2.1.0,2026-07-01,user123,us
review-002,体验不错,界面很清爽，运行流畅,5,2.0.0,2026-06-28,user456,us
```

### 7.3 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` / `reviewId` | 否 | 用于追溯和去重；未提供时根据内容生成稳定指纹 ID |
| `title` / `body` | 至少一个 | 评论标题和正文；两者都为空则被丢弃 |
| `rating` | 否 | 1-5 数字，超出范围截断到 0-5 |
| `version` | 否 | App 版本号，规范化后去除 `version` / `v` 前缀 |
| `date` / `updatedAt` | 否 | 支持 ISO 8601 等可被 `Date.parse` 解析的格式 |
| `author` | 否 | 评论作者 |
| `country` | 否 | 默认 `us` |

### 7.4 样本缓存说明

**本项目中的任何示例数据、缓存文件或演示数据，仅用于展示界面布局、交互效果、格式验证和测试场景，不能替代真实的 App Store 评论采集能力。**

仓库提供以下离线样本文件：

| 文件 | 用途 | 标识 |
| --- | --- | --- |
| `sample-data/offline-reviews.sample.json` | 可在页面通过 JSON 导入的评论样本 | 合成离线演示数据 |
| `sample-data/offline-reviews.sample.csv` | 可在页面通过 CSV 导入的评论样本 | 合成离线演示数据 |
| `sample-data/offline-cache.sample.json` | 外部网络不可用时查看 findings、requirements、test cases、traceability 的结果形态 | `cacheType: "offline-demo"`、`syntheticData: true` |

使用方式：

1. 本地运行项目后，在页面选择 `sample-data/offline-reviews.sample.json` 或 `sample-data/offline-reviews.sample.csv` 导入；
2. 输入新的分析目标后点击「开始分析」；
3. 若当前网络或模型不可用，可直接打开 `sample-data/offline-cache.sample.json` 查看离线演示结果结构；
4. 离线缓存不会被应用自动加载，也不会影响新 App Store 链接或新 JSON/CSV 数据集的分析。

在实际分析场景中，请使用以下两种方式之一获取真实数据：

1. 通过前端「采集美国区评论」功能，从 Apple RSS 实时拉取；
2. 导入你自己合法拥有的、来源可靠的 JSON/CSV 评论数据。

模型分析结果的质量、置信度和业务价值直接取决于输入评论的真实性与代表性。请勿将演示数据作为产品决策、版本规划或需求评审的唯一依据。

---

## 8. 常见问题排查

### Q1：采集数量设置为 150，为什么实际少于 150 条？

Apple RSS 每页最多 50 条，但实际返回数量由该 App 在美国区当前可用的最新评论数决定。系统会按「采集数量」继续分页，直到达到用户设置的上限、达到最多 10 页、或 Apple RSS 返回空页。若界面显示「原始 100 条 · 清洗 100 条」，说明美国区 RSS 当前只返回了 100 条可用文本评论，去重后没有进一步减少。

### Q2：千问 PRD 生成请求失败，提示「fetch failed」或 `QWEN_NETWORK_ERROR`？

系统现在会把错误分成超时、网络失败、鉴权失败、限流和上游 5xx，并在页面执行日志中展示错误码与上游详情。请按错误类型检查：

- 当前网络是否能访问该域名；
- 是否开启了代理/VPN，导致 Next.js 服务端请求被拦截；
- `.env.local` 中的 `DASHSCOPE_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL` 是否正确；
- 修改 `.env.local` 后是否重启了 Next.js 服务；
- PRD 请求可能比主题发现耗时更长，默认超时为 180 秒；
- 主题发现成功而 PRD 失败时，优先检查 DashScope 的模型响应耗时、配额和代理连接是否被中途重置。

PowerShell 下使用代理示例：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7890"
$env:HTTPS_PROXY="http://127.0.0.1:7890"
npm run dev
```

### Q3：模型输出被截断或为空？

- 尝试调高 `QWEN_PRD_MAX_TOKENS`；
- 减少导入的评论数量或缩短单条评论长度；
- 检查模型返回是否包含固定 PRD 标题结构。

### Q4：导入 JSON/CSV 后评论数量变少？

系统会过滤标题和正文均为空的评论，并基于内容和 ID 去重。界面会显示删除空评论数和去重数，属于正常清洗逻辑。

---

## 技术栈

- [Next.js 14](https://nextjs.org/)
- [React 18](https://react.dev/)
- [TypeScript 5](https://www.typescriptlang.org/)
- [Lucide React](https://lucide.dev/)
- [阿里云 DashScope 兼容模式 API](https://help.aliyun.com/zh/dashscope/)
