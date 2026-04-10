import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LokiClient } from "../src/loki-client.js";

type RecordedRequest = {
  url: string;
  headers: Record<string, string | string[] | undefined>;
};

async function withLokiServer(
  handler: (request: RecordedRequest) => { status?: number; body: unknown },
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url || "/", headers: req.headers });
    const reply = handler(requests[requests.length - 1]);
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock Loki server");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("searchLogs builds Loki query with labels, JSON filters, and auth headers", async () => {
  await withLokiServer(
    () => ({
      body: {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { service: "capsule-core", level: "error", event: "provider_request_failed" },
              values: [
                [
                  "1712730000000000000",
                  "{\"service\":\"capsule-core\",\"level\":\"error\",\"event\":\"provider_request_failed\",\"message\":\"provider failed\",\"run_id\":\"run_123\",\"error_kind\":\"provider_5xx\"}",
                ],
              ],
            },
          ],
        },
      },
    }),
    async (baseUrl, requests) => {
      const client = new LokiClient({
        baseUrl,
        bearerToken: "secret-token",
        tenantId: "capsule",
      });

      const result = await client.searchLogs({
        service: "capsule-core",
        level: "error",
        event: "provider_request_failed",
        run_id: "run_123",
        since: "2h",
        limit: 10,
      });

      assert.equal(result.total, 1);
      assert.deepEqual(result.services, ["capsule-core"]);
      assert.equal(result.entries[0]?.error_kind, "provider_5xx");
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.headers.authorization, "Bearer secret-token");
      assert.equal(request.headers["x-scope-orgid"], "capsule");
      assert.match(request.url, /query_range/);
      const decodedUrl = decodeURIComponent(request.url).replace(/\+/g, " ");
      assert.match(decodedUrl, /\{service="capsule-core",level="error",event="provider_request_failed"\} \| json \| run_id="run_123"/);
    },
  );
});

test("getLogContext returns correlated entries for a run id", async () => {
  await withLokiServer(
    () => ({
      body: {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { service: "capsule-web", event: "council_run_started" },
              values: [
                ["1712730000000000000", "{\"service\":\"capsule-web\",\"event\":\"council_run_started\",\"run_id\":\"run_ctx\",\"message\":\"start\"}"],
              ],
            },
            {
              stream: { service: "capsule-core", event: "agent_turn_failed" },
              values: [
                ["1712730060000000000", "{\"service\":\"capsule-core\",\"event\":\"agent_turn_failed\",\"run_id\":\"run_ctx\",\"error_kind\":\"rate_limited\",\"message\":\"failed\"}"],
              ],
            },
          ],
        },
      },
    }),
    async (baseUrl) => {
      const client = new LokiClient({ baseUrl });
      const result = await client.getLogContext({
        run_id: "run_ctx",
        limit: 25,
      });

      assert.equal(result.identifier.type, "run_id");
      assert.equal(result.identifier.value, "run_ctx");
      assert.equal(result.total, 2);
      assert.deepEqual(result.services, ["capsule-core", "capsule-web"]);
      assert.equal(result.entries[1]?.error_kind, "rate_limited");
    },
  );
});

test("getHealth reports Loki readiness", async () => {
  await withLokiServer(
    (request) => {
      if (request.url === "/ready") {
        return { body: "ready" };
      }
      return { body: { status: "success", data: { resultType: "streams", result: [] } } };
    },
    async (baseUrl) => {
      const client = new LokiClient({ baseUrl });
      const result = await client.getObservabilityHealth();
      assert.equal(result.status, "ok");
      assert.equal(result.loki.ready, true);
    },
  );
});
