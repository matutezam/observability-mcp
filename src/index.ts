#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LokiClient } from "./loki-client.js";
import { startHttpServer } from "./http-server.js";
import { createServerFactory, getServerHealth } from "./server.js";

const LOKI_URL = process.env.LOKI_URL;
const mode = normalizeMode(process.env.OBSERVABILITY_MCP_MODE ?? process.env.MCP_MODE);
const port = parseInt(process.env.PORT || "3000", 10);

if (!LOKI_URL) {
  console.error("LOKI_URL required");
  process.exit(1);
}

const client = new LokiClient({
  baseUrl: LOKI_URL,
  bearerToken: process.env.LOKI_BEARER_TOKEN,
  username: process.env.LOKI_USERNAME,
  password: process.env.LOKI_PASSWORD,
  tenantId: process.env.LOKI_TENANT_ID,
});

const createMcpServer = createServerFactory(client);

if (mode === "http") {
  await startHttpServer(createMcpServer, port, async () => ({
    mode,
    tools: 3,
    ...(await getServerHealth(client)),
  }));
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function normalizeMode(value?: string) {
  return String(value || "stdio").trim().toLowerCase() === "http" ? "http" : "stdio";
}
