import test from "node:test";
import assert from "node:assert/strict";
import { createToolHandlers } from "../src/server.js";

function createFakeClient() {
  return {
    async searchLogs(input: Record<string, unknown>) {
      return { tool: "search_logs", input };
    },
    async getLogContext(input: Record<string, unknown>) {
      return { tool: "get_log_context", input };
    },
    async getObservabilityHealth() {
      return { status: "ok" };
    },
  };
}

test("tool handlers validate allowed search params", async () => {
  const handlers = createToolHandlers(createFakeClient() as never);
  const result = await handlers.search_logs({
    service: "capsule-core",
    run_id: "run_123",
    since: "4h",
    limit: 20,
  });

  assert.equal(result.tool, "search_logs");
  assert.equal(result.input.service, "capsule-core");
});

test("tool handlers reject invalid context identifiers", async () => {
  const handlers = createToolHandlers(createFakeClient() as never);

  await assert.rejects(
    () => handlers.get_log_context({ before: "10m" }),
    /One of request_id, run_id, or meeting_id is required/,
  );
});

test("tool handlers expose health passthrough", async () => {
  const handlers = createToolHandlers(createFakeClient() as never);
  const result = await handlers.get_observability_health({});
  assert.deepEqual(result, { status: "ok" });
});
