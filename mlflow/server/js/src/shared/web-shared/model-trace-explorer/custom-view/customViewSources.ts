// The `$source` / `$spanRef` binding vocabulary for trace-agnostic custom view
// templates. The LLM authors a template ONCE where every data-bearing prop is a
// marker referencing one of these named host sources instead of a literal; the
// host binder (`resolveTemplate`) re-resolves the markers against each trace's
// already-computed data, so cycling traces never calls the LLM again.
//
// This module is the single source of truth for: which source names exist, how a
// scalar/array source resolves to the current trace's value, and how a `$spanRef`
// selector resolves to a concrete span id in the current trace. Keeping the
// vocabulary closed lets the template validator reject anything the binder can't
// resolve.

import type { ModelTraceSpanNode } from '../ModelTrace.types';
import { type CustomViewData, getSpanAttributes } from './customViewBuilders';

// A data-binding marker the LLM emits in place of literal data, e.g.
// `{ "$source": "toolRows" }` or `{ "$source": "spanTree", "panelItems": [...] }`.
export type SourceMarker = { $source: string } & Record<string, unknown>;

// A span-targeting marker the LLM emits in place of a literal `spanId`, so a
// feedback control re-targets the equivalent span in whatever trace is open.
//  - "root"                         -> the trace's root span
//  - { type: "TOOL", nth?: 0 }      -> the nth span of that type (default 0)
//  - { name: "run_sql_query" }      -> the first span whose title matches
export type SpanRefSelector = 'root' | { type?: string; name?: string; nth?: number };
export type SpanRefMarker = { $spanRef: SpanRefSelector };

// Scalar sources resolve to a single display string (StatCard value, etc.).
export const SCALAR_SOURCE_NAMES = [
  'metrics.status',
  'metrics.latency',
  'metrics.totalTokens',
  'metrics.assessments',
] as const;

// Array sources resolve to a literal array inlined into an array-valued prop.
export const ARRAY_SOURCE_NAMES = ['toolRows', 'timelineRows'] as const;

// Structural sources materialize into a set of child components (one per item)
// whose ids are placed into the host component's `children` array.
export const STRUCTURAL_SOURCE_NAMES = ['spanTree', 'assessments'] as const;

// A per-span field source resolves a SINGLE span (selected via a spanRef) to one
// of its fields, re-resolved per trace. It lets a KeyValueViewer / Text bind to a
// specific span's output/input/attributes/name/id without baking a literal — the
// missing capability that previously forced the model to hardcode span data.
//   { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "outputs" }
export const SPAN_FIELD_SOURCE_NAME = 'spanField';
export const SPAN_FIELD_NAMES = ['inputs', 'outputs', 'attributes', 'name', 'spanId'] as const;

export type ScalarSourceName = (typeof SCALAR_SOURCE_NAMES)[number];
export type ArraySourceName = (typeof ARRAY_SOURCE_NAMES)[number];
export type StructuralSourceName = (typeof STRUCTURAL_SOURCE_NAMES)[number];
export type SpanFieldName = (typeof SPAN_FIELD_NAMES)[number];
export type SpanFieldMarker = { $source: 'spanField'; spanRef: SpanRefSelector; field: SpanFieldName };

const SCALAR_SET = new Set<string>(SCALAR_SOURCE_NAMES);
const ARRAY_SET = new Set<string>(ARRAY_SOURCE_NAMES);
const STRUCTURAL_SET = new Set<string>(STRUCTURAL_SOURCE_NAMES);
const SPAN_FIELD_SET = new Set<string>(SPAN_FIELD_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isSourceMarker = (value: unknown): value is SourceMarker =>
  isRecord(value) && typeof value.$source === 'string';

export const isSpanRefMarker = (value: unknown): value is SpanRefMarker =>
  isRecord(value) && '$spanRef' in value;

export const isScalarSource = (name: string): name is ScalarSourceName => SCALAR_SET.has(name);
export const isArraySource = (name: string): name is ArraySourceName => ARRAY_SET.has(name);
export const isStructuralSource = (name: string): name is StructuralSourceName => STRUCTURAL_SET.has(name);
export const isSpanFieldSource = (name: string): boolean => name === SPAN_FIELD_SOURCE_NAME;
export const isKnownSource = (name: string): boolean =>
  isScalarSource(name) || isArraySource(name) || isStructuralSource(name) || isSpanFieldSource(name);

// A `spanField`'s "spanRef" is meant to be a BARE selector ("root" / {type,nth} /
// {name}), but the model frequently wraps it as { "$spanRef": <selector> } (the
// feedback-spanId marker syntax). Accept both by unwrapping the marker form.
export const unwrapSpanRefSelector = (value: unknown): unknown =>
  isSpanRefMarker(value) ? value.$spanRef : value;

// Validates a `spanField` marker: a valid spanRef selector + a known field name.
export const isValidSpanFieldMarker = (marker: Record<string, unknown>): boolean =>
  isValidSpanRefSelector(unwrapSpanRefSelector(marker.spanRef)) &&
  typeof marker.field === 'string' &&
  SPAN_FIELD_SET.has(marker.field);

// Validates a `$spanRef` selector against the supported grammar (used by the
// template validator). Raw positional indices are intentionally unsupported as
// they are fragile across traces.
export const isValidSpanRefSelector = (selector: unknown): selector is SpanRefSelector => {
  if (selector === 'root') {
    return true;
  }
  if (!isRecord(selector)) {
    return false;
  }
  const hasType = typeof selector.type === 'string' && selector.type.length > 0;
  const hasName = typeof selector.name === 'string' && selector.name.length > 0;
  if (!hasType && !hasName) {
    return false;
  }
  if ('nth' in selector && typeof selector.nth !== 'number') {
    return false;
  }
  return true;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

// Resolves a scalar source name to the current trace's display string.
export const resolveScalarSource = (name: string, data: CustomViewData): string | undefined => {
  if (name.startsWith('metrics.')) {
    const key = name.slice('metrics.'.length) as keyof CustomViewData['metrics'];
    const value = data.metrics?.[key];
    return value === undefined || value === null ? '' : asString(value);
  }
  return undefined;
};

// Resolves an array source name to the current trace's array (inlined as-is).
export const resolveArraySource = (name: string, data: CustomViewData): unknown[] | undefined => {
  switch (name) {
    case 'toolRows':
      return data.toolRows;
    case 'timelineRows':
      return data.timelineRows;
    default:
      return undefined;
  }
};

// Resolves a `$spanRef` selector to a concrete span id in the CURRENT trace, or
// undefined when nothing matches (callers then drop the spanId so the control
// logs at trace level instead of pointing at a span that doesn't exist here).
export const resolveSpanRef = (
  selector: SpanRefSelector,
  nodeMap: Record<string, ModelTraceSpanNode>,
): string | undefined => {
  const nodes = Object.values(nodeMap);
  if (nodes.length === 0) {
    return undefined;
  }
  // Deterministic order so "nth" is stable run-to-run.
  const ordered = [...nodes].sort((a, b) => a.start - b.start);

  if (selector === 'root') {
    const root = ordered.find((node) => !node.parentId);
    return root ? String(root.key) : undefined;
  }

  const { type, name, nth = 0 } = selector;
  const matches = ordered.filter((node) => {
    const typeOk = type ? node.type === type : true;
    const title = typeof node.title === 'string' ? node.title : asString(node.title);
    const nameOk = name ? title === name : true;
    return typeOk && nameOk;
  });
  const picked = matches[nth];
  return picked ? String(picked.key) : undefined;
};

// Resolves a `spanField` marker to a display string for the CURRENT trace: finds
// the span via its spanRef selector, then serializes the requested field. When no
// span matches (e.g. a 1-tool trace asked for the 2nd tool), JSON fields resolve
// to "null" and text fields to "" so the component renders an empty/"unavailable"
// state rather than stale authoring-trace data.
export const resolveSpanFieldSource = (
  marker: Record<string, unknown>,
  nodeMap: Record<string, ModelTraceSpanNode>,
): string => {
  const field = typeof marker.field === 'string' ? marker.field : '';
  const selector = unwrapSpanRefSelector(marker.spanRef);
  const spanId = isValidSpanRefSelector(selector) ? resolveSpanRef(selector, nodeMap) : undefined;
  const span = spanId ? nodeMap[spanId] : undefined;
  switch (field) {
    case 'inputs':
      return JSON.stringify(span?.inputs ?? null);
    case 'outputs':
      return JSON.stringify(span?.outputs ?? null);
    case 'attributes':
      return JSON.stringify(getSpanAttributes(span));
    case 'name':
      return span ? (typeof span.title === 'string' ? span.title : asString(span.title)) : '';
    case 'spanId':
      return spanId ?? '';
    default:
      return '';
  }
};
