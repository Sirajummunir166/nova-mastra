/**
 * Front-office tracing.
 *
 * The delta loop deliberately makes NO LLM tool calls — the app decides and
 * calls dakio-api directly, which is where the token win comes from. The cost
 * is that Mastra's automatic instrumentation has nothing to show: it traces
 * agent runs, workflow steps and LLM tool calls, and our HTTP reads are none
 * of those. So we emit the spans ourselves.
 *
 * The workflow step hands us its `tracingContext.currentSpan`; we stash it in
 * an AsyncLocalStorage so code deep in the loop (the observation cache, the
 * mutation gate) can attach child spans without threading a parameter through
 * every signature — and so two conversations running concurrently can never
 * write into each other's trace.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getRootExportSpan } from "@mastra/core/observability";

/** Structural type: avoids importing Mastra's Span generics into every caller. */
export interface TurnSpan {
  id: string;
  traceId: string;
  createChildSpan(options: Record<string, unknown>): TurnSpan;
  end(options?: Record<string, unknown>): void;
  error(options: Record<string, unknown>): void;
  update(options: Record<string, unknown>): void;
}

const store = new AsyncLocalStorage<{ span?: TurnSpan }>();

/**
 * Anchor the turn to the nearest span that actually gets exported.
 *
 * The span a workflow step hands out is an INTERNAL Mastra span, and internal
 * spans (plus anything parented to them) are stripped before export — which is
 * why child spans created against it were silently absent from Studio. Walk up
 * to the closest external ancestor (the workflow run) and hang our spans there.
 */
export function withTurnSpan<T>(span: TurnSpan | undefined, fn: () => Promise<T>): Promise<T> {
  const anchor = span ? ((getRootExportSpan(span as never) as unknown as TurnSpan | undefined) ?? span) : undefined;
  return store.run({ span: anchor }, fn);
}

export function currentSpan(): TurnSpan | undefined {
  return store.getStore()?.span;
}

/**
 * Nest an agent call under this turn's span. Mastra starts a fresh trace for
 * every agent.generate() unless it is told which trace it belongs to, which is
 * why the resolver/writer calls showed up as orphan traces.
 */
export function modelTracing(): { tracingOptions?: { traceId: string; parentSpanId: string } } {
  const span = currentSpan();
  if (!span) return {};
  return { tracingOptions: { traceId: span.traceId, parentSpanId: span.id } };
}

export interface SpanOptions {
  /** Mastra SpanType string; "tool_call" for dakio-api reads/writes. */
  type?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  /** Keep span output small — a row count beats 8 product objects. */
  summarize?: (out: unknown) => unknown;
}

/** Run `fn` inside a child span. A no-op (zero overhead) when tracing is off. */
export async function traced<T>(name: string, opts: SpanOptions, fn: () => Promise<T>): Promise<T> {
  const parent = currentSpan();
  if (!parent) return fn();

  const span = parent.createChildSpan({
    type: opts.type ?? "generic",
    name,
    input: opts.input,
    metadata: opts.metadata,
  });
  const startedAt = Date.now();
  try {
    const out = await fn();
    span.end({
      output: opts.summarize ? opts.summarize(out) : out,
      metadata: { ...opts.metadata, ms: Date.now() - startedAt },
    });
    return out;
  } catch (err) {
    span.error({ error: err instanceof Error ? err : new Error(String(err)), endSpan: true });
    throw err;
  }
}

/**
 * Record something that already happened — a cache hit, a decision — as a
 * zero-duration span so it still appears in the trace tree in order.
 */
export function traceMoment(name: string, opts: SpanOptions = {}): void {
  const parent = currentSpan();
  if (!parent) return;
  const span = parent.createChildSpan({
    type: opts.type ?? "generic",
    name,
    input: opts.input,
    metadata: opts.metadata,
  });
  span.end({ metadata: opts.metadata });
}
