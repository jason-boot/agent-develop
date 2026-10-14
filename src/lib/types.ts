export type UsageRecord = {
  request_id: string;
  user_id: number;
  department_id: number | null;
  provider: string | null;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number;
  total_tokens: number;
  total_cost: number | string;
  estimated_cost: number | string;
  currency: string;
  status: string;
  latency_ms: number | null;
  request_received_at: string;
};

export type UsageSummary = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  totalTokens: number;
  totalCost: number | string;
  avgLatency: number;
  successCount: number;
  failedCount: number;
  activeUserCount: number;
  currency: string;
};

export type DailyModelUsage = { day: string; model_name: string; request_count: number };
export type UsageChartSpec = {
  type: "line" | "bar";
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
};

export type ToolTrace = { tool: string; label: string; detail: string };
export type ProjectFileChange = { path: string; content: string; originalContent?: string; operation: "create" | "update" };
export type ChatReply = { answer: string; records: UsageRecord[]; summary: UsageSummary; intent: string; periodLabel: string; from?: string; to?: string; trace: ToolTrace[]; messageOnly?: boolean; showRecords?: boolean; dailyModelUsage?: DailyModelUsage[]; chartSpec?: UsageChartSpec; generatedImages?: string[]; projectChanges?: ProjectFileChange[] };
