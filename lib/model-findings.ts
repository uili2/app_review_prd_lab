import type { Review } from "./reviews";

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type EvidenceQuote = {
  reviewId: string;
  quote: string;
};

export type ModelFinding = {
  findingId: string;
  title: string;
  summary: string;
  severity: FindingSeverity;
  confidence: number;
  supportingReviewIds: string[];
  evidenceQuotes: EvidenceQuote[];
  contradictionReviewIds: string[];
  uncertainty: string;
};

export type FindingCorrection = {
  findingId: string;
  type: "normalize" | "remove_invalid_evidence" | "add_uncertainty";
  message: string;
};

export type DiscoverFindingsOptions = {
  model?: string;
  baseUrl?: string;
  maxReviews?: number;
  maxFindings?: number;
  fetchImpl?: typeof fetch;
};

export type DiscoverFindingsResult = {
  findings: ModelFinding[];
  corrections: FindingCorrection[];
  provider: "qwen";
  model: string;
  inputReviewCount: number;
  analyzedReviewCount: number;
  truncated: boolean;
};

export class ModelFindingsError extends Error {
  code: string;
  statusCode: number;
  details?: string;

  constructor(message: string, code: string, statusCode = 500, details?: string, cause?: unknown) {
    super(message);
    this.name = "ModelFindingsError";
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
const DEFAULT_MAX_REVIEWS = 220;
const MAX_REVIEW_TEXT_LENGTH = 900;
const DEFAULT_MAX_FINDINGS = 8;

export async function discoverFindingsWithModel(
  cleanedReviews: Review[],
  analysisGoal: string,
  options: DiscoverFindingsOptions = {}
): Promise<DiscoverFindingsResult> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new ModelFindingsError(
      "未配置 DASHSCOPE_API_KEY，无法使用千问执行模型驱动的主题发现。",
      "DASHSCOPE_API_KEY_MISSING",
      500
    );
  }

  const sourceReviews = normalizeInputReviews(cleanedReviews);
  if (!sourceReviews.length) {
    throw new ModelFindingsError("cleanedReviews 为空，无法发现主题。", "CLEANED_REVIEWS_EMPTY", 400);
  }

  const maxReviews = clampInteger(options.maxReviews, DEFAULT_MAX_REVIEWS, 1, 600);
  const maxFindings = clampInteger(options.maxFindings, DEFAULT_MAX_FINDINGS, 1, 12);
  const promptReviews = sourceReviews.slice(0, maxReviews);
  const model = options.model || process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || DEFAULT_QWEN_BASE_URL
  );
  const response = await callQwenChatCompletions({
    apiKey,
    model,
    baseUrl,
    analysisGoal,
    reviews: promptReviews,
    inputReviewCount: sourceReviews.length,
    maxFindings,
    fetchImpl: options.fetchImpl ?? fetch
  });

  const parsed = parseFindingsJson(response);
  const findings = validateFindings(parsed.findings, sourceReviews, {
    maxFindings,
    analyzedReviewIds: new Set(promptReviews.map((review) => review.id)),
    truncated: promptReviews.length < sourceReviews.length
  });
  const corrections = buildFindingCorrections(parsed.findings, findings, {
    truncated: promptReviews.length < sourceReviews.length,
    analyzedReviewIds: new Set(promptReviews.map((review) => review.id))
  });

  return {
    findings,
    corrections,
    provider: "qwen",
    model,
    inputReviewCount: sourceReviews.length,
    analyzedReviewCount: promptReviews.length,
    truncated: promptReviews.length < sourceReviews.length
  };
}

export function validateFindings(
  value: unknown,
  cleanedReviews: Review[],
  context: {
    maxFindings?: number;
    analyzedReviewIds?: Set<string>;
    truncated?: boolean;
  } = {}
): ModelFinding[] {
  if (!Array.isArray(value)) {
    throw new ModelFindingsError("模型输出缺少 findings 数组。", "MODEL_FINDINGS_INVALID_SHAPE", 502);
  }

  const knownReviewIds = new Set(cleanedReviews.map((review) => review.id));
  const reviewById = new Map(cleanedReviews.map((review) => [review.id, review]));
  const maxFindings = context.maxFindings ?? DEFAULT_MAX_FINDINGS;

  return value.slice(0, maxFindings).map((item, index) => {
    if (!isRecord(item)) {
      throw new ModelFindingsError(`模型输出的第 ${index + 1} 个 finding 不是对象。`, "MODEL_FINDING_INVALID", 502);
    }

    const findingId = normalizeString(item.findingId) || `F-${String(index + 1).padStart(2, "0")}`;
    const title = normalizeString(item.title);
    const summary = normalizeString(item.summary);
    const severity = normalizeSeverity(item.severity);
    const confidence = normalizeConfidence(item.confidence);
    const supportingReviewIds = uniqueStrings(item.supportingReviewIds);
    const contradictionReviewIds = uniqueStrings(item.contradictionReviewIds);
    const evidenceQuotes = normalizeEvidenceQuotes(item.evidenceQuotes);
    const uncertaintyParts = [normalizeString(item.uncertainty)];

    assertKnownIds(supportingReviewIds, knownReviewIds, findingId, "supportingReviewIds");
    assertKnownIds(contradictionReviewIds, knownReviewIds, findingId, "contradictionReviewIds");
    assertKnownIds(
      evidenceQuotes.map((quote) => quote.reviewId),
      knownReviewIds,
      findingId,
      "evidenceQuotes.reviewId"
    );

    const supportedQuotes = evidenceQuotes.filter((quote) => {
      const review = reviewById.get(quote.reviewId);
      if (!review) {
        return false;
      }

      return reviewTextIncludesQuote(review, quote.quote);
    });

    if (supportedQuotes.length !== evidenceQuotes.length) {
      uncertaintyParts.push("部分 evidenceQuotes 未能在对应评论原文中精确定位，已从输出中移除。");
    }

    if (supportingReviewIds.length < 2 || supportedQuotes.length < 1 || confidence < 0.55) {
      uncertaintyParts.push("证据量或置信度不足，需要人工复核。");
    }

    if (context.truncated && context.analyzedReviewIds) {
      const usesOnlyAnalyzedReviews = [...new Set([...supportingReviewIds, ...contradictionReviewIds])].every((id) =>
        context.analyzedReviewIds?.has(id)
      );
      if (usesOnlyAnalyzedReviews) {
        uncertaintyParts.push("输入评论量超过模型上下文，仅基于已发送的评论子集发现主题。");
      }
    }

    if (!title || !summary) {
      throw new ModelFindingsError(`模型输出的 ${findingId} 缺少 title 或 summary。`, "MODEL_FINDING_INVALID", 502);
    }

    return {
      findingId,
      title,
      summary,
      severity,
      confidence,
      supportingReviewIds,
      evidenceQuotes: supportedQuotes,
      contradictionReviewIds,
      uncertainty: joinUncertainty(uncertaintyParts)
    };
  });
}

type CallQwenInput = {
  apiKey: string;
  model: string;
  baseUrl: string;
  analysisGoal: string;
  reviews: Review[];
  inputReviewCount: number;
  maxFindings: number;
  fetchImpl: typeof fetch;
};

async function callQwenChatCompletions(input: CallQwenInput) {
  const response = await input.fetchImpl(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      },
      messages: [
        {
          role: "system",
          content:
            "你是资深产品研究分析师。你的任务是从用户评论中动态发现主题和产品发现，不允许使用预设关键词分类作为主要分析方式。只能使用输入里真实存在的 reviewId 和评论文本。证据不足或存在推断时，必须在 uncertainty 中说明。evidenceQuotes 必须逐字来自对应评论。只输出一个合法 JSON object，不要输出 Markdown。"
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "请根据 reviews 动态发现主题，并按 JSON 格式输出 findings。",
            outputSchema: {
              findings: [
                {
                  findingId: "string",
                  title: "string",
                  summary: "string",
                  severity: "critical | high | medium | low",
                  confidence: "number between 0 and 1",
                  supportingReviewIds: ["string"],
                  evidenceQuotes: [{ reviewId: "string", quote: "string" }],
                  contradictionReviewIds: ["string"],
                  uncertainty: "string"
                }
              ]
            },
            analysisGoal: input.analysisGoal || "发现用户评论中的主要问题、需求和机会",
            constraints: [
              "输出必须是 JSON object，顶层只有 findings 字段",
              "每个 finding 必须由评论语义动态归纳，不要按固定关键词套类目",
              "supportingReviewIds 和 contradictionReviewIds 只能使用输入 reviews 中的 id",
              "evidenceQuotes 必须是对应评论 title/body 中的原文短句",
              "如果支持评论少于 2 条、证据冲突、只是一种可能解释，uncertainty 必须非空",
              "如果没有足够证据，返回空 findings 数组"
            ],
            inputReviewCount: input.inputReviewCount,
            providedReviewCount: input.reviews.length,
            maxFindings: input.maxFindings,
            reviews: input.reviews.map((review) => ({
              id: review.id,
              title: truncateForPrompt(review.title),
              body: truncateForPrompt(review.body),
              rating: review.rating,
              version: review.version,
              updatedAt: review.updatedAt,
              country: review.country
            }))
          })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new ModelFindingsError(
      `千问模型请求失败：HTTP ${response.status} ${response.statusText || ""}。`,
      "QWEN_REQUEST_FAILED",
      502,
      await safeResponseText(response)
    );
  }

  return response.json() as Promise<unknown>;
}

function parseFindingsJson(response: unknown) {
  const outputText = extractOutputText(response);
  if (!outputText) {
    throw new ModelFindingsError("千问响应中没有可解析的文本输出。", "QWEN_EMPTY_OUTPUT", 502);
  }

  try {
    const parsed = JSON.parse(stripJsonCodeFence(outputText)) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("parsed value is not an object");
    }

    return parsed;
  } catch (error) {
    throw new ModelFindingsError(
      "模型输出不是有效 findings JSON。",
      "MODEL_FINDINGS_INVALID_JSON",
      502,
      outputText.slice(0, 1000),
      error
    );
  }
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
    return response.output_text;
  }

  if (!isRecord(response) || !Array.isArray(response.output)) {
    return "";
  }

  return response.output
    .flatMap((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        return [];
      }

      return item.content.map((content) => {
        if (!isRecord(content)) {
          return "";
        }

        return typeof content.text === "string" ? content.text : "";
      });
    })
    .join("")
    .trim();
}

function stripJsonCodeFence(value: string) {
  const text = value.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? text;
}

function normalizeInputReviews(reviews: Review[]) {
  return reviews
    .filter((review) => review && typeof review.id === "string")
    .map((review) => ({
      ...review,
      id: review.id.trim(),
      title: normalizeString(review.title),
      body: normalizeString(review.body),
      version: normalizeString(review.version),
      updatedAt: normalizeString(review.updatedAt || review.date),
      country: normalizeString(review.country)
    }))
    .filter((review) => review.id && (review.title || review.body));
}

function normalizeEvidenceQuotes(value: unknown): EvidenceQuote[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((quote) => ({
      reviewId: normalizeString(quote.reviewId),
      quote: normalizeString(quote.quote)
    }))
    .filter((quote) => quote.reviewId && quote.quote);
}

function buildFindingCorrections(
  rawFindings: unknown,
  validatedFindings: ModelFinding[],
  context: {
    truncated?: boolean;
    analyzedReviewIds?: Set<string>;
  } = {}
): FindingCorrection[] {
  if (!Array.isArray(rawFindings)) {
    return [];
  }

  return rawFindings.slice(0, validatedFindings.length).flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }

    const finding = validatedFindings[index];
    if (!finding) {
      return [];
    }

    const corrections: FindingCorrection[] = [];
    const rawFindingId = normalizeString(item.findingId);
    const rawEvidenceQuotes = normalizeEvidenceQuotes(item.evidenceQuotes);

    if (!rawFindingId) {
      corrections.push({
        findingId: finding.findingId,
        type: "normalize",
        message: "Model output omitted findingId; a stable local findingId was generated."
      });
    }

    if (rawEvidenceQuotes.length > finding.evidenceQuotes.length) {
      corrections.push({
        findingId: finding.findingId,
        type: "remove_invalid_evidence",
        message: `${rawEvidenceQuotes.length - finding.evidenceQuotes.length} evidence quote(s) were removed because they could not be matched to the source review text.`
      });
    }

    if (finding.uncertainty) {
      corrections.push({
        findingId: finding.findingId,
        type: "add_uncertainty",
        message: finding.uncertainty
      });
    }

    if (context.truncated && context.analyzedReviewIds) {
      const usesOnlyAnalyzedReviews = [...new Set([...finding.supportingReviewIds, ...finding.contradictionReviewIds])].every((id) =>
        context.analyzedReviewIds?.has(id)
      );

      if (usesOnlyAnalyzedReviews) {
        corrections.push({
          findingId: finding.findingId,
          type: "add_uncertainty",
          message: "The analysis only covered a truncated subset of the available reviews."
        });
      }
    }

    return corrections;
  });
}

function assertKnownIds(ids: string[], knownReviewIds: Set<string>, findingId: string, field: string) {
  const unknownIds = ids.filter((id) => !knownReviewIds.has(id));
  if (unknownIds.length) {
    throw new ModelFindingsError(
      `模型输出的 ${findingId}.${field} 包含不存在的 reviewId。`,
      "MODEL_FINDING_UNKNOWN_REVIEW_ID",
      502,
      unknownIds.join(", ")
    );
  }
}

function reviewTextIncludesQuote(review: Review, quote: string) {
  const haystack = normalizeForQuoteSearch(`${review.title} ${review.body}`);
  const needle = normalizeForQuoteSearch(quote);
  return Boolean(needle) && haystack.includes(needle);
}

function normalizeForQuoteSearch(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeSeverity(value: unknown): FindingSeverity {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeConfidence(value: unknown) {
  const confidence = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(confidence)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, confidence));
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.map(normalizeString).filter(Boolean)));
}

function joinUncertainty(parts: string[]) {
  return Array.from(new Set(parts.map((part) => part.trim()).filter(Boolean))).join(" ");
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

function normalizeString(value: unknown) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
