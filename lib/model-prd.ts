import type { ModelFinding } from "./model-findings";
import type { Review } from "./reviews";

export type PrdRequirementInput = {
  requirementId: string;
  findingId: string;
  sourceReviewIds: string[];
  problem: string;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  priority: string;
  targetVersion: string;
};

export type GeneratePrdOptions = {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

export type GeneratePrdInput = {
  appName: string;
  analysisGoal: string;
  cleanedReviews: Review[];
  findings: ModelFinding[];
  requirements: PrdRequirementInput[];
};

export type GeneratePrdResult = {
  prdMarkdown: string;
  provider: "qwen";
  model: string;
  requirementCount: number;
  findingCount: number;
  sourceReviewCount: number;
  validation: {
    status: "pass";
    checkedRequirementCount: number;
    checkedSourceReviewCount: number;
  };
};

export class ModelPrdError extends Error {
  code: string;
  statusCode: number;
  details?: string;

  constructor(message: string, code: string, statusCode = 500, details?: string, cause?: unknown) {
    super(message);
    this.name = "ModelPrdError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const DEFAULT_MAX_TOKENS = 7000;
const DEFAULT_PRD_TOKENS_PER_REQUIREMENT = 2200;
const MAX_REVIEW_TEXT_LENGTH = 700;
const MAX_SOURCE_REVIEWS_PER_REQUIREMENT = 35;
const DEFAULT_QWEN_TIMEOUT_MS = 180000;
const MAX_QWEN_TIMEOUT_MS = 180000;
const MAX_QWEN_RETRIES = 1;
const REQUIRED_PRD_SECTIONS = [
  "# Product Requirement Document (PRD)",
  "## Version Iteration Overview",
  "## V1.0 Critical Experience Fixes",
  "## V2.0 Experience Optimization Upgrade",
  "## V3.0 Advanced Experience & Margin Optimization"
];

export async function generatePrdWithModel(
  input: GeneratePrdInput,
  options: GeneratePrdOptions = {}
): Promise<GeneratePrdResult> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new ModelPrdError(
      "未配置 DASHSCOPE_API_KEY，无法使用千问生成 PRD。",
      "DASHSCOPE_API_KEY_MISSING",
      500
    );
  }

  const cleanedReviews = normalizeReviews(input.cleanedReviews);
  const findings = normalizeFindings(input.findings);
  const requirements = normalizeRequirements(input.requirements, findings, cleanedReviews);

  if (!findings.length) {
    throw new ModelPrdError("findings 为空，无法生成基于证据的 PRD。", "FINDINGS_EMPTY", 400);
  }

  if (!requirements.length) {
    throw new ModelPrdError("requirements 为空，无法生成 PRD。", "REQUIREMENTS_EMPTY", 400);
  }

  validateRequirementInputs(requirements);

  const model = options.model || process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || DEFAULT_QWEN_BASE_URL
  );
  const adaptiveDefaultMaxTokens = Math.min(
    16000,
    Math.max(DEFAULT_MAX_TOKENS, requirements.length * DEFAULT_PRD_TOKENS_PER_REQUIREMENT)
  );
  const maxTokens = clampInteger(
    options.maxTokens ?? process.env.QWEN_PRD_MAX_TOKENS,
    adaptiveDefaultMaxTokens,
    1200,
    16000
  );
  const timeoutMs = clampInteger(
    process.env.QWEN_REQUEST_TIMEOUT_MS,
    DEFAULT_QWEN_TIMEOUT_MS,
    10000,
    MAX_QWEN_TIMEOUT_MS
  );
  const response = await callQwenForPrd({
    apiKey,
    model,
    baseUrl,
    maxTokens,
    timeoutMs,
    appName: input.appName,
    analysisGoal: input.analysisGoal,
    cleanedReviews,
    findings,
    requirements,
    fetchImpl: options.fetchImpl ?? fetch
  });
  const prdMarkdown = extractOutputText(response);

  if (!prdMarkdown) {
    throw new ModelPrdError("千问响应中没有可展示的 PRD 文本。", "QWEN_EMPTY_OUTPUT", 502);
  }

  const validation = validatePrdMarkdown(prdMarkdown, requirements);

  return {
    prdMarkdown,
    provider: "qwen",
    model,
    requirementCount: requirements.length,
    findingCount: findings.length,
    sourceReviewCount: countSourceReviews(requirements),
    validation
  };
}

type CallQwenForPrdInput = {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  timeoutMs: number;
  appName: string;
  analysisGoal: string;
  cleanedReviews: Review[];
  findings: ModelFinding[];
  requirements: PrdRequirementInput[];
  fetchImpl: typeof fetch;
};

async function callQwenForPrd(input: CallQwenForPrdInput) {
  const url = `${input.baseUrl}/chat/completions`;
  const requestBody = {
    model: input.model,
    temperature: 0.2,
    max_tokens: input.maxTokens,
    messages: [
      {
        role: "system",
        content: PRD_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify({
          app_name: input.appName || "Unknown App",
          user_goal: input.analysisGoal || "发现用户评论中的主要问题、需求和机会",
          required_requirement_ids: input.requirements.map((requirement) => requirement.requirementId),
          required_prd_sections: REQUIRED_PRD_SECTIONS,
          source_review_limit_per_requirement: MAX_SOURCE_REVIEWS_PER_REQUIREMENT,
          insight_review_data: buildInsightReviewData(input)
        })
      }
    ]
  };
  const response = await fetchQwenWithRetry(
    input.fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    },
    input.timeoutMs
  );

  if (!response.ok) {
    const details = await safeResponseText(response);
    throw new ModelPrdError(
      describeQwenHttpError(response.status, response.statusText, details),
      "QWEN_PRD_REQUEST_FAILED",
      502,
      extractUpstreamError(details)
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new ModelPrdError(
      "千问返回内容不是有效 JSON，无法解析 PRD 结果。",
      "QWEN_INVALID_RESPONSE_JSON",
      502,
      error instanceof Error ? error.message : String(error),
      error
    );
  }
}

const PRD_SYSTEM_PROMPT = `# Role
你是专业移动端产品经理，专门根据 App Store 用户评论聚类结果，生成可评审、可落地、可追溯、可拆分版本的正式产品PRD。
你的输出必须完全满足项目考核两条核心评审标准：
1. PRD必须基于真实用户问题，明确需求边界、优先级、清晰版本迭代规划
2. 所有需求可追溯原始用户评论，输出内容必须支持后续100%全覆盖生成测试用例

# Fixed Output Rules（必须严格遵守，逐条执行）
1. 所有需求100%来源于用户评论，禁止自创需求、禁止脑补功能。
2. 每条需求必须包含：唯一 requirementId、findingId、sourceReviewIds、targetVersion、数据溯源、样本量、置信度、观点冲突、用户痛点、根因分析、解决方案、明确需求边界（做什么/不做什么）、优先级、可测试验收标准、风险权衡。
3. 必须区分需求边界：明确「本期实现内容」+「本期不实现内容」，杜绝模糊需求。
4. 优先级严格自动判定：
   - P0(v1.0)：阻断使用、大量用户抱怨、严重差评、影响核心体验
   - P1(v2.0)：高频体验问题、不阻断但明显影响满意度
   - P2(v3.0)：小众反馈、优化体验、长期迭代功能
5. 版本固定三迭代结构：
   - V1.0 Critical Bug & Core Experience Fix（2-4w）解决致命问题
   - V2.0 Experience Optimization Upgrade（3-6w）优化高频体验
   - V3.0 Advanced Experience & Margin Optimization（6-8w）长线优化
6. 验收标准必须可量化、可测试、可落地，禁止“优化体验、改善问题”这类空话。
7. 若存在正反冲突评论，必须显性标注冲突点。
8. 样本量判定置信度：≥30高置信、10-29中置信、＜10低置信并标注【样本有限，结论仅供参考】。
9. 每条需求生成唯一ID：REQ-v1-01、REQ-v1-02、REQ-v2-01……
10. 输出结构固定，不允许自由发挥、不允许删减模块。
11. 每条需求最多只会收到 35 条来源评论正文。PRD 正文里的 Source Review IDs 只填写本次收到的 sourceReviewIds；supportSample 仍按完整样本量说明。

# Strict PRD Structure（固定输出模板）
必须逐字输出以下固定章节标题，不能替换英文、不能改写 V3 标题：
- # Product Requirement Document (PRD)
- ## Version Iteration Overview
- ## V1.0 Critical Experience Fixes（2-4 weeks｜P0 Core）
- ## V2.0 Experience Optimization Upgrade（3-6 weeks｜P1 Secondary）
- ## V3.0 Advanced Experience & Margin Optimization（6-8 weeks｜P2 Long-term）

# Product Requirement Document (PRD)
App Name：{app_name}
Analysis Goal：{user_goal}
Data Source：US App Store authentic user reviews

## Version Iteration Overview
整体版本规划说明：根据用户反馈严重程度、影响用户量、问题优先级分层迭代，优先解决影响核心使用的高曝光问题。

## V1.0 Critical Experience Fixes（2-4 weeks｜P0 Core）
版本目标：解决用户集中吐槽、阻碍基础使用、导致大量差评的核心体验问题

### {REQ-ID} 【P0】{需求标题}
Target Version：V1.0 / V2.0 / V3.0
Finding ID：{findingId}
Source Review IDs：{sourceReviewIds}
#### 1. Data Traceability（溯源信息）
- Confidence：高/中/低
- Support Sample：N reviews
- Conflict Feedback：无 / 存在冲突（说明正反观点）

#### 2. User Real Problem（用户真实问题）
归纳用户原始抱怨，不修饰、不美化。

#### 3. Pain Point & Root Cause Analysis（痛点+根因）
- User Pain：用户表层问题
- Root Cause：产品设计底层原因

#### 4. Requirement Scope（需求边界：做什么 / 不做什么）
- In Scope：本期明确实现的能力
- Out Of Scope：本期不做、后续版本考虑

#### 5. Solution（产品方案）
多条具体、可落地的产品优化方案

#### 6. Acceptance Criteria（可测试验收标准）
逐条可验证、可QA测试的标准，无模糊语句

#### 7. Risk & Trade-off（风险与权衡）
说明该改动带来的利弊、对业务/用户的影响

## V2.0 Experience Optimization Upgrade（3-6 weeks｜P1 Secondary）
版本目标：优化高频轻微体验问题，提升整体用户满意度

（重复上述单需求结构）

## V3.0 Advanced Experience & Margin Optimization（6-8 weeks｜P2 Long-term）
版本目标：解决小众反馈、精细化体验、长期体验升级

（重复上述单需求结构）

# 输入数据
聚类话题 + 对应原始评论数据：
{insight_review_data}`;

function buildInsightReviewData(input: CallQwenForPrdInput) {
  const reviewById = new Map(input.cleanedReviews.map((review) => [review.id, review]));
  const sourceReviewIds = uniqueStrings(
    input.requirements.flatMap((requirement) => getModelSourceReviewIds(requirement))
  );
  const sourceReviews = sourceReviewIds
    .map((reviewId) => reviewById.get(reviewId))
    .filter((review): review is Review => Boolean(review))
    .map((review) => ({
      reviewId: review.id,
      title: truncateForPrompt(review.title),
      body: truncateForPrompt(review.body),
      rating: review.rating,
      version: review.version,
      updatedAt: review.updatedAt,
      country: review.country
    }));

  const requirements = input.requirements.map((requirement) => {
    const finding = input.findings.find((item) => item.findingId === requirement.findingId);
    const modelSourceReviewIds = getModelSourceReviewIds(requirement);

    return {
      requirement: {
        requirementId: requirement.requirementId,
        findingId: requirement.findingId,
        sourceReviewIds: modelSourceReviewIds,
        problem: requirement.problem,
        goal: requirement.goal,
        nonGoals: requirement.nonGoals,
        acceptanceCriteria: requirement.acceptanceCriteria,
        priority: requirement.priority,
        targetVersion: requirement.targetVersion
      },
      finding: buildFindingForPrd(finding, modelSourceReviewIds),
      supportSample: requirement.sourceReviewIds.length,
      sourceReviewIds: modelSourceReviewIds,
      sourceReviewLimit: MAX_SOURCE_REVIEWS_PER_REQUIREMENT,
      omittedSourceReviewCount: Math.max(0, requirement.sourceReviewIds.length - modelSourceReviewIds.length)
    };
  });

  return {
    sourceReviews,
    sourceReviewLimitPerRequirement: MAX_SOURCE_REVIEWS_PER_REQUIREMENT,
    requirements
  };
}

function validatePrdMarkdown(prdMarkdown: string, requirements: PrdRequirementInput[]) {
  const missingSections = REQUIRED_PRD_SECTIONS.filter((section) => !prdMarkdown.includes(section));

  if (missingSections.length) {
    throw new ModelPrdError(
      `PRD 缺少固定结构：${missingSections.join("、")}`,
      "QWEN_PRD_STRUCTURE_INVALID",
      502
    );
  }

  const missingRequirements: string[] = [];
  const missingSources: string[] = [];
  const missingModules: string[] = [];

  for (const requirement of requirements) {
    const section = extractRequirementSection(prdMarkdown, requirement.requirementId);
    if (!section) {
      missingRequirements.push(requirement.requirementId);
      continue;
    }

    const moduleLabels = [
      "Data Traceability",
      "User Real Problem",
      "Pain Point & Root Cause Analysis",
      "Requirement Scope",
      "Solution",
      "Acceptance Criteria",
      "Risk & Trade-off"
    ];
    const absentModules = moduleLabels.filter((label) => !section.toLowerCase().includes(label.toLowerCase()));
    if (absentModules.length) {
      missingModules.push(`${requirement.requirementId}: ${absentModules.join(", ")}`);
    }

    const missingRequirementSources = getModelSourceReviewIds(requirement).filter((reviewId) => !section.includes(reviewId));
    if (missingRequirementSources.length) {
      missingSources.push(`${requirement.requirementId}: ${missingRequirementSources.join(", ")}`);
    }

    if (!section.includes(requirement.findingId)) {
      missingModules.push(`${requirement.requirementId}: ${requirement.findingId}`);
    }

    const normalizedTargetVersion = normalizeTargetVersion(requirement.targetVersion);
    if (!section.toLowerCase().includes(normalizedTargetVersion.toLowerCase())) {
      missingModules.push(`${requirement.requirementId}: ${normalizedTargetVersion}`);
    }

    if (!section.includes(requirement.priority)) {
      missingModules.push(`${requirement.requirementId}: ${requirement.priority}`);
    }
  }

  if (missingRequirements.length || missingSources.length || missingModules.length) {
    const details = [
      missingRequirements.length ? `缺少需求 ID：${missingRequirements.join("、")}` : "",
      missingSources.length ? `缺少来源评论：${missingSources.join("；")}` : "",
      missingModules.length ? `缺少需求模块或版本/优先级：${missingModules.join("；")}` : ""
    ]
      .filter(Boolean)
      .join(" ");

    throw new ModelPrdError(`PRD 后验校验失败。${details}`, "QWEN_PRD_TRACEABILITY_INVALID", 502);
  }

  return {
    status: "pass" as const,
    checkedRequirementCount: requirements.length,
    checkedSourceReviewCount: countModelSourceReviews(requirements)
  };
}

function getModelSourceReviewIds(requirement: PrdRequirementInput) {
  return uniqueStrings(requirement.sourceReviewIds).slice(0, MAX_SOURCE_REVIEWS_PER_REQUIREMENT);
}

function buildFindingForPrd(finding: ModelFinding | undefined, allowedReviewIds: string[]) {
  if (!finding) {
    return null;
  }

  const allowedReviewIdSet = new Set(allowedReviewIds);

  return {
    findingId: finding.findingId,
    title: truncateForPrompt(finding.title),
    summary: truncateForPrompt(finding.summary),
    severity: finding.severity,
    confidence: finding.confidence,
    supportingReviewIds: finding.supportingReviewIds.filter((reviewId) => allowedReviewIdSet.has(reviewId)),
    evidenceQuotes: finding.evidenceQuotes
      .filter((quote) => allowedReviewIdSet.has(quote.reviewId))
      .slice(0, 12)
      .map((quote) => ({
        reviewId: quote.reviewId,
        quote: truncateForPrompt(quote.quote)
      })),
    contradictionReviewIds: finding.contradictionReviewIds.filter((reviewId) => allowedReviewIdSet.has(reviewId)),
    uncertainty: truncateForPrompt(finding.uncertainty)
  };
}

function extractRequirementSection(prdMarkdown: string, requirementId: string) {
  const escapedId = escapeRegExp(requirementId);
  const startPattern = new RegExp(`^###\\s+[^\\n]*${escapedId}[^\\n]*$`, "im");
  const startMatch = startPattern.exec(prdMarkdown);
  if (!startMatch || startMatch.index === undefined) {
    return "";
  }

  const sectionStart = startMatch.index;
  const remaining = prdMarkdown.slice(sectionStart + startMatch[0].length);
  const nextRequirement = /^###\s+/im.exec(remaining);
  const sectionEnd = nextRequirement?.index ?? remaining.length;
  return `${startMatch[0]}\n${remaining.slice(0, sectionEnd)}`;
}

function normalizeTargetVersion(targetVersion: string) {
  const value = normalizeString(targetVersion).toLowerCase();
  if (value === "v1" || value === "v1.0") {
    return "V1.0";
  }

  if (value === "v2" || value === "v2.0") {
    return "V2.0";
  }

  return "V3.0";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeReviews(value: Review[]) {
  return value
    .filter((review) => review && typeof review.id === "string")
    .map((review) => ({
      ...review,
      id: normalizeString(review.id),
      title: normalizeString(review.title),
      body: normalizeString(review.body),
      version: normalizeString(review.version),
      updatedAt: normalizeString(review.updatedAt || review.date),
      country: normalizeString(review.country)
    }))
    .filter((review) => review.id && (review.title || review.body));
}

function normalizeFindings(value: ModelFinding[]) {
  return value.filter((finding) => finding && typeof finding.findingId === "string");
}

function normalizeRequirements(
  requirements: PrdRequirementInput[],
  findings: ModelFinding[],
  reviews: Review[]
) {
  const findingIds = new Set(findings.map((finding) => finding.findingId));
  const reviewIds = new Set(reviews.map((review) => review.id));

  return requirements
    .filter((requirement) => requirement && findingIds.has(requirement.findingId))
    .map((requirement) => ({
      ...requirement,
      sourceReviewIds: Array.from(new Set(requirement.sourceReviewIds.filter((reviewId) => reviewIds.has(reviewId))))
    }))
    .filter((requirement) => requirement.requirementId && requirement.sourceReviewIds.length > 0);
}

function validateRequirementInputs(requirements: PrdRequirementInput[]) {
  const invalid = requirements.filter((requirement) => {
    const hasId = /^REQ-v[123]-\d{2}$/i.test(normalizeString(requirement.requirementId));
    const hasPriority = ["P0", "P1", "P2"].includes(normalizeString(requirement.priority));
    const hasVersion = ["V1", "V2", "V3", "V1.0", "V2.0", "V3.0", "Later"].includes(
      normalizeString(requirement.targetVersion)
    );
    return !hasId || !hasPriority || !hasVersion;
  });

  if (invalid.length) {
    throw new ModelPrdError(
      `PRD 输入契约校验失败：${invalid.map((requirement) => requirement.requirementId || "(missing requirementId)").join("、")}`,
      "PRD_REQUIREMENT_CONTRACT_INVALID",
      400
    );
  }
}

function countSourceReviews(requirements: PrdRequirementInput[]) {
  return new Set(requirements.flatMap((requirement) => requirement.sourceReviewIds)).size;
}

function countModelSourceReviews(requirements: PrdRequirementInput[]) {
  return new Set(requirements.flatMap((requirement) => getModelSourceReviewIds(requirement))).size;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractOutputText(response: unknown): string {
  if (isRecord(response) && Array.isArray(response.choices)) {
    const firstChoice = response.choices.find(isRecord);
    const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
    const content = message?.content;

    if (typeof content === "string") {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .join("")
        .trim();
    }
  }

  if (isRecord(response) && typeof response.output_text === "string") {
    return response.output_text.trim();
  }

  return "";
}

function truncateForPrompt(value: string) {
  const text = normalizeString(value);
  return text.length > MAX_REVIEW_TEXT_LENGTH ? `${text.slice(0, MAX_REVIEW_TEXT_LENGTH)}...` : text;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

async function safeResponseText(response: Response) {
  try {
    return (await response.text()).slice(0, 1200);
  } catch {
    return "";
  }
}

async function fetchQwenWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_QWEN_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal
      });

      if (response.ok || !isRetriableQwenStatus(response.status) || attempt === MAX_QWEN_RETRIES) {
        return response;
      }

      await sleep(800 * (attempt + 1));
    } catch (error) {
      lastError = error;
      const isTimeout = error instanceof Error && error.name === "AbortError";

      if (isTimeout || attempt === MAX_QWEN_RETRIES) {
        throw new ModelPrdError(
          isTimeout
            ? `千问请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回，请减少评论数量或检查网络代理。`
            : `无法连接千问服务：${getErrorMessage(error)}。请检查网络、代理和 QWEN_BASE_URL。`,
          isTimeout ? "QWEN_REQUEST_TIMEOUT" : "QWEN_NETWORK_ERROR",
          isTimeout ? 504 : 502,
          `endpoint=${url}`
        );
      }

      await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ModelPrdError(
    `无法连接千问服务：${getErrorMessage(lastError)}。`,
    "QWEN_NETWORK_ERROR",
    502,
    `endpoint=${url}`
  );
}

function isRetriableQwenStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function describeQwenHttpError(status: number, statusText: string, details: string) {
  if (status === 401 || status === 403) {
    return "千问鉴权失败，请检查 DASHSCOPE_API_KEY 是否有效且属于当前 DashScope 账号。";
  }

  if (status === 404) {
    return "千问接口地址不存在，请检查 QWEN_BASE_URL 是否为 DashScope OpenAI 兼容接口地址。";
  }

  if (status === 429) {
    return "千问请求频率或额度受限，请稍后重试或检查 DashScope 配额。";
  }

  if (status >= 500) {
    return `千问服务暂时不可用：HTTP ${status} ${statusText || ""}`.trim();
  }

  return `千问请求被拒绝：HTTP ${status} ${statusText || ""} ${extractUpstreamError(details)}`.trim();
}

function extractUpstreamError(details: string) {
  const text = normalizeString(details);
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      const message = normalizeString(error.message || error.code || error.type);
      if (message) {
        return message.slice(0, 500);
      }
    }
  } catch {
    // Keep the original short response when the upstream body is not JSON.
  }

  return text.slice(0, 500);
}

function getErrorMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return causeMessage ? `${error.message} (${causeMessage})` : error.message;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeString(value: unknown) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
