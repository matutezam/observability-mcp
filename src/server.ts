import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LokiClient } from "./loki-client.js";

const searchLogsSchema = z.object({
  service: z.string().optional(),
  level: z.string().optional(),
  event: z.string().optional(),
  request_id: z.string().optional(),
  run_id: z.string().optional(),
  meeting_id: z.string().optional(),
  agent_id: z.string().optional(),
  provider: z.string().optional(),
  error_kind: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const logContextSchema = z
  .object({
    request_id: z.string().optional(),
    run_id: z.string().optional(),
    meeting_id: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const count = [value.request_id, value.run_id, value.meeting_id].filter(Boolean).length;
    if (count === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "One of request_id, run_id, or meeting_id is required",
      });
    } else if (count > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use exactly one of request_id, run_id, or meeting_id",
      });
    }
  });

const emptySchema = z.object({});

export function createToolHandlers(client: Pick<LokiClient, "searchLogs" | "getLogContext" | "getObservabilityHealth">) {
  return {
    async search_logs(input: unknown) {
      const parsed = searchLogsSchema.parse(input);
      return client.searchLogs(parsed);
    },
    async get_log_context(input: unknown) {
      const parsed = logContextSchema.parse(input);
      return client.getLogContext(parsed);
    },
    async get_observability_health(input: unknown) {
      emptySchema.parse(input);
      return client.getObservabilityHealth();
    },
  };
}

export function createServerFactory(client: LokiClient): () => McpServer {
  return () => createMcpServer(client);
}

export function getServerHealth(client: Pick<LokiClient, "getObservabilityHealth">) {
  return client.getObservabilityHealth();
}

function createMcpServer(client: LokiClient) {
  const server = new McpServer({ name: "observability", version: "0.1.0" });
  const handlers = createToolHandlers(client);

  server.tool(
    "search_logs",
    "Search observability logs in Loki by low-cardinality labels and correlated IDs.",
    {
      service: z.string().optional().describe("Service label, for example capsule-core."),
      level: z.string().optional().describe("Log level label, for example error."),
      event: z.string().optional().describe("Event label, for example agent_turn_failed."),
      request_id: z.string().optional().describe("Filter by correlated request id."),
      run_id: z.string().optional().describe("Filter by council run id."),
      meeting_id: z.string().optional().describe("Filter by meeting id."),
      agent_id: z.string().optional().describe("Filter by agent id."),
      provider: z.string().optional().describe("Filter by provider field in JSON logs."),
      error_kind: z.string().optional().describe("Filter by observability error kind."),
      since: z.string().optional().describe("Relative duration or ISO timestamp for the start window."),
      until: z.string().optional().describe("Relative duration or ISO timestamp for the end window."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of entries to return."),
    },
    async (args) => wrapResult(() => handlers.search_logs(args)),
  );

  server.tool(
    "get_log_context",
    "Fetch correlated log context for exactly one request_id, run_id, or meeting_id.",
    {
      request_id: z.string().optional().describe("Request id to correlate."),
      run_id: z.string().optional().describe("Run id to correlate."),
      meeting_id: z.string().optional().describe("Meeting id to correlate."),
      before: z.string().optional().describe("Extra lookback window around the first matching entry."),
      after: z.string().optional().describe("Extra lookahead window around the last matching entry."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of entries to return."),
    },
    async (args) => wrapResult(() => handlers.get_log_context(args)),
  );

  server.tool(
    "get_observability_health",
    "Check whether Loki is reachable and ready.",
    {},
    async (args) => wrapResult(() => handlers.get_observability_health(args)),
  );

  return server;
}

async function wrapResult(run: () => Promise<unknown>) {
  try {
    const data = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true as const,
    };
  }
}
