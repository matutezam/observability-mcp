export type SearchLogsInput = {
  service?: string;
  level?: string;
  event?: string;
  request_id?: string;
  run_id?: string;
  meeting_id?: string;
  agent_id?: string;
  provider?: string;
  error_kind?: string;
  since?: string;
  until?: string;
  limit?: number;
};

export type LogContextInput = {
  request_id?: string;
  run_id?: string;
  meeting_id?: string;
  before?: string;
  after?: string;
  limit?: number;
};

export type ParsedLogEntry = {
  timestamp: string;
  timestamp_ns: string;
  service?: string;
  env?: string;
  level?: string;
  event?: string;
  message?: string;
  provider?: string;
  error_kind?: string;
  request_id?: string;
  run_id?: string;
  meeting_id?: string;
  agent_id?: string;
  labels: Record<string, string>;
  line: string;
  fields: Record<string, unknown>;
};

export type SearchLogsResult = {
  total: number;
  services: string[];
  events: string[];
  entries: ParsedLogEntry[];
  query: {
    logql: string;
    since: string;
    until: string;
    limit: number;
  };
};

export type LogContextResult = SearchLogsResult & {
  identifier: {
    type: "request_id" | "run_id" | "meeting_id";
    value: string;
  };
  window: {
    before: string;
    after: string;
  };
};

export type ObservabilityHealth = {
  status: "ok" | "degraded";
  loki: {
    ready: boolean;
    url: string;
  };
};

export type LokiClientConfig = {
  baseUrl: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
};
