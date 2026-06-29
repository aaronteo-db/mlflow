// The host-side binder. Given a trace-agnostic template (authored once by the
// LLM, with `$source` / `$spanRef` markers in place of data) and the CURRENT
// trace's data, it returns a concrete A2UI message stream with every marker
// resolved — NO LLM call. This is what lets a saved custom view re-render for
// every cycled trace by swapping data while preserving the authored layout.
//
// The output still uses the template's placeholder surfaceId; callers pass it
// through `validateAndPrepareMessages` to inject the host-owned createSurface,
// rewrite the surfaceId, and strict-validate the resolved components.

import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import type { ModelTraceSpanNode } from '../ModelTrace.types';
import type { PanelItem } from './TreeSelectionContext';
import {
  type CustomViewData,
  buildAssessmentCardComponents,
  buildTreeNodeComponents,
  getTimelineRowsFromNodeMap,
} from './customViewBuilders';
import {
  isArraySource,
  isScalarSource,
  isSourceMarker,
  isSpanFieldSource,
  isSpanRefMarker,
  isStructuralSource,
  isValidSpanRefSelector,
  resolveArraySource,
  resolveScalarSource,
  resolveSpanFieldSource,
  resolveSpanRef,
  type SourceMarker,
  unwrapSpanRefSelector,
} from './customViewSources';

// A component may carry a `renderIfSpan` guard (a bare spanRef selector): the
// binder OMITS the component and its whole subtree when the selector matches no
// span in the current trace. This lets a fixed N-card layout (one card per the
// nth tool span) gracefully drop the cards whose span doesn't exist in a smaller
// trace, instead of rendering an empty "null" card with dangling feedback.
const SPAN_GUARD_KEY = 'renderIfSpan';

export type ResolveContext = {
  viewData: CustomViewData;
  nodeMap: Record<string, ModelTraceSpanNode>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Resolves an array-source marker, honoring an optional `filterType` (e.g.
// restrict `timelineRows` to TOOL spans). `toolRows` is already tool-only, so
// `filterType` is moot there.
const resolveArrayMarker = (marker: SourceMarker, ctx: ResolveContext): unknown[] => {
  const filterType = typeof marker.filterType === 'string' ? marker.filterType : undefined;
  if (marker.$source === 'timelineRows') {
    return filterType ? getTimelineRowsFromNodeMap(ctx.nodeMap, filterType) : (ctx.viewData.timelineRows ?? []);
  }
  return resolveArraySource(marker.$source, ctx.viewData) ?? [];
};

// Resolves scalar / array / spanRef markers anywhere in a (possibly nested)
// value. Structural markers (spanTree / assessments) are NOT resolved here —
// they are handled at the component level because they emit sibling components.
const resolveValueDeep = (value: unknown, ctx: ResolveContext): unknown => {
  if (isSourceMarker(value)) {
    const name = value.$source;
    if (isArraySource(name)) {
      return resolveArrayMarker(value, ctx);
    }
    if (isScalarSource(name)) {
      return resolveScalarSource(name, ctx.viewData) ?? '';
    }
    if (isSpanFieldSource(name)) {
      return resolveSpanFieldSource(value, ctx.nodeMap);
    }
    // A structural marker used outside a `children` slot has no meaning; drop it.
    return '';
  }
  if (isSpanRefMarker(value)) {
    return resolveSpanRef(value.$spanRef, ctx.nodeMap) ?? '';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValueDeep(entry, ctx));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValueDeep(entry, ctx)]));
  }
  return value;
};

// Materializes a structural source marker into child component ids + the
// components to append after the owner.
const materializeStructural = (
  marker: SourceMarker,
  ownerId: string,
  ctx: ResolveContext,
): { childIds: string[]; components: Record<string, unknown>[] } => {
  if (marker.$source === 'spanTree') {
    const panelItems = Array.isArray(marker.panelItems) ? (marker.panelItems as PanelItem[]) : [];
    const filterType = typeof marker.filterType === 'string' ? marker.filterType : undefined;
    return buildTreeNodeComponents(ctx.viewData.treeNodes, panelItems, {
      idPrefix: `${ownerId}__n`,
      filterType,
    });
  }
  if (marker.$source === 'assessments') {
    return buildAssessmentCardComponents(ctx.viewData.assessmentItems, { idPrefix: `${ownerId}__a` });
  }
  return { childIds: [], components: [] };
};

const resolveComponent = (
  component: Record<string, unknown>,
  ctx: ResolveContext,
): { component: Record<string, unknown>; generated: Record<string, unknown>[] } => {
  const ownerId = typeof component.id === 'string' ? component.id : String(component.id ?? '');
  const resolved: Record<string, unknown> = {};
  const generated: Record<string, unknown>[] = [];

  for (const [key, value] of Object.entries(component)) {
    if (key === 'id' || key === 'component') {
      resolved[key] = value;
      continue;
    }
    // Host-only directive consumed during pruning; never emit it (the strict
    // resolved-output validator would reject it as an unknown prop).
    if (key === SPAN_GUARD_KEY) {
      continue;
    }
    if (isSourceMarker(value) && isStructuralSource(value.$source)) {
      const { childIds, components } = materializeStructural(value, ownerId, ctx);
      resolved[key] = childIds;
      generated.push(...components);
      continue;
    }
    if (isSpanRefMarker(value)) {
      const spanId = resolveSpanRef(value.$spanRef, ctx.nodeMap);
      // Unresolved -> drop the prop so the control logs at trace level instead
      // of pointing at a span that doesn't exist in this trace.
      if (spanId) {
        resolved[key] = spanId;
      }
      continue;
    }
    resolved[key] = resolveValueDeep(value, ctx);
  }

  return { component: resolved, generated };
};

// Computes the set of component ids to prune: every component carrying a
// `renderIfSpan` guard that resolves to NO span in the current trace, plus all
// of its descendants (walked via `children`). An invalid/unrecognized guard is
// ignored (the component renders) so a malformed guard never hides content.
const computePrunedIds = (components: unknown[], nodeMap: Record<string, ModelTraceSpanNode>): Set<string> => {
  const byId = new Map<string, Record<string, unknown>>();
  for (const component of components) {
    if (isRecord(component) && typeof component.id === 'string') {
      byId.set(component.id, component);
    }
  }
  const pruned = new Set<string>();
  const markSubtree = (id: string) => {
    if (pruned.has(id)) {
      return;
    }
    pruned.add(id);
    const component = byId.get(id);
    if (!component) {
      return;
    }
    // Follow BOTH child-reference shapes: a Card nests its single child via
    // "child" (string); Row/Column/TreeView/etc. via "children" (string ids).
    if (typeof component.child === 'string') {
      markSubtree(component.child);
    }
    if (Array.isArray(component.children)) {
      for (const child of component.children) {
        if (typeof child === 'string') {
          markSubtree(child);
        }
      }
    }
  };
  for (const component of components) {
    if (!isRecord(component) || typeof component.id !== 'string' || !(SPAN_GUARD_KEY in component)) {
      continue;
    }
    const selector = unwrapSpanRefSelector(component[SPAN_GUARD_KEY]);
    if (isValidSpanRefSelector(selector) && !resolveSpanRef(selector, nodeMap)) {
      markSubtree(component.id);
    }
  }
  return pruned;
};

// Walks an `updateComponents` payload, resolving every component's markers and
// appending any structurally-materialized children (so parents still precede
// children in the list). Components pruned by a `renderIfSpan` guard (and their
// descendants) are dropped, and their ids are removed from any parent's
// `children` so the layout closes up cleanly.
const resolveComponentsPayload = (payload: Record<string, unknown>, ctx: ResolveContext): Record<string, unknown> => {
  const components = Array.isArray(payload.components) ? payload.components : [];
  const pruned = computePrunedIds(components, ctx.nodeMap);
  const resolved: Record<string, unknown>[] = [];
  const generated: Record<string, unknown>[] = [];
  for (const component of components) {
    if (!isRecord(component)) {
      continue;
    }
    const id = typeof component.id === 'string' ? component.id : String(component.id ?? '');
    if (pruned.has(id)) {
      continue;
    }
    const result = resolveComponent(component, ctx);
    resolved.push(result.component);
    generated.push(...result.generated);
  }
  if (pruned.size > 0) {
    for (const component of resolved) {
      if (Array.isArray(component.children)) {
        component.children = component.children.filter((child) => !(typeof child === 'string' && pruned.has(child)));
      }
      if (typeof component.child === 'string' && pruned.has(component.child)) {
        delete component.child;
      }
    }
  }
  return { ...payload, components: [...resolved, ...generated] };
};

/**
 * Resolves a stored bound template against the current trace. The result is a
 * raw A2UI message stream (markers replaced with this trace's data/ids) ready to
 * hand to `validateAndPrepareMessages`. A template with no markers (e.g. a legacy
 * data-baked view) passes through unchanged.
 */
export const resolveTemplate = (template: A2uiMessage[], ctx: ResolveContext): A2uiMessage[] =>
  template.map((rawMessage) => {
    const message = rawMessage as unknown as Record<string, unknown>;
    if ('updateComponents' in message && isRecord(message.updateComponents)) {
      return {
        ...message,
        updateComponents: resolveComponentsPayload(message.updateComponents, ctx),
      } as unknown as A2uiMessage;
    }
    return rawMessage;
  });

// True when a template uses the binding layer (any `$source` / `$spanRef`
// marker). Legacy data-baked templates have none and are rendered as-is.
export const isBoundTemplate = (template: A2uiMessage[]): boolean => {
  const scan = (value: unknown): boolean => {
    if (isSourceMarker(value) || isSpanRefMarker(value)) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.some(scan);
    }
    if (isRecord(value)) {
      return Object.values(value).some(scan);
    }
    return false;
  };
  return template.some((message) => scan(message));
};
