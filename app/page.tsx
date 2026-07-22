"use client";

import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  DownloadCloud,
  FileJson,
  FileSpreadsheet,
  FlaskConical,
  GitBranch,
  Layers3,
  Link2,
  Loader2,
  Play,
  Search,
  Sparkles,
  Target,
  Upload
} from "lucide-react";
import { ChangeEvent, useMemo, useRef, useState } from "react";
import type { FindingCorrection, ModelFinding } from "@/lib/model-findings";
import type { PrdRequirementInput } from "@/lib/model-prd";
import { parseReviewsFromText } from "@/lib/reviews";
import type { Review, ReviewImportStats } from "@/lib/reviews";
import { validateTraceability, type TraceabilityIssue, type TraceabilitySummary } from "@/lib/traceability";

type Sentiment = "positive" | "neutral" | "negative";

type RawReview = Review;

type CleanReview = RawReview & {
  cleanedBody: string;
  tokens: string[];
  sentiment: Sentiment;
  sentimentScore: number;
  themes: string[];
};

type ThemeSummary = {
  id: string;
  label: string;
  count: number;
  negativeCount: number;
  negativeShare: number;
  averageRating: number | null;
  impact: number;
  reviewIds: string[];
  severity: ModelFinding["severity"];
  confidence: number;
  uncertainty: string;
};

type Finding = ModelFinding;

type TargetVersion = "V1" | "V2" | "Later";

type RequirementPriority = "P0" | "P1" | "P2";

type VersionPlan = {
  id: string;
  targetVersion: TargetVersion;
  title: string;
  objective: string;
  requirementIds: string[];
  findingIds: string[];
  sourceReviewIds: string[];
  exitCriteria: string[];
};

type Requirement = {
  requirementId: string;
  findingId: string;
  sourceReviewIds: string[];
  problem: string;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  priority: RequirementPriority;
  targetVersion: TargetVersion;
};

type TestCase = {
  testCaseId: string;
  requirementId: string;
  sourceReviewIds: string[];
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
};

type TraceRow = TraceabilityIssue;

type AnalysisResult = {
  cleanReviews: CleanReview[];
  themes: ThemeSummary[];
  findings: Finding[];
  prdMarkdown: string;
  versionPlans: VersionPlan[];
  requirements: Requirement[];
  testCases: TestCase[];
  traceRows: TraceRow[];
  traceSummary: TraceabilitySummary;
  metrics: {
    total: number;
    averageRating: number | null;
    negativeShare: number;
    versions: number;
  };
};

type CollectReviewsResponse =
  | {
      ok: true;
      appId: string;
      country: string;
      source: string;
      requestedLimit: number;
      maxPages: number;
      pagesFetched: number;
      rateLimitDelayMs: number;
      feedUrls: string[];
      rawReviews: RawReview[];
      cleanedReviews: RawReview[];
      reviews: RawReview[];
      stats: ReviewImportStats;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: string;
      };
    };

type DiscoverFindingsResponse =
  | {
      ok: true;
      findings: Finding[];
      corrections: FindingCorrection[];
      meta: {
        provider: "qwen";
        model: string;
        inputReviewCount: number;
        analyzedReviewCount: number;
        truncated: boolean;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: string;
      };
    };

type GeneratePrdResponse =
  | {
      ok: true;
      prdMarkdown: string;
      meta: {
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
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: string;
      };
    };

type LogLevel = "info" | "success" | "warning" | "error" | "correction";

type ExecutionLogEntry = {
  id: string;
  timestamp: number;
  step: string;
  level: LogLevel;
  message: string;
  details?: string;
  meta?: Record<string, unknown>;
};

type IntermediateData = {
  importedStats?: ReviewImportStats & {
    source: string;
    fileName?: string;
  };
  collection?: {
    appId: string;
    country: string;
    requestedLimit: number;
    maxPages: number;
    pagesFetched: number;
    rateLimitDelayMs: number;
    feedUrls: string[];
    rawCount: number;
    cleanedCount: number;
  };
  analysisDraft?: {
    requirementCount: number;
    testCaseCount: number;
    versionPlanCount: number;
  };
  findings?: Finding[];
  findingsMeta?: {
    provider: string;
    model: string;
    inputReviewCount: number;
    analyzedReviewCount: number;
    truncated: boolean;
  };
  corrections?: FindingCorrection[];
  traceSummary?: TraceabilitySummary;
  prdMeta?: {
    provider: string;
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
};

const TABS = [
  { id: "raw", label: "原始评论", icon: FileSpreadsheet },
  { id: "clean", label: "清洗数据", icon: Sparkles },
  { id: "themes", label: "主题分类", icon: Layers3 },
  { id: "findings", label: "发现", icon: Search },
  { id: "plan", label: "版本计划", icon: GitBranch },
  { id: "prd", label: "PRD", icon: ClipboardCheck },
  { id: "tests", label: "测试用例", icon: FlaskConical },
  { id: "trace", label: "追溯验证", icon: BarChart3 }
] as const;

const PROGRESS_STEPS = [
  { id: "read", label: "读取评论" },
  { id: "clean", label: "清洗文本" },
  { id: "theme", label: "模型发现" },
  { id: "insight", label: "校验证据" },
  { id: "prd", label: "生成 PRD" },
  { id: "trace", label: "追溯校验" }
] as const;

type ProgressStepId = (typeof PROGRESS_STEPS)[number]["id"];

const USER_FLOW_STEPS = [
  "导入 App Store 链接",
  "输入分析目标",
  "填写采集数量",
  "采集评论",
  "开始分析",
  "查看结果"
];

const POSITIVE_WORDS = [
  "good",
  "great",
  "excellent",
  "love",
  "useful",
  "fast",
  "smooth",
  "喜欢",
  "好用",
  "流畅",
  "稳定",
  "推荐",
  "方便",
  "满意"
];

const NEGATIVE_WORDS = [
  "bad",
  "terrible",
  "awful",
  "bug",
  "issue",
  "problem",
  "hate",
  "broken",
  "差",
  "不好用",
  "失败",
  "问题",
  "无法",
  "不能",
  "崩溃",
  "闪退",
  "卡"
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const REVIEW_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function pushLog(
  setter: React.Dispatch<React.SetStateAction<ExecutionLogEntry[]>>,
  entry: Omit<ExecutionLogEntry, "id" | "timestamp">
) {
  setter((current) => [
    ...current,
    {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now()
    }
  ]);
}

export default function Home() {
  const [appUrl, setAppUrl] = useState("");
  const [analysisGoal, setAnalysisGoal] = useState("");
  const [rawReviews, setRawReviews] = useState<RawReview[]>([]);
  const [cleanedReviews, setCleanedReviews] = useState<RawReview[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]["id"]>("raw");
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [runningStep, setRunningStep] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);
  const [reviewLimit, setReviewLimit] = useState("100");
  const [importMessage, setImportMessage] = useState("未导入/采集");
  const [importError, setImportError] = useState("");
  const [reviewStatus, setReviewStatus] = useState("等待导入或采集");
  const [executionLog, setExecutionLog] = useState<ExecutionLogEntry[]>([]);
  const [intermediateData, setIntermediateData] = useState<IntermediateData>({});
  const [showExecutionLog, setShowExecutionLog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const progressPercent = useMemo(() => {
    if (result) {
      return 100;
    }

    return Math.round((completedSteps.length / PROGRESS_STEPS.length) * 100);
  }, [completedSteps.length, result]);

  const canAnalyze = cleanedReviews.length > 0 && !isAnalyzing && !isCollecting;
  const canCollect = appUrl.trim().length > 0 && !isAnalyzing && !isCollecting;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setImportError("");
    setResult(null);
    setCompletedSteps([]);
    setRunningStep(null);
    setExecutionLog([]);
    setIntermediateData({});
    setShowExecutionLog(true);
    setReviewStatus("正在解析文件");

    pushLog(setExecutionLog, {
      step: "read",
      level: "info",
      message: `开始导入文件：${file.name}`
    });

    try {
      const text = await file.text();
      const source = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
      const imported = parseReviewsFromText(text, source);

      setRawReviews(imported.rawReviews);
      setCleanedReviews(imported.cleanedReviews);
      setImportMessage(`${file.name} · 原始 ${imported.stats.rawCount} 条 · 清洗 ${imported.stats.cleanedCount} 条`);
      setReviewStatus(formatReviewStats(imported.stats));
      setActiveTab("clean");
      setIntermediateData({
        importedStats: {
          ...imported.stats,
          source,
          fileName: file.name
        }
      });

      pushLog(setExecutionLog, {
        step: "read",
        level: "success",
        message: `文件导入完成：原始 ${imported.stats.rawCount} 条，清洗 ${imported.stats.cleanedCount} 条`,
        meta: { ...imported.stats, source }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件解析失败";
      setRawReviews([]);
      setCleanedReviews([]);
      setImportMessage("导入失败");
      setReviewStatus("解析失败");
      setImportError(message);

      pushLog(setExecutionLog, {
        step: "read",
        level: "error",
        message: `文件导入失败：${message}`,
        meta: { error: message }
      });
    } finally {
      event.target.value = "";
    }
  }

  async function handleCollectReviews() {
    if (!canCollect) {
      return;
    }

    const normalizedReviewLimit = clampNumber(reviewLimit, 1, 500, 100);
    setReviewLimit(String(normalizedReviewLimit));
    setIsCollecting(true);
    setShowExecutionLog(true);
    setImportError("");
    setResult(null);
    setCompletedSteps([]);
    setRunningStep(null);
    setExecutionLog([]);
    setIntermediateData({});
    setImportMessage("正在采集美国区 RSS");
    setReviewStatus("正在请求 Apple RSS");

    pushLog(setExecutionLog, {
      step: "read",
      level: "info",
      message: `开始采集美国区 RSS：App ID ${appUrl}，目标上限 ${normalizedReviewLimit} 条，最多 10 页`
    });

    try {
      const response = await fetch("/api/app-store-reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          appUrl,
          limit: normalizedReviewLimit,
          maxPages: 10,
          delayMs: 600
        })
      });
      const payload = (await response.json()) as CollectReviewsResponse;

      if (!payload.ok) {
        throw new Error(payload.error.details ? `${payload.error.message} ${payload.error.details}` : payload.error.message);
      }

      if (!response.ok) {
        throw new Error(`采集接口请求失败：HTTP ${response.status}`);
      }

      setRawReviews(payload.rawReviews);
      setCleanedReviews(payload.cleanedReviews);
      setImportMessage(
        `美国区 RSS · App ID ${payload.appId} · 目标 ${normalizedReviewLimit} 条 · 原始 ${payload.stats.rawCount} 条 · 清洗 ${payload.stats.cleanedCount} 条`
      );
      setReviewStatus(
        payload.cleanedReviews.length
          ? `${formatReviewStats(payload.stats)} · 请求 ${normalizedReviewLimit} 条，实际清洗 ${payload.cleanedReviews.length} 条`
          : "采集完成，无美国区评论"
      );
      setActiveTab("clean");
      setIntermediateData({
        collection: {
          appId: payload.appId,
          country: payload.country,
          requestedLimit: payload.requestedLimit,
          maxPages: payload.maxPages,
          pagesFetched: payload.pagesFetched,
          rateLimitDelayMs: payload.rateLimitDelayMs,
          feedUrls: payload.feedUrls,
          rawCount: payload.stats.rawCount,
          cleanedCount: payload.stats.cleanedCount
        }
      });

      pushLog(setExecutionLog, {
        step: "read",
        level: "success",
        message: `RSS 采集完成：原始 ${payload.stats.rawCount} 条，清洗 ${payload.stats.cleanedCount} 条，实际请求 ${payload.pagesFetched} 页`,
        meta: {
          appId: payload.appId,
          pagesFetched: payload.pagesFetched,
          requestedLimit: normalizedReviewLimit,
          ...payload.stats
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "评论采集失败";
      setRawReviews([]);
      setCleanedReviews([]);
      setImportMessage("采集失败");
      setReviewStatus("采集失败");
      setImportError(message);

      pushLog(setExecutionLog, {
        step: "read",
        level: "error",
        message: `RSS 采集失败：${message}`,
        meta: { error: message }
      });
    } finally {
      setIsCollecting(false);
    }
  }

  async function handleStartAnalysis() {
    if (!canAnalyze) {
      return;
    }

    const reviews = cleanedReviews;
    setIsAnalyzing(true);
    setShowExecutionLog(true);
    setImportError("");
    setReviewStatus("开始分析流程");
    setResult(null);
    setCompletedSteps([]);
    setRunningStep(null);

    pushLog(setExecutionLog, {
      step: "read",
      level: "info",
      message: `开始全流程分析，输入 ${reviews.length} 条清洗后评论`
    });

    let modelFindings: Finding[] = [];
    let findingsCorrections: FindingCorrection[] = [];
    let findingsMeta: IntermediateData["findingsMeta"] | undefined;
    let analysisDraft: AnalysisResult | null = null;
    let prdPayload: { prdMarkdown: string; meta: NonNullable<IntermediateData["prdMeta"]> } | null = null;
    let currentStepId: ProgressStepId | "unknown" = "unknown";

    try {
      for (const step of PROGRESS_STEPS) {
        currentStepId = step.id;
        setRunningStep(step.id);
        pushLog(setExecutionLog, {
          step: step.id,
          level: "info",
          message: `进入步骤：${step.label}`
        });

        if (step.id === "read") {
          pushLog(setExecutionLog, {
            step: step.id,
            level: "success",
            message: `评论数据已就绪：${reviews.length} 条`
          });
        } else if (step.id === "clean") {
          pushLog(setExecutionLog, {
            step: step.id,
            level: "success",
            message: "清洗与去重已完成"
          });
        } else if (step.id === "theme") {
          const themeResult = await discoverFindings(reviews, analysisGoal);
          modelFindings = themeResult.findings;
          findingsCorrections = themeResult.corrections;
          findingsMeta = themeResult.meta;
          setIntermediateData((current) => ({
            ...current,
            findings: modelFindings,
            findingsMeta,
            corrections: findingsCorrections
          }));

          pushLog(setExecutionLog, {
            step: step.id,
            level: "success",
            message: `主题发现完成：${modelFindings.length} 个 findings，分析 ${themeResult.meta.analyzedReviewCount}/${themeResult.meta.inputReviewCount} 条评论`,
            meta: themeResult.meta
          });

          if (findingsCorrections.length) {
            pushLog(setExecutionLog, {
              step: step.id,
              level: "correction",
              message: `模型输出自动修正 ${findingsCorrections.length} 处`,
              meta: { corrections: findingsCorrections }
            });
          }
        } else if (step.id === "insight") {
          analysisDraft = buildAnalysis(reviews, analysisGoal, appUrl, modelFindings);
          setIntermediateData((current) => ({
            ...current,
            analysisDraft: {
              requirementCount: analysisDraft?.requirements.length ?? 0,
              testCaseCount: analysisDraft?.testCases.length ?? 0,
              versionPlanCount: analysisDraft?.versionPlans.length ?? 0
            }
          }));
          pushLog(setExecutionLog, {
            step: step.id,
            level: "success",
            message: `证据校验完成：${analysisDraft.requirements.length} 个 requirements，${analysisDraft.testCases.length} 个 test cases`
          });
        } else if (step.id === "prd") {
          if (!analysisDraft) {
            throw new Error("分析草稿未生成，无法生成 PRD");
          }
          const draft = analysisDraft;
          setReviewStatus("正在调用千问生成 PRD");
          const prdResult = await generatePrdMarkdown({
            cleanedReviews: draft.cleanReviews,
            findings: draft.findings,
            requirements: draft.requirements,
            analysisGoal,
            appName: deriveAppName(appUrl)
          });
          prdPayload = prdResult;
          setIntermediateData((current) => ({
            ...current,
            prdMeta: prdResult.meta
          }));
          pushLog(setExecutionLog, {
            step: step.id,
            level: "success",
            message: `PRD 生成完成：${prdResult.meta.requirementCount} 个 requirements，${prdResult.meta.findingCount} 个 findings`,
            meta: prdResult.meta
          });
        } else if (step.id === "trace") {
          if (!analysisDraft) {
            throw new Error("分析草稿未生成，无法进行追溯校验");
          }
          const draft = analysisDraft;
          setIntermediateData((current) => ({
            ...current,
            traceSummary: draft.traceSummary
          }));
          const { traceSummary } = draft;
          pushLog(setExecutionLog, {
            step: step.id,
            level: traceSummary.status === "fail" ? "error" : traceSummary.status === "warning" ? "warning" : "success",
            message: `追溯校验完成：总计 ${traceSummary.total} 项，通过 ${traceSummary.pass}，警告 ${traceSummary.warning}，失败 ${traceSummary.fail}`,
            meta: traceSummary
          });
        }

        await wait(240);
        setCompletedSteps((current) => [...current, step.id]);
      }

      if (!analysisDraft) {
        throw new Error("分析流程未完成");
      }

      const finalResult = {
        ...analysisDraft,
        prdMarkdown: prdPayload?.prdMarkdown ?? ""
      };
      setResult(finalResult);
      setReviewStatus(`分析完成 · ${modelFindings.length} 个 finding · PRD 已生成`);
      setActiveTab("prd");
    } catch (error) {
      const message = error instanceof Error ? error.message : "分析流程失败";
      setImportError(message);
      setReviewStatus("分析流程失败");
      pushLog(setExecutionLog, {
        step: currentStepId,
        level: "error",
        message: `分析失败：${message}`,
        meta: { error: message }
      });

      if (analysisDraft) {
        setResult({
          ...analysisDraft,
          prdMarkdown: prdPayload?.prdMarkdown ?? ""
        });
      }
    } finally {
      setRunningStep(null);
      setIsAnalyzing(false);
    }
  }

  const metrics = result?.metrics ?? {
    total: cleanedReviews.length,
    averageRating: average(cleanedReviews.map((review) => review.rating)),
    negativeShare: 0,
    versions: countDistinct(cleanedReviews.map((review) => review.version).filter(Boolean))
  };

  return (
    <main className="appShell">
      <section className="topBar" aria-label="工作台输入">
        <div className="brandBlock">
          <span className="brandMark">
            <BarChart3 size={22} aria-hidden="true" />
          </span>
          <div>
            <h1>App Review PRD Lab</h1>
            <p>App Store 评论分析工作台</p>
          </div>
        </div>

        <div className="actionCluster">
          <button
            className="secondaryButton"
            type="button"
            disabled={!canCollect}
            onClick={handleCollectReviews}
          >
            {isCollecting ? (
              <Loader2 className="spin" size={18} aria-hidden="true" />
            ) : (
              <DownloadCloud size={18} aria-hidden="true" />
            )}
            采集美国区评论
          </button>
          <button
            className="secondaryButton"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={18} aria-hidden="true" />
            导入 JSON/CSV
          </button>
          <button
            className="primaryButton"
            type="button"
            disabled={!canAnalyze}
            onClick={handleStartAnalysis}
          >
            {isAnalyzing ? (
              <Loader2 className="spin" size={18} aria-hidden="true" />
            ) : (
              <Play size={18} aria-hidden="true" />
            )}
            开始分析
          </button>
          <input
            ref={fileInputRef}
            className="hiddenInput"
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={handleFileChange}
          />
        </div>
      </section>

      <section className="inputBand">
        <label className="fieldGroup">
          <span>
            <Link2 size={16} aria-hidden="true" />
            App Store 链接
          </span>
          <input
            value={appUrl}
            onChange={(event) => setAppUrl(event.target.value)}
            placeholder="https://apps.apple.com/..."
          />
        </label>

        <label className="fieldGroup targetField">
          <span>
            <Target size={16} aria-hidden="true" />
            分析目标
          </span>
          <textarea
            value={analysisGoal}
            onChange={(event) => setAnalysisGoal(event.target.value)}
            placeholder="输入本次分析关注的问题、版本范围或产品目标，例如订阅转化率、锻炼可用性、特定应用版本或低评分评价"
            rows={3}
          />
        </label>

        <div className="importStatus" aria-live="polite">
          <div className="importIcon">
            <FileJson size={18} aria-hidden="true" />
            <FileSpreadsheet size={18} aria-hidden="true" />
          </div>
          <strong>{importMessage}</strong>
          <label className="pageControl">
            <span>采集数量</span>
            <input
              type="number"
              min={1}
              max={500}
              value={reviewLimit}
              disabled={isCollecting}
              onChange={(event) => setReviewLimit(event.target.value)}
            />
          </label>
          {importError ? (
            <span className="errorText">
              <AlertCircle size={15} aria-hidden="true" />
              {importError}
            </span>
          ) : (
            <span>{isCollecting ? "正在请求 Apple RSS" : reviewStatus}</span>
          )}
        </div>
      </section>

      <OperationGuide />

      <section className="statusBand" aria-label="执行进度">
        <div className="metricGrid">
          <Metric label="评论数" value={String(metrics.total)} />
          <Metric label="平均评分" value={formatRating(metrics.averageRating)} />
          <Metric label="负向占比" value={formatPercent(metrics.negativeShare)} />
          <Metric label="版本数" value={String(metrics.versions)} />
        </div>

        <div className="progressPanel">
          <div className="progressHeader">
            <span>执行进度</span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="progressTrack">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="stepGrid">
            {PROGRESS_STEPS.map((step) => {
              const isDone = completedSteps.includes(step.id) || Boolean(result);
              const isRunning = runningStep === step.id;
              return (
                <div
                  className={`stepItem ${isDone ? "done" : ""} ${isRunning ? "running" : ""}`}
                  key={step.id}
                >
                  {isDone ? (
                    <CheckCircle2 size={16} aria-hidden="true" />
                  ) : isRunning ? (
                    <Loader2 className="spin" size={16} aria-hidden="true" />
                  ) : (
                    <span className="stepDot" />
                  )}
                  {step.label}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="executionLogBand" aria-label="执行日志与中间数据">
        <div className="executionLogHeader">
          <button
            type="button"
            className="executionLogToggle"
            onClick={() => setShowExecutionLog((current) => !current)}
            aria-expanded={showExecutionLog}
          >
            <BarChart3 size={16} aria-hidden="true" />
            执行日志与中间数据
            {executionLog.length > 0 && (
              <span className="executionLogCount">{executionLog.length}</span>
            )}
            {showExecutionLog ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {showExecutionLog && (
          <div className="executionLogBody">
            {executionLog.length === 0 ? (
              <p className="executionLogEmpty">暂无执行记录，开始采集或分析后将实时展示全流程进度。</p>
            ) : (
              <>
                <ExecutionLogList entries={executionLog} />
                <IntermediateDataPanel data={intermediateData} />
              </>
            )}
          </div>
        )}
      </section>

      <section className="workspace">
        <div className="tabs" role="tablist" aria-label="分析结果">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={activeTab === tab.id ? "active" : ""}
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="tabPanel" role="tabpanel">
          {renderTab(activeTab, rawReviews, cleanedReviews, result)}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricItem">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperationGuide() {
  return (
    <section className="operationGuide" aria-label="用户操作流程">
      <div className="guideHeader">
        <strong>操作流程</strong>
        <span>按顺序完成输入、采集和分析</span>
      </div>
      <ol>
        {USER_FLOW_STEPS.map((step, index) => (
          <li key={step}>
            <span>{index + 1}</span>
            <strong>{step}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

function renderTab(
  tabId: (typeof TABS)[number]["id"],
  rawReviews: RawReview[],
  cleanedReviews: RawReview[],
  result: AnalysisResult | null
) {
  if (tabId === "raw") {
    return <ReviewsTable rows={rawReviews} />;
  }

  if (tabId === "clean") {
    return <ReviewsTable rows={result?.cleanReviews ?? cleanedReviews} clean analyzed={Boolean(result)} />;
  }

  if (!result) {
    return <EmptyState title="暂无分析结果" />;
  }

  switch (tabId) {
    case "themes":
      return <ThemeView themes={result.themes} />;
    case "findings":
      return <FindingView findings={result.findings} />;
    case "plan":
      return <PlanView plans={result.versionPlans} />;
    case "prd":
      return <PrdView items={result.requirements} markdown={result.prdMarkdown} />;
    case "tests":
      return <TestView cases={result.testCases} />;
    case "trace":
      return <TraceView rows={result.traceRows} summary={result.traceSummary} />;
    default:
      return <EmptyState title="暂无数据" />;
  }
}

function ReviewsTable({
  rows,
  clean = false,
  analyzed = false
}: {
  rows: Array<RawReview | CleanReview>;
  clean?: boolean;
  analyzed?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  if (!rows.length) {
    return <EmptyState title="暂无评论" />;
  }

  return (
    <div className="reviewTableStack">
      <div className="paginationBar">
        <span>
          共 {rows.length} 条 · 第 {currentPage} / {totalPages} 页
        </span>
        <label>
          每页
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {REVIEW_PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="paginationButtons">
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage(1)}>
            首页
          </button>
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
            上一页
          </button>
          <select value={currentPage} onChange={(event) => setPage(Number(event.target.value))}>
            {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
              <option key={pageNumber} value={pageNumber}>
                第 {pageNumber} 页
              </option>
            ))}
          </select>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
            下一页
          </button>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage(totalPages)}>
            末页
          </button>
        </div>
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>标题</th>
              <th>评分</th>
              <th>版本</th>
              <th>更新时间</th>
              <th>来源</th>
              <th>{clean ? "清洗文本" : "评论内容"}</th>
              {clean ? <th>模型主题</th> : null}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((review) => {
              const cleanReview = isCleanReview(review) ? review : null;
              return (
                <tr key={review.id}>
                  <td>{review.id}</td>
                  <td>{review.title || "--"}</td>
                  <td>{review.rating ?? "--"}</td>
                  <td>{review.version || "--"}</td>
                  <td>{review.updatedAt || review.date || "--"}</td>
                  <td>{formatReviewSource(review)}</td>
                  <td className="longCell">{cleanReview?.cleanedBody ?? review.body}</td>
                  {clean ? (
                    <td>
                      <div className="tagStack">
                        {renderModelThemeTags(cleanReview, analyzed)}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderModelThemeTags(review: CleanReview | null, analyzed: boolean) {
  if (!analyzed) {
    return <span className="smallTag pendingTag">待分析</span>;
  }

  if (!review?.themes.length) {
    return <span className="smallTag mutedTag">未归类</span>;
  }

  return review.themes.map((theme) => (
    <span className="smallTag" key={theme}>
      {theme}
    </span>
  ));
}

function ThemeView({ themes }: { themes: ThemeSummary[] }) {
  if (!themes.length) {
    return <EmptyState title="暂无主题" />;
  }

  return (
    <div className="themeGrid">
      {themes.map((theme) => (
        <article className="themeCard" key={theme.id}>
          <div className="themeHeader">
            <h2>{theme.label}</h2>
            <span>{theme.count} 条</span>
          </div>
          <div className="themeMeter">
            <span style={{ width: `${Math.min(theme.impact, 100)}%` }} />
          </div>
          <dl>
            <div>
              <dt>负向占比</dt>
              <dd>{formatPercent(theme.negativeShare)}</dd>
            </div>
            <div>
              <dt>平均评分</dt>
              <dd>{formatRating(theme.averageRating)}</dd>
            </div>
            <div>
              <dt>关联评论</dt>
              <dd>{theme.reviewIds.slice(0, 4).join("、")}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

function FindingView({ findings }: { findings: Finding[] }) {
  if (!findings.length) {
    return <EmptyState title="暂无发现" />;
  }

  return (
    <div className="listGrid">
      {findings.map((finding) => (
        <article className="resultRow findingRow" key={finding.findingId}>
          <span className="rowId">{finding.findingId}</span>
          <div>
            <h2>{finding.title}</h2>
            <p>{finding.summary}</p>
            <div className="findingMeta">
              <span>{finding.severity}</span>
              <span>confidence {Math.round(finding.confidence * 100)}%</span>
              <span>{finding.supportingReviewIds.length} 条支持</span>
              <span>{finding.contradictionReviewIds.length} 条反证</span>
            </div>
            <div className="quoteStack">
              {finding.evidenceQuotes.slice(0, 3).map((quote) => (
                <blockquote key={`${finding.findingId}-${quote.reviewId}-${quote.quote}`}>
                  <strong>{quote.reviewId}</strong>
                  {quote.quote}
                </blockquote>
              ))}
            </div>
            {finding.uncertainty ? <p className="muted">{finding.uncertainty}</p> : null}
          </div>
          <span className="reviewRefs">{finding.supportingReviewIds.slice(0, 5).join("、")}</span>
        </article>
      ))}
    </div>
  );
}

function PlanView({ plans }: { plans: VersionPlan[] }) {
  if (!plans.length) {
    return <EmptyState title="暂无版本计划" />;
  }

  return (
    <div className="listGrid">
      {plans.map((plan) => (
        <article className="resultRow" key={plan.id}>
          <span className="rowId">{plan.id}</span>
          <div>
            <h2>{plan.title}</h2>
            <p>{plan.objective}</p>
            <p className="muted">
              需求 {plan.requirementIds.join("、")} · findings {plan.findingIds.join("、")} · 评论{" "}
              {plan.sourceReviewIds.slice(0, 6).join("、")}
            </p>
            <ul className="compactList">
              {plan.exitCriteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
            <span className="releaseBadge">{targetVersionLabel(plan.targetVersion)}</span>
        </article>
      ))}
    </div>
  );
}

function PrdView({ items, markdown }: { items: Requirement[]; markdown: string }) {
  if (!items.length && !markdown.trim()) {
    return <EmptyState title="暂无 PRD" />;
  }

  return (
    <div className="prdGrid">
      {markdown.trim() ? (
        <article className="prdMarkdownBlock">
          <h2>模型生成 PRD Markdown</h2>
          <pre>{markdown}</pre>
        </article>
      ) : null}
      {items.map((item) => (
        <article className="prdBlock" key={item.requirementId}>
          <div className="prdHead">
            <span className="rowId">{item.requirementId}</span>
            <h2>{item.problem}</h2>
          </div>
          <dl>
            <div>
              <dt>Finding</dt>
              <dd>{item.findingId}</dd>
            </div>
            <div>
              <dt>来源评论</dt>
              <dd>{item.sourceReviewIds.join("、")}</dd>
            </div>
            <div>
              <dt>目标</dt>
              <dd>{item.goal}</dd>
            </div>
            <div>
              <dt>不做</dt>
              <dd>
                <ul>
                  {item.nonGoals.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>验收</dt>
              <dd>
                <ul>
                  {item.acceptanceCriteria.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>优先级 / 目标版本</dt>
              <dd>
                 {item.priority} · {targetVersionLabel(item.targetVersion)}
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

function TestView({ cases: testCases }: { cases: TestCase[] }) {
  if (!testCases.length) {
    return <EmptyState title="暂无测试用例" />;
  }

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>用例</th>
            <th>需求</th>
            <th>来源评论</th>
            <th>标题</th>
            <th>前置条件</th>
            <th>步骤</th>
            <th>预期</th>
          </tr>
        </thead>
        <tbody>
          {testCases.map((testCase) => (
            <tr key={testCase.testCaseId}>
              <td>{testCase.testCaseId}</td>
              <td>{testCase.requirementId}</td>
              <td>{testCase.sourceReviewIds.join("、")}</td>
              <td>{testCase.title}</td>
              <td>{testCase.precondition}</td>
              <td className="longCell">{testCase.steps.join(" → ")}</td>
              <td>{testCase.expected}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TraceView({ rows, summary }: { rows: TraceRow[]; summary: TraceabilitySummary }) {
  if (!rows.length) {
    return <EmptyState title="暂无追溯校验结果" />;
  }

  return (
    <div className="traceStack">
      <div className="traceSummary" aria-label="Traceability summary">
        <div>
          <span>overall</span>
          <strong className={`statusText statusText-${summary.status}`}>{summary.status}</strong>
        </div>
        <div>
          <span>total</span>
          <strong>{summary.total}</strong>
        </div>
        <div>
          <span>pass</span>
          <strong>{summary.pass}</strong>
        </div>
        <div>
          <span>warning</span>
          <strong>{summary.warning}</strong>
        </div>
        <div>
          <span>fail</span>
          <strong>{summary.fail}</strong>
        </div>
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Entity</th>
              <th>Entity ID</th>
              <th>Check</th>
              <th>Message</th>
              <th>Related IDs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>
                  <span className={`statusPill status-${row.status}`}>{row.status}</span>
                </td>
                <td>{row.entityType}</td>
                <td>{row.entityId}</td>
                <td>{row.check}</td>
                <td className="longCell">{row.message}</td>
                <td className="longCell">{row.relatedIds.length ? row.relatedIds.join(", ") : "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="emptyState">
      <Search size={28} aria-hidden="true" />
      <strong>{title}</strong>
    </div>
  );
}

async function discoverFindings(cleanedReviews: RawReview[], analysisGoal: string) {
  const response = await fetch("/api/findings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      cleanedReviews,
      analysisGoal
    })
  });
  const payload = (await response.json()) as DiscoverFindingsResponse;

  if (!payload.ok) {
    throw new Error(payload.error.details ? `${payload.error.message} ${payload.error.details}` : payload.error.message);
  }

  if (!response.ok) {
    throw new Error(`动态主题发现接口失败：HTTP ${response.status}`);
  }

  assertFindingReviewIds(payload.findings, new Set(cleanedReviews.map((review) => review.id)));
  return {
    findings: payload.findings,
    corrections: payload.corrections,
    meta: payload.meta
  };
}

function assertFindingReviewIds(findings: Finding[], knownReviewIds: Set<string>) {
  for (const finding of findings) {
    const ids = [
      ...finding.supportingReviewIds,
      ...finding.contradictionReviewIds,
      ...finding.evidenceQuotes.map((quote) => quote.reviewId)
    ];
    const unknownIds = ids.filter((id) => !knownReviewIds.has(id));
    if (unknownIds.length) {
      throw new Error(`${finding.findingId} 包含不存在的 reviewId：${unknownIds.join("、")}`);
    }
  }
}

async function generatePrdMarkdown(input: {
  cleanedReviews: RawReview[];
  findings: Finding[];
  requirements: Requirement[];
  analysisGoal: string;
  appName: string;
}) {
  let response: Response;

  try {
    response = await fetch("/api/prd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        cleanedReviews: input.cleanedReviews,
        findings: input.findings,
        requirements: toPrdRequirementInputs(input.requirements),
        analysisGoal: input.analysisGoal,
        appName: input.appName
      })
    });
  } catch (error) {
    throw new Error(
      `PRD 接口连接失败：${error instanceof Error ? error.message : String(error)}。请确认本地 Next.js 服务仍在运行。`
    );
  }

  let payload: GeneratePrdResponse;
  try {
    payload = (await response.json()) as GeneratePrdResponse;
  } catch {
    throw new Error(`PRD 接口返回异常：HTTP ${response.status}，响应不是有效 JSON。`);
  }

  if (!response.ok) {
    if (payload.ok) {
      throw new Error(`PRD 生成接口失败：HTTP ${response.status}`);
    }

    const details = payload.error.details ? ` ${payload.error.details}` : "";
    throw new Error(`[${payload.error.code}] ${payload.error.message}${details}`);
  }

  if (!payload.ok) {
    const details = payload.error.details ? ` ${payload.error.details}` : "";
    throw new Error(`[${payload.error.code}] ${payload.error.message}${details}`);
  }

  return payload;
}

function toPrdRequirementInputs(requirements: Requirement[]): PrdRequirementInput[] {
  return requirements.map((requirement) => ({
    requirementId: requirement.requirementId,
    findingId: requirement.findingId,
    sourceReviewIds: requirement.sourceReviewIds,
    problem: requirement.problem,
    goal: requirement.goal,
    nonGoals: requirement.nonGoals,
    acceptanceCriteria: requirement.acceptanceCriteria,
    priority: requirement.priority,
    targetVersion: targetVersionLabel(requirement.targetVersion)
  }));
}

function buildAnalysis(
  rawReviews: RawReview[],
  analysisGoal: string,
  appUrl: string,
  findings: Finding[],
  prdMarkdown: string = ""
): AnalysisResult {
  const cleanReviews: CleanReview[] = rawReviews.map((review) => {
    const cleanedBody = cleanText(`${review.title} ${review.body}`);
    const sentimentScore = scoreSentiment(cleanedBody, review.rating);
    const sentiment: Sentiment =
      sentimentScore > 0 ? "positive" : sentimentScore < 0 ? "negative" : "neutral";

    return {
      ...review,
      cleanedBody,
      tokens: tokenize(cleanedBody),
      sentimentScore,
      sentiment,
      themes: findings
        .filter((finding) => finding.supportingReviewIds.includes(review.id))
        .map((finding) => finding.title)
    };
  });

  const themes = summarizeFindings(cleanReviews, findings);
  const goal = analysisGoal.trim() || "提升高频评论问题的产品体验";
  const source = extractAppStoreId(appUrl);
  const knownReviewIds = new Set(rawReviews.map((review) => review.id));
  const versionCounters: Record<TargetVersion, number> = {
    V1: 0,
    V2: 0,
    Later: 0
  };
  const requirements = findings
    .map((finding) => buildRequirement(finding, goal, source, knownReviewIds, versionCounters))
    .filter((requirement): requirement is Requirement => Boolean(requirement));

  const versionPlans = buildVersionPlans(requirements, findings, goal);
  const testCases = requirements.flatMap((requirement, index) =>
    buildTestCases(requirement, findings.find((finding) => finding.findingId === requirement.findingId), index)
  );
  const traceability = validateTraceability({
    reviews: rawReviews,
    findings,
    requirements,
    testCases
  });

  return {
    cleanReviews,
    themes,
    findings,
    prdMarkdown,
    versionPlans,
    requirements,
    testCases,
    traceRows: traceability.issues,
    traceSummary: traceability.summary,
    metrics: {
      total: rawReviews.length,
      averageRating: average(rawReviews.map((review) => review.rating)),
      negativeShare:
        cleanReviews.length === 0
          ? 0
          : cleanReviews.filter((review) => review.sentiment === "negative").length / cleanReviews.length,
      versions: countDistinct(rawReviews.map((review) => review.version).filter(Boolean))
    }
  };
}

function buildRequirement(
  finding: Finding,
  analysisGoal: string,
  appSource: string,
  knownReviewIds: Set<string>,
  versionCounters: Record<TargetVersion, number>
): Requirement | null {
  const sourceReviewIds = getFindingSourceReviewIds(finding, knownReviewIds);
  if (!sourceReviewIds.length) {
    return null;
  }

  const priority = choosePriority(finding, sourceReviewIds.length);
  const targetVersion = chooseTargetVersion(priority);
  const uncertaintyNote = finding.uncertainty ? ` 不确定性：${finding.uncertainty}` : "";
  const appSourceNote = appSource ? `（${appSource}）` : "";
  versionCounters[targetVersion] += 1;
  const requirementId = `REQ-${targetVersionCode(targetVersion)}-${String(versionCounters[targetVersion]).padStart(2, "0")}`;

  return {
    requirementId,
    findingId: finding.findingId,
    sourceReviewIds,
    problem: `${finding.title}：${finding.summary}${uncertaintyNote}`,
    goal: `${analysisGoal}${appSourceNote}。针对 ${sourceReviewIds.join("、")} 反映的问题，降低该 finding 的复现率并让用户路径可完成。`,
    nonGoals: [
      "不处理未被 sourceReviewIds 支持的其他主题或泛化场景",
      "不以重写整条业务链路作为本需求交付范围",
      "不把 contradictionReviewIds 视为已解决证据，需单独复核"
    ],
    acceptanceCriteria: [
      `来源评论 ${sourceReviewIds.join("、")} 描述的核心问题在对应用户路径中不再复现`,
      "相关异常、失败或困惑状态必须有明确反馈、恢复路径或可验证的状态变化",
      `测试用例必须覆盖 requirementId=${requirementId} 与全部 sourceReviewIds`,
      finding.uncertainty
        ? "uncertainty 中的假设必须被产品、数据或人工复核结论确认后才能关闭需求"
        : "上线后通过评论、埋点或回归结果确认该问题反馈下降"
    ],
    priority,
    targetVersion
  };
}

function buildVersionPlans(requirements: Requirement[], findings: Finding[], analysisGoal: string): VersionPlan[] {
  const findingById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const versions: TargetVersion[] = ["V1", "V2", "Later"];

  return versions
    .map((targetVersion) => {
      const items = requirements.filter((requirement) => requirement.targetVersion === targetVersion);
      const sourceReviewIds = uniqueStrings(items.flatMap((item) => item.sourceReviewIds));
      const findingTitles = items
        .map((item) => findingById.get(item.findingId)?.title)
        .filter((title): title is string => Boolean(title));

      return {
        id: `VP-${targetVersion}`,
        targetVersion,
        title: `${targetVersionLabel(targetVersion)} 版本计划`,
        objective: items.length
          ? `${analysisGoal}；优先交付 ${findingTitles.slice(0, 3).join("、")}`
          : `${targetVersionLabel(targetVersion)} 暂无需求`,
        requirementIds: items.map((item) => item.requirementId),
        findingIds: items.map((item) => item.findingId),
        sourceReviewIds,
        exitCriteria: [
          "版本范围内所有 requirement 都完成验收标准评审",
          "每个 requirement 至少有一条测试用例覆盖来源评论问题",
          "上线后保留 sourceReviewIds、findingId、requirementId 的追溯链路"
        ]
      };
    })
    .filter((plan) => plan.requirementIds.length > 0);
}

function buildTestCases(requirement: Requirement, finding: Finding | undefined, index: number): TestCase[] {
  const evidenceQuotes = finding?.evidenceQuotes ?? [];
  const primaryEvidence = evidenceQuotes[0]?.quote || finding?.summary || requirement.problem;
  const evidenceLabel = truncateForDisplay(primaryEvidence);
  const findingTitle = finding?.title || requirement.findingId;
  const sourceLabel = requirement.sourceReviewIds.join("、");
  const contradictionLabel = finding?.contradictionReviewIds?.length
    ? `反证评论 ${finding.contradictionReviewIds.join("、")}：${truncateForDisplay(
        evidenceQuotes.find((quote) => finding.contradictionReviewIds.includes(quote.reviewId))?.quote || "存在相反观点"
      )}`
    : "未发现已标记的反证评论";
  const uncertaintyStep = finding?.uncertainty
    ? `复核 finding 的不确定性：${truncateForDisplay(finding.uncertainty)}，记录人工确认结果`
    : "确认来源评论中的用户路径在当前版本仍可稳定复现";

  return [
    {
      testCaseId: `TC-${String(index * 2 + 1).padStart(2, "0")}`,
      requirementId: requirement.requirementId,
      sourceReviewIds: requirement.sourceReviewIds,
      title: `${requirement.requirementId} ${findingTitle} 修复验证`,
      precondition: `已定位来源评论 ${sourceLabel}，并实现 ${findingTitle} 相关需求`,
      steps: [
        `从来源评论 ${sourceLabel} 中提取复现路径，原始证据为：“${evidenceLabel}”`,
        `在 ${targetVersionLabel(requirement.targetVersion)} 当前候选版本执行与“${findingTitle}”对应的用户路径`,
        `检查 ${findingTitle} 描述的失败表现是否消失，并记录关键状态、错误提示和完成结果`,
        "逐条验证 acceptanceCriteria 是否满足"
      ],
      expected: `来源评论 ${sourceLabel} 描述的问题被解决或被明确反馈机制覆盖；${requirement.acceptanceCriteria[0]}`
    },
    {
      testCaseId: `TC-${String(index * 2 + 2).padStart(2, "0")}`,
      requirementId: requirement.requirementId,
      sourceReviewIds: requirement.sourceReviewIds,
      title: `${requirement.requirementId} 冲突观点与回归验证`,
      precondition: contradictionLabel,
      steps: [
        `执行来源评论 ${sourceLabel} 对应路径的相邻版本、边界输入或异常状态`,
        `确认修复没有引入与“${findingTitle}”相关的新失败、误导或性能问题`,
        uncertaintyStep,
        `确认 ${requirement.requirementId}、${requirement.findingId} 与 sourceReviewIds ${sourceLabel} 的验证记录可追溯`
      ],
      expected: `修复不会破坏相邻场景；${contradictionLabel}；若有 uncertainty，必须形成明确复核结论或保留后续跟踪项`
    }
  ];
}

function getFindingSourceReviewIds(finding: Finding, knownReviewIds: Set<string>) {
  return uniqueStrings([
    ...finding.supportingReviewIds,
    ...finding.evidenceQuotes.map((quote) => quote.reviewId)
  ]).filter((reviewId) => knownReviewIds.has(reviewId));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function chooseTargetVersion(priority: RequirementPriority): TargetVersion {
  if (priority === "P0") {
    return "V1";
  }

  if (priority === "P1") {
    return "V2";
  }

  return "Later";
}

function targetVersionCode(targetVersion: TargetVersion) {
  return targetVersion === "Later" ? "v3" : targetVersion.toLowerCase();
}

function targetVersionLabel(targetVersion: TargetVersion) {
  return targetVersion === "Later" ? "V3.0" : `${targetVersion}.0`;
}

function truncateForDisplay(value: string, maxLength = 180) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function choosePriority(finding: Finding, sourceCount: number): RequirementPriority {
  if (finding.severity === "critical" && finding.confidence >= 0.75 && sourceCount >= 2) {
    return "P0";
  }

  if ((finding.severity === "critical" || finding.severity === "high") && sourceCount >= 2) {
    return "P1";
  }

  return "P2";
}

function summarizeFindings(reviews: CleanReview[], findings: Finding[]): ThemeSummary[] {
  const reviewById = new Map(reviews.map((review) => [review.id, review]));

  return findings
    .map((finding) => {
      const matched = finding.supportingReviewIds
        .map((reviewId) => reviewById.get(reviewId))
        .filter((review): review is CleanReview => Boolean(review));
      const ratings = matched.map((review) => review.rating);
      const negativeCount = matched.filter((review) => review.sentiment === "negative").length;
      const averageRating = average(ratings);
      const negativeShare = matched.length ? negativeCount / matched.length : 0;
      const ratingPressure = averageRating === null ? 20 : Math.max(0, 5 - averageRating) * 10;
      const impact = Math.min(
        100,
        severityImpact(finding.severity) * finding.confidence + matched.length * 4 + negativeShare * 20 + ratingPressure
      );

      return {
        id: finding.findingId,
        label: finding.title,
        count: matched.length,
        negativeCount,
        negativeShare,
        averageRating,
        impact,
        reviewIds: matched.map((review) => review.id),
        severity: finding.severity,
        confidence: finding.confidence,
        uncertainty: finding.uncertainty
      };
    })
    .sort((a, b) => b.impact - a.impact || b.count - a.count);
}

function severityImpact(severity: Finding["severity"]) {
  switch (severity) {
    case "critical":
      return 80;
    case "high":
      return 64;
    case "medium":
      return 42;
    case "low":
      return 24;
  }
}

function scoreSentiment(text: string, rating: number | null): number {
  const lower = text.toLowerCase();
  const wordScore =
    POSITIVE_WORDS.filter((word) => lower.includes(word.toLowerCase())).length -
    NEGATIVE_WORDS.filter((word) => lower.includes(word.toLowerCase())).length;

  const ratingScore = rating === null ? 0 : rating >= 4 ? 1 : rating <= 2 ? -1 : 0;
  return wordScore + ratingScore;
}

function cleanText(text: string) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,!?，。！？-]/gu, "")
    .trim();
}

function tokenize(text: string) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[\s,，.。!！?？-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1)
    )
  ).slice(0, 40);
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!valid.length) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function countDistinct(values: string[]) {
  return new Set(values.filter(Boolean)).size;
}

function formatRating(value: number | null) {
  return value === null ? "--" : value.toFixed(1);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatReviewSource(review: RawReview | CleanReview) {
  if (review.source === "rss") {
    return `RSS p${review.page ?? "--"}`;
  }

  return review.source.toUpperCase();
}

function formatReviewStats(stats: ReviewImportStats) {
  return `已就绪 · 删除空评论 ${stats.removedEmptyCount} 条 · 去重 ${stats.duplicateCount} 条`;
}

function clampNumber(value: string, min: number, max: number, fallback: number) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function extractAppStoreId(url: string) {
  const match = url.match(/id\d+/i);
  return match?.[0] ?? "";
}

function deriveAppName(url: string) {
  const slugMatch = url.match(/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/([^/?#]+)\/id\d+/i);
  const slug = slugMatch?.[1] ?? "";
  if (!slug) {
    return extractAppStoreId(url) || "Unknown App";
  }

  return slug
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isCleanReview(review: RawReview | CleanReview): review is CleanReview {
  return "cleanedBody" in review;
}

function ExecutionLogList({ entries }: { entries: ExecutionLogEntry[] }) {
  return (
    <div className="executionLogList">
      <h4>执行日志</h4>
      {entries.map((entry) => (
        <div key={entry.id} className={`executionLogItem ${logLevelClass(entry.level)}`}>
          <span className="executionLogTime">{formatLogTime(entry.timestamp)}</span>
          <span className="executionLogStep">{entry.step}</span>
          <span className="executionLogLevel">{logLevelLabel(entry.level)}</span>
          <span className="executionLogMessage">{entry.message}</span>
          {entry.details ? <p className="executionLogDetails">{entry.details}</p> : null}
          {entry.meta ? <pre className="executionLogMeta">{formatLogMeta(entry.meta)}</pre> : null}
        </div>
      ))}
    </div>
  );
}

function IntermediateDataPanel({ data }: { data: IntermediateData }) {
  const hasData = Boolean(
    data.importedStats ||
      data.collection ||
      data.analysisDraft ||
      data.findingsMeta ||
      data.findings ||
      (data.corrections && data.corrections.length > 0) ||
      data.prdMeta ||
      data.traceSummary
  );

  return (
    <div className="intermediateDataPanel">
      <h4>中间数据快照</h4>
      {!hasData ? <p className="intermediateDataEmpty">暂无中间数据。</p> : null}
      {data.importedStats ? (
        <div className="intermediateDataCard">
          <strong>导入数据</strong>
          <span>来源：{data.importedStats.source.toUpperCase()}</span>
          {data.importedStats.fileName ? <span>文件：{data.importedStats.fileName}</span> : null}
          <span>原始：{data.importedStats.rawCount} 条</span>
          <span>清洗：{data.importedStats.cleanedCount} 条</span>
          <span>去重：{data.importedStats.duplicateCount} 条</span>
          <span>空评论：{data.importedStats.removedEmptyCount} 条</span>
        </div>
      ) : null}
      {data.collection ? (
        <div className="intermediateDataCard">
          <strong>RSS 采集</strong>
          <span>App ID：{data.collection.appId}</span>
          <span>地区：{data.collection.country.toUpperCase()}</span>
          <span>目标数量：{data.collection.requestedLimit} 条</span>
          <span>实际页数：{data.collection.pagesFetched}/{data.collection.maxPages}</span>
          <span>限速间隔：{data.collection.rateLimitDelayMs} ms</span>
          <span>原始/清洗：{data.collection.rawCount}/{data.collection.cleanedCount}</span>
        </div>
      ) : null}
      {data.analysisDraft ? (
        <div className="intermediateDataCard">
          <strong>本地结构化草稿</strong>
          <span>需求：{data.analysisDraft.requirementCount}</span>
          <span>测试用例：{data.analysisDraft.testCaseCount}</span>
          <span>版本计划：{data.analysisDraft.versionPlanCount}</span>
        </div>
      ) : null}
      {data.findingsMeta ? (
        <div className="intermediateDataCard">
          <strong>主题发现</strong>
          <span>模型：{data.findingsMeta.model}</span>
          <span>输入评论：{data.findingsMeta.inputReviewCount} 条</span>
          <span>实际分析：{data.findingsMeta.analyzedReviewCount} 条</span>
          <span>是否截断：{data.findingsMeta.truncated ? "是" : "否"}</span>
        </div>
      ) : null}
      {data.findings ? (
        <div className="intermediateDataCard">
          <strong>Findings</strong>
          <span>数量：{data.findings.length}</span>
        </div>
      ) : null}
      {data.corrections && data.corrections.length > 0 ? (
        <div className="intermediateDataCard">
          <strong>模型输出修正记录</strong>
          <ul className="correctionList">
            {data.corrections.map((correction, index) => (
              <li key={`${correction.findingId}-${correction.type}-${index}`}>
                <span className="correctionType">{correction.type}</span>
                <span className="correctionFinding">{correction.findingId}</span>
                <span>{correction.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.prdMeta ? (
        <div className="intermediateDataCard">
          <strong>PRD 生成</strong>
          <span>模型：{data.prdMeta.model}</span>
          <span>Requirements：{data.prdMeta.requirementCount}</span>
          <span>Findings：{data.prdMeta.findingCount}</span>
          <span>Source Reviews：{data.prdMeta.sourceReviewCount}</span>
          <span>后验校验：{data.prdMeta.validation.status}</span>
          <span>校验需求：{data.prdMeta.validation.checkedRequirementCount}</span>
          <span>校验来源评论：{data.prdMeta.validation.checkedSourceReviewCount}</span>
        </div>
      ) : null}
      {data.traceSummary ? (
        <div className="intermediateDataCard">
          <strong>追溯校验</strong>
          <span>状态：{data.traceSummary.status}</span>
          <span>总计：{data.traceSummary.total}</span>
          <span>通过：{data.traceSummary.pass}</span>
          <span>警告：{data.traceSummary.warning}</span>
          <span>失败：{data.traceSummary.fail}</span>
        </div>
      ) : null}
    </div>
  );
}

function formatLogTime(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatLogMeta(meta: Record<string, unknown>) {
  return JSON.stringify(meta, null, 2);
}

function logLevelClass(level: LogLevel) {
  switch (level) {
    case "success":
      return "log-success";
    case "warning":
      return "log-warning";
    case "error":
      return "log-error";
    case "correction":
      return "log-correction";
    default:
      return "log-info";
  }
}

function logLevelLabel(level: LogLevel) {
  switch (level) {
    case "success":
      return "成功";
    case "warning":
      return "警告";
    case "error":
      return "错误";
    case "correction":
      return "修正";
    default:
      return "信息";
  }
}
