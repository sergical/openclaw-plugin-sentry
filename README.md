# openclaw-plugin-sentry

Sentry integration for [OpenClaw](https://openclaw.ai) — errors, traces, and structured logs from your AI agent, straight to Sentry.

## What it does

- **Errors**: Automatically captured via Sentry SDK (unhandled exceptions, fetch failures, etc.)
- **Traces**: Model usage (`ai.chat` spans with GenAI semantic conventions) and message processing spans with real durations
- **Structured Logs**: Gateway logs forwarded to Sentry's structured logging via `Sentry.logger`

## Install

```bash
openclaw plugins install openclaw-plugin-sentry
```

## Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["sentry"],
    "entries": {
      "sentry": {
        "enabled": true,
        "config": {
          "dsn": "https://your-key@o000000.ingest.us.sentry.io/0000000",
          "environment": "production",
          "tracesSampleRate": 1.0,
          "enableLogs": true
        }
      }
    }
  }
}
```

**Important**: You must also enable diagnostic events:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

## Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dsn` | string | — | **Required.** Sentry DSN from your project's Client Keys |
| `environment` | string | `"production"` | Environment name |
| `tracesSampleRate` | number | `1.0` | Traces sample rate (0.0–1.0) |
| `enableLogs` | boolean | `true` | Enable Sentry structured logs |

## Trace attributes

Model usage spans include [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | `"chat"` |
| `gen_ai.system` | Provider name (e.g. `amazon-bedrock`) |
| `gen_ai.request.model` | Model ID |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `openclaw.session_key` | Session identifier |
| `openclaw.channel` | Channel (telegram, discord, etc.) |
| `openclaw.cost_usd` | Estimated cost |

## Requirements

- OpenClaw `>= 2026.2.0`
- Sentry account with a Node.js project
- `diagnostics.enabled: true` in your OpenClaw config

## License

MIT
