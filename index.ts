import * as Sentry from "@sentry/node";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
import type { OpenClawPluginService } from "openclaw/plugin-sdk";

export function createSentryService(): OpenClawPluginService {
  let unsubDiag: (() => void) | null = null;
  let unsubLogs: (() => void) | null = null;

  return {
    id: "sentry",

    async start(ctx) {
      const entries = ctx.config.plugins?.entries as
        Record<string, { config?: Record<string, unknown> }> | undefined;
      const pluginCfg = entries?.sentry?.config as
        | { dsn?: string; environment?: string; tracesSampleRate?: number; enableLogs?: boolean }
        | undefined;
      const dsn = pluginCfg?.dsn;

      if (!dsn) {
        ctx.logger.warn("sentry: no DSN configured — skipping init");
        return;
      }

      // ── 1. Init Sentry SDK ──────────────────────────────────
      const enableLogs = pluginCfg?.enableLogs !== false;
      Sentry.init({
        dsn,
        environment: pluginCfg?.environment ?? "production",
        tracesSampleRate: pluginCfg?.tracesSampleRate ?? 1.0,
        enableLogs,
      });

      ctx.logger.info(
        `sentry: initialized (dsn=...${dsn.slice(-12)}, env=${pluginCfg?.environment ?? "production"}, logs=${enableLogs})`,
      );

      // ── 2. Diagnostic events → Sentry spans ────────────────
      unsubDiag = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          handleDiagnosticEvent(evt, ctx.logger);
        } catch (err) {
          ctx.logger.warn(`sentry: diagnostic handler error: ${err}`);
        }
      });
      ctx.logger.info("sentry: subscribed to diagnostic events");

      // ── 3. Gateway logs → Sentry structured logs ───────────
      if (enableLogs) {
        unsubLogs = registerLogTransport((logObj) => {
          try {
            forwardLog(logObj);
          } catch {
            // Silent — don't let log forwarding errors cascade
          }
        });
        ctx.logger.info("sentry: subscribed to log transport");
      }
    },

    async stop() {
      unsubDiag?.();
      unsubDiag = null;
      unsubLogs?.();
      unsubLogs = null;
      await Sentry.flush(5000).catch(() => undefined);
    },
  };
}

// ── Diagnostic events → spans ───────────────────────────────

function handleDiagnosticEvent(
  evt: DiagnosticEventPayload,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
): void {
  switch (evt.type) {
    case "model.usage":
      recordModelUsage(evt);
      return;

    case "message.processed":
      recordMessageProcessed(evt);
      return;

    case "webhook.error":
      Sentry.captureMessage(`Webhook error: ${evt.error}`, {
        level: "error",
        tags: { channel: evt.channel, updateType: evt.updateType },
      });
      return;

    case "session.stuck":
      Sentry.captureMessage(`Session stuck: ${evt.sessionKey} (${evt.ageMs}ms)`, {
        level: "warning",
        tags: { sessionKey: evt.sessionKey, state: evt.state },
      });
      return;
  }
}

// ── Model usage → ai.chat span with real duration ───────────

function recordModelUsage(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
): void {
  const spanName = evt.model ? `chat ${evt.model}` : "chat unknown";
  const endTimeMs = evt.ts;
  const durationMs = evt.durationMs ?? 100; // fallback to 100ms if missing
  const startTimeMs = endTimeMs - durationMs;

  // Use startInactiveSpan so we control start + end timestamps
  // Sentry v10 accepts ms, Date objects, or [sec, ns] tuples — NOT seconds
  const span = Sentry.startInactiveSpan({
    op: "ai.chat",
    name: spanName,
    startTime: startTimeMs,
    forceTransaction: true,
    attributes: {
      // GenAI semantic conventions (OpenTelemetry)
      "gen_ai.operation.name": "chat",
      "gen_ai.system": evt.provider ?? "unknown",
      "gen_ai.request.model": evt.model ?? "unknown",
      "gen_ai.usage.input_tokens": evt.usage.input ?? 0,
      "gen_ai.usage.output_tokens": evt.usage.output ?? 0,
      // OpenClaw-specific context
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.session_key": evt.sessionKey ?? "unknown",
      "openclaw.tokens.cache_read": evt.usage.cacheRead ?? 0,
      "openclaw.tokens.cache_write": evt.usage.cacheWrite ?? 0,
      "openclaw.tokens.total": evt.usage.total ?? 0,
      "openclaw.cost_usd": evt.costUsd ?? 0,
      "openclaw.duration_ms": durationMs,
    },
  });

  if (span) {
    span.end(endTimeMs);
  }
}

// ── Message processed → openclaw.message span ───────────────

function recordMessageProcessed(
  evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
): void {
  const endTimeMs = evt.ts;
  const durationMs = evt.durationMs ?? 50;
  const startTimeMs = endTimeMs - durationMs;

  const span = Sentry.startInactiveSpan({
    op: "openclaw.message",
    name: `message.${evt.outcome}`,
    startTime: startTimeMs,
    forceTransaction: true,
    attributes: {
      "openclaw.channel": evt.channel,
      "openclaw.outcome": evt.outcome,
      "openclaw.session_key": evt.sessionKey ?? "unknown",
      "openclaw.chat_id": String(evt.chatId ?? ""),
      "openclaw.message_id": String(evt.messageId ?? ""),
      "openclaw.duration_ms": durationMs,
    },
  });

  if (span) {
    if (evt.outcome === "error") {
      span.setStatus({ code: 2, message: evt.error ?? "unknown error" });
      if (evt.error) {
        Sentry.captureMessage(`Message processing error: ${evt.error}`, {
          level: "error",
          tags: { channel: evt.channel, sessionKey: evt.sessionKey },
        });
      }
    }
    span.end(endTimeMs);
  }
}

// ── Log forwarding → Sentry structured logs ─────────────────

function forwardLog(logObj: Record<string, unknown>): void {
  const meta = logObj._meta as
    | { logLevelName?: string; name?: string; date?: Date }
    | undefined;

  const level = (meta?.logLevelName ?? "INFO").toLowerCase();

  // Extract positional args (numeric keys from the log transport format)
  const numericArgs = Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);

  // Last string arg is typically the message
  let message = "";
  if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
    message = String(numericArgs.pop());
  } else if (numericArgs.length === 1) {
    message = String(numericArgs[0]);
    numericArgs.length = 0;
  }
  if (!message) message = "log";

  const loggerName = meta?.name ?? "openclaw";

  // Sentry.logger is available in SDK v9 with _experiments.enableLogs
  const loggerApi = Sentry.logger;
  if (!loggerApi) return;

  // Build attributes object for structured log
  const attrs: Record<string, unknown> = {
    "openclaw.logger": loggerName,
  };
  if (numericArgs.length > 0) {
    attrs["openclaw.args"] = JSON.stringify(numericArgs);
  }

  // Route to appropriate Sentry log level
  switch (level) {
    case "debug":
    case "trace":
      loggerApi.debug(message, attrs);
      break;
    case "warn":
      loggerApi.warn(message, attrs);
      break;
    case "error":
    case "fatal":
      loggerApi.error(message, attrs);
      break;
    default:
      loggerApi.info(message, attrs);
  }
}

// ── Plugin entry point ──────────────────────────────────────

export default function register(api: any) {
  api.registerService(createSentryService());
}
