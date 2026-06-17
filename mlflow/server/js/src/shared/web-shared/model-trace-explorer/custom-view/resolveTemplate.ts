import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import { type PanelItem } from './TreeSelectionContext';
import {
  type CustomViewData,
  buildSpanNodeComponents,
  createSurfaceMessage,
} from './customViewBuilders';

// A `$source` marker is the trace-agnostic placeholder the agent emits instead of
// inlining concrete trace data. At bind time the host swaps each marker for the
// active trace's data, so one template renders for any trace with no further LLM
// call. Markers are one of:
//   value markers     -> { "$source": "metrics" | "toolRows" | "timelineRows" | "assessmentItems" }
//   scalar marker     -> { "$source": "metric", "key": "<metric key>" }
//   structural markers -> { "$source": "spanTree", "panelItems"?: [...] } | { "$source": "assessmentCards" }
// Structural markers are only valid on a component's "children" prop; the host
// materializes the child components and rewrites "children" to their ids.
export const SOURCE_MARKER_KEY = '$source';

export type SourceMarker = { $source: string; key?: string; panelItems?: PanelItem[] };

const VALUE_SOURCES = new Set(['metrics', 'toolRows', 'timelineRows', 'assessmentItems']);
const STRUCTURAL_SOURCES = new Set(['spanTree', 'assessmentCards']);
const ALL_SOURCES = new Set([...VALUE_SOURCES, ...STRUCTURAL_SOURCES, 'metric']);

export const isSourceMarker = (value: unknown): value is SourceMarker =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as any)[SOURCE_MARKER_KEY] === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Resolves a non-structural marker to the active trace's data value.
const resolveValueMarker = (marker: SourceMarker, data: CustomViewData): unknown => {
  switch (marker.$source) {
    case 'metrics':
      return data.metrics;
    case 'metric':
      return marker.key ? (data.metrics as Record<string, unknown>)[marker.key] ?? 'N/A' : 'N/A';
    case 'toolRows':
      return data.toolRows;
    case 'timelineRows':
      return data.timelineRows;
    case 'assessmentItems':
      return data.assessmentItems;
    default:
      return null;
  }
};

// Materializes a structural marker into child components (appended to `sink`) and
// returns the ids to set on the host component's "children" prop.
const materializeStructuralMarker = (
  marker: SourceMarker,
  idPrefix: string,
  sink: Record<string, unknown>[],
  data: CustomViewData,
): string[] => {
  if (marker.$source === 'spanTree') {
    const state = { counter: 0 };
    const panelItems = Array.isArray(marker.panelItems) ? marker.panelItems : [];
    return data.treeRoots.map((span) =>
      buildSpanNodeComponents(span, sink, { panelItems, idPrefix: `${idPrefix}-st`, state }),
    );
  }
  if (marker.$source === 'assessmentCards') {
    return data.assessmentItems.map((item, index) => {
      const cardId = `${idPrefix}-ac-${index}`;
      sink.push({
        id: cardId,
        component: 'AssessmentCard',
        name: item.name,
        ...(item.value !== undefined ? { value: item.value } : {}),
        ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
        ...(item.source !== undefined ? { source: item.source } : {}),
        sentiment: item.sentiment,
      });
      return cardId;
    });
  }
  return [];
};

// Recursively replaces value markers anywhere inside a prop value (e.g. a marker
// nested in a cell or a Text path) with the resolved data value.
const resolveValueDeep = (value: unknown, data: CustomViewData): unknown => {
  if (isSourceMarker(value)) {
    return resolveValueMarker(value, data);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValueDeep(entry, data));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValueDeep(entry, data)]));
  }
  return value;
};

// Binds one component: structural "children" markers are expanded into real child
// components (appended to `sink`); every other prop has its value markers resolved
// in place.
const bindComponent = (component: Record<string, unknown>, sink: Record<string, unknown>[], data: CustomViewData): Record<string, unknown> => {
  const bound: Record<string, unknown> = {};
  const id = String(component.id ?? 'node');
  for (const [key, value] of Object.entries(component)) {
    if (key === 'children' && isSourceMarker(value)) {
      bound.children = materializeStructuralMarker(value, id, sink, data);
      continue;
    }
    bound[key] = resolveValueDeep(value, data);
  }
  return bound;
};

/**
 * Binds an agent template (the trace-agnostic A2UI message stream stored in the
 * definition) to the active trace's data, producing a processor-ready message
 * stream for `surfaceId`. We always inject a fresh `createSurface` (the template
 * may omit it) and rewrite every message's `surfaceId`, so the same template can
 * be re-bound to any trace / surface with no LLM call.
 */
export const resolveTemplate = (
  template: A2uiMessage[],
  surfaceId: string,
  data: CustomViewData,
): A2uiMessage[] => {
  const messages: A2uiMessage[] = [createSurfaceMessage(surfaceId)];

  for (const rawMessage of template) {
    const message = rawMessage as Record<string, unknown>;
    if ('createSurface' in message || 'deleteSurface' in message) {
      continue;
    }
    if ('updateComponents' in message && isRecord(message.updateComponents)) {
      const payload = message.updateComponents as Record<string, unknown>;
      const components = Array.isArray(payload.components) ? (payload.components as Record<string, unknown>[]) : [];
      const sink: Record<string, unknown>[] = [];
      const bound = components.map((component) => bindComponent(component, sink, data));
      messages.push({
        version: 'v0.9',
        updateComponents: { surfaceId, components: [...bound, ...sink] },
      } as A2uiMessage);
      continue;
    }
    if ('updateDataModel' in message && isRecord(message.updateDataModel)) {
      const payload = message.updateDataModel as Record<string, unknown>;
      messages.push({
        version: 'v0.9',
        updateDataModel: { ...payload, surfaceId, value: resolveValueDeep(payload.value, data) },
      } as A2uiMessage);
      continue;
    }
  }

  return messages;
};

// Recursively scans a value for a literal `#span:` deeplink (trace-specific).
const containsSpanDeeplink = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.includes('#span:');
  }
  if (Array.isArray(value)) {
    return value.some(containsSpanDeeplink);
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsSpanDeeplink);
  }
  return false;
};

/**
 * Host-authoritative classification of an agent template: returns whether the
 * template must be REGENERATED per trace (because it inlines trace-specific data
 * the host cannot re-bind) rather than re-bound. This overrides any hint from the
 * LLM. A template is regenerative when it contains any of:
 *   - a `#span:<id>` deeplink (literal span reference) in markdown/text,
 *   - a literal `spanId` prop (span ids differ per trace),
 *   - a non-empty literal `rows` array with no `$source` marker (inlined data),
 *   - an `updateDataModel` value object inlining data with no `$source` marker.
 * A template that sources all its data via `$source` markers is reusable.
 */
export const classifyPanelRequiresRegeneration = (template: A2uiMessage[]): boolean => {
  for (const rawMessage of template) {
    const message = rawMessage as Record<string, unknown>;

    if ('updateDataModel' in message && isRecord(message.updateDataModel)) {
      const value = (message.updateDataModel as Record<string, unknown>).value;
      if (containsSpanDeeplink(value)) {
        return true;
      }
      // A literal data object that isn't a `$source` marker means data was inlined.
      if (isRecord(value) && !isSourceMarker(value) && Object.keys(value).length > 0) {
        return true;
      }
      if (Array.isArray(value) && value.length > 0) {
        return true;
      }
    }

    if ('updateComponents' in message && isRecord(message.updateComponents)) {
      const payload = message.updateComponents as Record<string, unknown>;
      const components = Array.isArray(payload.components) ? (payload.components as Record<string, unknown>[]) : [];
      for (const component of components) {
        if (!isRecord(component)) {
          continue;
        }
        if (containsSpanDeeplink(component)) {
          return true;
        }
        if (typeof component.spanId === 'string' && component.spanId) {
          return true;
        }
        const rows = component.rows;
        if (Array.isArray(rows) && rows.length > 0 && !isSourceMarker(rows)) {
          return true;
        }
      }
    }
  }
  return false;
};

export const isKnownSource = (name: string): boolean => ALL_SOURCES.has(name);

// Exposed for prompt-side validation: the names the agent may use in markers.
export const VALUE_SOURCE_NAMES = Array.from(VALUE_SOURCES);
export const STRUCTURAL_SOURCE_NAMES = Array.from(STRUCTURAL_SOURCES);
