import { prepareReviews, reviewsFromRssPayload, type Review, type ReviewImportStats } from "./reviews";

export const APP_STORE_REVIEW_COUNTRY = "us";
export const APPLE_RSS_SOURCE = "apple-rss-json";
export const DEFAULT_MAX_REVIEW_PAGES = 3;
export const MAX_REVIEW_PAGES = 10;
export const DEFAULT_REVIEW_LIMIT = 100;
export const MAX_REVIEW_LIMIT = 500;
export const DEFAULT_PAGE_DELAY_MS = 600;
export const MAX_PAGE_DELAY_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
export const MAX_RETRIES = 2;

export type FetchAppStoreReviewsOptions = {
  maxPages?: number;
  limit?: number;
  delayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type FetchAppStoreReviewsResult = {
  appId: string;
  country: typeof APP_STORE_REVIEW_COUNTRY;
  source: typeof APPLE_RSS_SOURCE;
  requestedLimit: number;
  maxPages: number;
  pagesFetched: number;
  rateLimitDelayMs: number;
  feedUrls: string[];
  rawReviews: Review[];
  cleanedReviews: Review[];
  reviews: Review[];
  stats: ReviewImportStats;
};

export class AppStoreReviewError extends Error {
  code: string;
  statusCode: number;
  details?: string;

  constructor(message: string, code: string, statusCode = 500, details?: string, cause?: unknown) {
    super(message);
    this.name = "AppStoreReviewError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export async function fetchAppStoreReviews(
  appStoreUrl: string,
  options: FetchAppStoreReviewsOptions = {}
): Promise<FetchAppStoreReviewsResult> {
  const appId = parseAppStoreAppId(appStoreUrl);
  const maxPages = clampInteger(options.maxPages, DEFAULT_MAX_REVIEW_PAGES, 1, MAX_REVIEW_PAGES);
  const requestedLimit = clampInteger(options.limit, DEFAULT_REVIEW_LIMIT, 1, MAX_REVIEW_LIMIT);
  const delayMs = clampInteger(options.delayMs, DEFAULT_PAGE_DELAY_MS, 0, MAX_PAGE_DELAY_MS);
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 60000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const reviews: Review[] = [];
  const feedUrls: string[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const feedUrl = buildReviewFeedUrl(appId, page);
    feedUrls.push(feedUrl);
    const pageReviews = await fetchReviewPage(feedUrl, {
      appId,
      page,
      timeoutMs,
      signal: options.signal,
      fetchImpl
    });

    pagesFetched = page;
    if (pageReviews.length === 0) {
      break;
    }

    reviews.push(...pageReviews);

    if (reviews.length >= requestedLimit) {
      break;
    }

    if (page < maxPages) {
      await sleep(delayMs);
    }
  }

  const preparedReviews = prepareReviews(reviews, "rss");
  const rawReviews = preparedReviews.rawReviews.slice(0, requestedLimit);
  const cleanedReviews = preparedReviews.cleanedReviews.slice(0, requestedLimit);

  return {
    appId,
    country: APP_STORE_REVIEW_COUNTRY,
    source: APPLE_RSS_SOURCE,
    requestedLimit,
    maxPages,
    pagesFetched,
    rateLimitDelayMs: delayMs,
    feedUrls,
    rawReviews,
    cleanedReviews,
    reviews: cleanedReviews,
    stats: {
      ...preparedReviews.stats,
      rawCount: rawReviews.length,
      cleanedCount: cleanedReviews.length
    }
  };
}

export function parseAppStoreAppId(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new AppStoreReviewError("请输入 App Store 链接。", "APP_STORE_URL_REQUIRED", 400);
  }

  const decoded = decodeURIComponent(value);
  const urlId = extractIdFromUrl(decoded);
  const textId = decoded.match(/(?:^|[/?&=#-])id(\d{5,})(?:\D|$)/i)?.[1];
  const bareId = decoded.match(/^\d{5,}$/)?.[0];
  const appId = urlId ?? textId ?? bareId;

  if (!appId) {
    throw new AppStoreReviewError(
      "无法从输入中解析 App ID。请使用包含 /id123456789 的 App Store 链接。",
      "APP_ID_NOT_FOUND",
      400
    );
  }

  return appId;
}

export function buildReviewFeedUrl(appId: string, page: number) {
  return `https://itunes.apple.com/${APP_STORE_REVIEW_COUNTRY}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
}

type FetchReviewPageOptions = {
  appId: string;
  page: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
};

async function fetchReviewPage(url: string, options: FetchReviewPageOptions) {
  const payload = await fetchJsonWithRetry(url, options);
  const feed = readRecord(payload, "feed");
  if (!feed) {
    throw new AppStoreReviewError(
      `Apple RSS 返回结构异常：缺少 feed（第 ${options.page} 页）。`,
      "APPLE_RSS_INVALID_SHAPE",
      502
    );
  }

  return reviewsFromRssPayload(payload, {
    appId: options.appId,
    page: options.page,
    sourceUrl: url,
    country: APP_STORE_REVIEW_COUNTRY
  });
}

async function fetchJsonWithRetry(url: string, options: FetchReviewPageOptions): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);

      if (!response.ok) {
        const body = await safeResponseText(response);
        if (attempt < MAX_RETRIES && isRetriableStatus(response.status)) {
          await sleep(getRetryDelayMs(response, attempt));
          continue;
        }

        throw new AppStoreReviewError(
          `Apple RSS 请求失败：HTTP ${response.status} ${response.statusText || ""}（第 ${options.page} 页）。`,
          "APPLE_RSS_HTTP_ERROR",
          502,
          body
        );
      }

      try {
        return await response.json();
      } catch (error) {
        throw new AppStoreReviewError(
          `Apple RSS 返回的不是有效 JSON（第 ${options.page} 页）。`,
          "APPLE_RSS_INVALID_JSON",
          502,
          undefined,
          error
        );
      }
    } catch (error) {
      lastError = error;

      if (error instanceof AppStoreReviewError) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(450 * (attempt + 1));
        continue;
      }
    }
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  const isAbort = lastError instanceof Error && lastError.name === "AbortError";
  throw new AppStoreReviewError(
    isAbort
      ? `Apple RSS 请求超时（第 ${options.page} 页）。`
      : `Apple RSS 请求失败（第 ${options.page} 页）：${details}`,
    isAbort ? "APPLE_RSS_TIMEOUT" : "APPLE_RSS_NETWORK_ERROR",
    isAbort ? 504 : 502,
    details,
    lastError
  );
}

async function fetchWithTimeout(url: string, options: FetchReviewPageOptions) {
  if (options.signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    return await options.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "app-review-prd-lab/0.1"
      },
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function extractIdFromUrl(input: string) {
  try {
    const url = new URL(input);
    const pathId = url.pathname.match(/\/id(\d{5,})(?:\/|$)?/i)?.[1];
    const queryId = url.searchParams.get("id");
    return pathId ?? (queryId?.match(/^\d{5,}$/)?.[0] ?? undefined);
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null;
  }

  const child = value[key];
  return isRecord(child) ? child : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function isRetriableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getRetryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_PAGE_DELAY_MS);
  }

  return 600 * (attempt + 1);
}

async function safeResponseText(response: Response) {
  try {
    return (await response.text()).slice(0, 800);
  } catch {
    return "";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
