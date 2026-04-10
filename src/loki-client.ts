import type {
  LogContextInput,
  LogContextResult,
  LokiClientConfig,
  ObservabilityHealth,
  ParsedLogEntry,
  SearchLogsInput,
  SearchLogsResult,
} from "./types.js";

type LokiStream = {
  stream: Record<string, string>;
  values: Array<[string, string]>;
};

type LokiQueryResponse = {
  status: string;
  data?: {
    resultType?: string;
    result?: LokiStream[];
  };
};

const DEFAULT_SEARCH_LOOKBACK = "1h";
const DEFAULT_CONTEXT_LOOKBACK = "24h";
const DEFAULT_CONTEXT_BEFORE = "2m";
const DEFAULT_CONTEXT_AFTER = "2m";
const DEFAULT_LIMIT = 50;
const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "prompt",
  "content",
  "body",
  "text",
  "response",
  "messages",
  "headers",
]);

export class LokiClient {
  private readonly baseUrl: string;
  private readonly bearerToken?: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly tenantId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LokiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.bearerToken = config.bearerToken;
    this.username = config.username;
    this.password = config.password;
    this.tenantId = config.tenantId;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async searchLogs(input: SearchLogsInput): Promise<SearchLogsResult> {
    const window = resolveTimeRange(input.since ?? DEFAULT_SEARCH_LOOKBACK, input.until);
    const query = buildLogql(input);
    const entries = await this.queryStructured(query, window.start, window.end, input.limit ?? DEFAULT_LIMIT);

    return {
      total: entries.length,
      services: unique(entries.map((entry) => entry.service).filter(isPresent)),
      events: unique(entries.map((entry) => entry.event).filter(isPresent)),
      entries,
      query: {
        logql: query,
        since: nsToIso(window.start),
        until: nsToIso(window.end),
        limit: input.limit ?? DEFAULT_LIMIT,
      },
    };
  }

  async getLogContext(input: LogContextInput): Promise<LogContextResult> {
    const identifier = resolveIdentifier(input);
    const seedWindow = resolveTimeRange(DEFAULT_CONTEXT_LOOKBACK);
    const seedQuery = buildLogql({ [identifier.type]: identifier.value });
    const anchors = await this.queryStructured(seedQuery, seedWindow.start, seedWindow.end, input.limit ?? DEFAULT_LIMIT);

    if (anchors.length === 0) {
      return {
        identifier,
        window: {
          before: input.before ?? DEFAULT_CONTEXT_BEFORE,
          after: input.after ?? DEFAULT_CONTEXT_AFTER,
        },
        total: 0,
        services: [],
        events: [],
        entries: [],
        query: {
          logql: seedQuery,
          since: nsToIso(seedWindow.start),
          until: nsToIso(seedWindow.end),
          limit: input.limit ?? DEFAULT_LIMIT,
        },
      };
    }

    const minTs = anchors.reduce<bigint>((current, entry) => {
      const next = BigInt(entry.timestamp_ns);
      return next < current ? next : current;
    }, BigInt(anchors[0]!.timestamp_ns));
    const maxTs = anchors.reduce<bigint>((current, entry) => {
      const next = BigInt(entry.timestamp_ns);
      return next > current ? next : current;
    }, BigInt(anchors[0]!.timestamp_ns));
    const beforeNs = parseDurationToNs(input.before ?? DEFAULT_CONTEXT_BEFORE);
    const afterNs = parseDurationToNs(input.after ?? DEFAULT_CONTEXT_AFTER);
    const start = minTs > beforeNs ? minTs - beforeNs : 0n;
    const end = maxTs + afterNs;
    const entries = await this.queryStructured(seedQuery, start, end, input.limit ?? DEFAULT_LIMIT);

    return {
      identifier,
      window: {
        before: input.before ?? DEFAULT_CONTEXT_BEFORE,
        after: input.after ?? DEFAULT_CONTEXT_AFTER,
      },
      total: entries.length,
      services: unique(entries.map((entry) => entry.service).filter(isPresent)),
      events: unique(entries.map((entry) => entry.event).filter(isPresent)),
      entries,
      query: {
        logql: seedQuery,
        since: nsToIso(start),
        until: nsToIso(end),
        limit: input.limit ?? DEFAULT_LIMIT,
      },
    };
  }

  async getObservabilityHealth(): Promise<ObservabilityHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/ready`, {
      headers: this.buildHeaders(),
    });

    return {
      status: response.ok ? "ok" : "degraded",
      loki: {
        ready: response.ok,
        url: this.baseUrl,
      },
    };
  }

  private async queryStructured(query: string, startNs: bigint, endNs: bigint, limit: number): Promise<ParsedLogEntry[]> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      direction: "BACKWARD",
      start: startNs.toString(),
      end: endNs.toString(),
    });

    const payload = (await this.requestJson(`/loki/api/v1/query_range?${params.toString()}`)) as LokiQueryResponse;
    const streams = payload.data?.result ?? [];
    const entries = streams.flatMap((stream) =>
      stream.values.map(([timestampNs, line]) => parseLogEntry(timestampNs, line, stream.stream)),
    );

    entries.sort((left, right) => {
      const l = BigInt(left.timestamp_ns);
      const r = BigInt(right.timestamp_ns);
      if (l === r) return 0;
      return l < r ? -1 : 1;
    });
    return entries;
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Loki request failed with status ${response.status}`);
    }

    return response.json();
  }

  private buildHeaders(): HeadersInit {
    const headers = new Headers();
    if (this.bearerToken) {
      headers.set("Authorization", `Bearer ${this.bearerToken}`);
    } else if (this.username || this.password) {
      const auth = Buffer.from(`${this.username ?? ""}:${this.password ?? ""}`).toString("base64");
      headers.set("Authorization", `Basic ${auth}`);
    }

    if (this.tenantId) {
      headers.set("X-Scope-OrgID", this.tenantId);
    }

    return headers;
  }
}

export function buildLogql(input: SearchLogsInput): string {
  const labelPairs = [
    input.service ? `service="${escapeLogql(input.service)}"` : null,
    input.level ? `level="${escapeLogql(input.level)}"` : null,
    input.event ? `event="${escapeLogql(input.event)}"` : null,
  ].filter(isPresent);

  const selector = labelPairs.length > 0 ? `{${labelPairs.join(",")}}` : `{service=~".+"}`;
  const jsonFilters = [
    maybeJsonFilter("request_id", input.request_id),
    maybeJsonFilter("run_id", input.run_id),
    maybeJsonFilter("meeting_id", input.meeting_id),
    maybeJsonFilter("agent_id", input.agent_id),
    maybeJsonFilter("provider", input.provider),
    maybeJsonFilter("error_kind", input.error_kind),
  ].filter(isPresent);

  if (jsonFilters.length === 0) {
    return selector;
  }

  return `${selector} | json ${jsonFilters.join(" ")}`;
}

export function resolveIdentifier(input: LogContextInput): LogContextResult["identifier"] {
  const matches = [
    input.request_id ? ({ type: "request_id", value: input.request_id } as const) : null,
    input.run_id ? ({ type: "run_id", value: input.run_id } as const) : null,
    input.meeting_id ? ({ type: "meeting_id", value: input.meeting_id } as const) : null,
  ].filter(isPresent);

  if (matches.length === 0) {
    throw new Error("One of request_id, run_id, or meeting_id is required");
  }

  if (matches.length > 1) {
    throw new Error("Use exactly one of request_id, run_id, or meeting_id");
  }

  return matches[0];
}

export function resolveTimeRange(since?: string, until?: string) {
  const endMs = until ? parseDateInput(until, Date.now()) : Date.now();
  const startMs = since ? parseDateInput(since, endMs) : endMs - parseDurationToMs(DEFAULT_SEARCH_LOOKBACK);
  if (startMs > endMs) {
    throw new Error("since must be earlier than until");
  }

  return {
    start: msToNs(startMs),
    end: msToNs(endMs),
  };
}

export function parseDurationToMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  return amount * multipliers[unit];
}

function parseDurationToNs(value: string): bigint {
  return BigInt(parseDurationToMs(value)) * 1_000_000n;
}

function parseDateInput(value: string, referenceMs: number): number {
  if (/^\d+(ms|s|m|h|d|w)$/.test(value.trim())) {
    return referenceMs - parseDurationToMs(value);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date or duration: ${value}`);
  }

  return parsed;
}

function parseLogEntry(timestampNs: string, line: string, stream: Record<string, string>): ParsedLogEntry {
  const parsed = safeJsonObject(line);
  const fields = sanitizeRecord(parsed);

  return {
    timestamp: nsToIso(BigInt(timestampNs)),
    timestamp_ns: timestampNs,
    service: readString(fields.service) ?? stream.service,
    env: readString(fields.env) ?? stream.env,
    level: readString(fields.level) ?? stream.level,
    event: readString(fields.event) ?? stream.event,
    message: readString(fields.message),
    provider: readString(fields.provider),
    error_kind: readString(fields.error_kind),
    request_id: readString(fields.request_id),
    run_id: readString(fields.run_id),
    meeting_id: readString(fields.meeting_id),
    agent_id: readString(fields.agent_id),
    labels: stream,
    line,
    fields,
  };
}

function safeJsonObject(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors — raw line is still preserved.
  }

  return {};
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[redacted]";
      continue;
    }

    if (Array.isArray(current)) {
      sanitized[key] = "[redacted]";
      continue;
    }

    if (current && typeof current === "object") {
      sanitized[key] = sanitizeRecord(current as Record<string, unknown>);
      continue;
    }

    sanitized[key] = current;
  }

  return sanitized;
}

function maybeJsonFilter(field: string, value?: string): string | null {
  return value ? `| ${field}="${escapeLogql(value)}"` : null;
}

function escapeLogql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nsToIso(valueNs: bigint): string {
  return new Date(Number(valueNs / 1_000_000n)).toISOString();
}

function msToNs(valueMs: number): bigint {
  return BigInt(valueMs) * 1_000_000n;
}
