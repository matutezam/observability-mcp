# observability-mcp

Read-only MCP server para consultar logs estructurados desde **Loki**. Está pensado para Capsule, pero sirve para cualquier stack que etiquete logs con `service`, `env`, `level` y `event`, y guarde IDs correlativos (`request_id`, `run_id`, `meeting_id`, `agent_id`) dentro del JSON del log.

## Tools expuestas

- `search_logs`
  - busca por labels de baja cardinalidad y por IDs correlativos
- `get_log_context`
  - reconstruye el contexto de un `request_id`, `run_id` o `meeting_id`
- `get_observability_health`
  - valida si Loki está reachable/ready

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `LOKI_URL` | ✅ | Base URL de Loki (`http://loki:3100`) |
| `OBSERVABILITY_MCP_MODE` | No | `stdio` (default) o `http` |
| `MCP_MODE` | No | Alias legacy para `OBSERVABILITY_MCP_MODE` |
| `PORT` | No | Puerto HTTP (default `3000`) |
| `MCP_API_KEY` | Recomendado | Bearer token para proteger `/mcp` |
| `LOKI_BEARER_TOKEN` | No | Bearer token para Loki |
| `LOKI_USERNAME` / `LOKI_PASSWORD` | No | Basic auth para Loki |
| `LOKI_TENANT_ID` | No | Header `X-Scope-OrgID` opcional |

## Despliegue en EasyPanel

1. Crear servicio **App**
2. Fuente → GitHub → `observability-mcp`
3. Variables mínimas:

   ```env
   LOKI_URL=http://loki:3100
   OBSERVABILITY_MCP_MODE=http
   MCP_API_KEY=tu_token
   PORT=3000
   ```

4. Exponer dominio y proteger el acceso con `Authorization: Bearer <MCP_API_KEY>`

## Desarrollo

```bash
npm install
npm test
npm run dev
```

## Ejemplos de uso

- Buscar fallos de provider en core:

  ```json
  {
    "service": "capsule-core",
    "event": "provider_request_failed",
    "since": "6h",
    "limit": 20
  }
  ```

- Reconstruir una corrida:

  ```json
  {
    "run_id": "run_123",
    "before": "5m",
    "after": "5m",
    "limit": 100
  }
  ```
