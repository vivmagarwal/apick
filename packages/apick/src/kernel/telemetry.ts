import { metrics, trace, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { VERSION } from '../version.js';

/**
 * OpenTelemetry out of the box, the library way: instrument against the
 * @opentelemetry/api no-op surface. If the host application registers an SDK
 * (NodeSDK, a trace provider, a meter provider), APIck's spans and metrics
 * flow into it; otherwise everything is a zero-cost no-op. APIck never
 * bundles an exporter or makes network calls of its own.
 */
export const tracer = trace.getTracer('apick', VERSION);
const meter = metrics.getMeter('apick', VERSION);

export const metricsBundle = {
  httpDuration: meter.createHistogram('apick.http.request.duration', {
    unit: 'ms',
    description: 'HTTP request duration',
  }),
  jobRuns: meter.createCounter('apick.jobs.runs', { description: 'Job executions by queue and outcome' }),
  webhookDeliveries: meter.createCounter('apick.webhooks.deliveries', { description: 'Webhook delivery attempts by outcome' }),
  mcpCalls: meter.createCounter('apick.mcp.tool_calls', { description: 'MCP tool calls by tool and outcome' }),
};

/** Run fn inside a span; status/exception recorded, span always ended. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
