import type { A2uiMessage } from '@a2ui/web_core/v0_9';

import type { Assessment, ModelTrace, ModelTraceInfo, ModelTraceSpanNode } from '../ModelTrace.types';
import { ModelSpanType } from '../ModelTrace.types';
import {
  getIconTypeForSpan,
  getSpanExceptionEvents,
  getSpanLogLevel,
  getTotalTokens,
  isV3ModelTraceInfo,
} from '../ModelTraceExplorer.utils';
import { spanTimeFormatter } from '../timeline-tree/TimelineTree.utils';
import { parseAttachmentUri } from '../attachment-utils';
import { type PanelItem } from './TreeSelectionContext';
import type { AgentAssessment } from './agent/buildAgentPrompt';

// Must match the `catalogId` declared in `catalog.json`.
export const CUSTOM_VIEW_CATALOG_ID = 'https://mlflow.org/model-trace-explorer/custom-view/catalog.json';

const formatLatencyMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

// Extracts the metrics we can derive from `modelTraceInfo` alone, normalizing
// across the V3 and legacy/notebook trace-info shapes.
export const getMetricsFromTraceInfo = (info: ModelTrace['info']) => {
  if (isV3ModelTraceInfo(info)) {
    const totalTokens = getTotalTokens(info);
    return {
      status: info.state ?? 'STATE_UNSPECIFIED',
      latency: info.execution_duration ?? 'N/A',
      totalTokens: totalTokens != null ? totalTokens.toLocaleString() : 'N/A',
      assessments: String(info.assessments?.length ?? 0),
    };
  }

  const legacy = info as ModelTraceInfo | undefined;
  return {
    status: legacy?.status ?? 'UNKNOWN',
    latency: typeof legacy?.execution_time_ms === 'number' ? formatLatencyMs(legacy.execution_time_ms) : 'N/A',
    totalTokens: 'N/A',
    assessments: '0',
  };
};

export type TraceMetrics = ReturnType<typeof getMetricsFromTraceInfo>;

// A single row for the generic DataTable: cells are positional (aligned to the
// table's columns by index), with an optional color for the leading dot.
export type TableRow = { color?: string; cells: string[] };

// A single row for the generic TimelineChart: a labeled bar spanning [start, end]
// in milliseconds (relative to the trace start), with an indentation depth.
export type TimelineRow = { label: string; start: number; end: number; depth: number };

// A reference span-tree node handed to Agent Mode (in the data snapshot) so the
// LLM can construct TreeNode components. `attributes` is an opaque metadata bag
// (type/logLevel/duration) the model can use to select a subset of spans.
export type TreeNodeData = {
  id: string;
  label: string;
  icon: string;
  hasException: boolean;
  isRootSpan: boolean;
  badge?: string;
  attributes: {
    type: string;
    hasException: boolean;
    logLevel: number;
    durationMs: number;
  };
  children: TreeNodeData[];
};

export type AssessmentSentiment = 'positive' | 'negative' | 'neutral' | 'error';

export type AssessmentBoardItem = {
  name: string;
  value?: string;
  rationale?: string;
  source?: string;
  sentiment: AssessmentSentiment;
};

// Everything the agent data snapshot needs to render. Trace-level metrics come
// from `modelTraceInfo`; per-tool rows, the timeline, and the tree are derived
// from the parsed spans (nodeMap / topLevelNodes).
export type CustomViewData = {
  metrics: TraceMetrics;
  toolRows: TableRow[];
  timelineRows: TimelineRow[];
  treeNodes: TreeNodeData[];
  assessmentItems: AssessmentBoardItem[];
};

// Categorical palette for the per-tool indicator dots. Kept local so the shared
// trace-explorer code doesn't depend on the experiment-overview chart utils.
const TOOL_ROW_COLORS = ['#077A9D', '#00A972', '#FFAB00', '#E65B77', '#8A63BF', '#3986E3'];

// Aggregates TOOL-type spans (from the parsed span tree) into per-tool rows:
// call count, success rate, and average latency. Success is derived from the
// absence of exception events on the span, since the node doesn't carry a status
// code directly.
export const getToolRowsFromNodeMap = (nodeMap: Record<string, ModelTraceSpanNode>): TableRow[] => {
  const statsByTool = new Map<string, { total: number; success: number; durationUs: number }>();

  for (const node of Object.values(nodeMap)) {
    if (node.type !== ModelSpanType.TOOL) {
      continue;
    }
    const toolName = typeof node.title === 'string' ? node.title : String(node.title ?? 'unknown');
    const existing = statsByTool.get(toolName) ?? { total: 0, success: 0, durationUs: 0 };
    existing.total += 1;
    if (getSpanExceptionEvents(node).length === 0) {
      existing.success += 1;
    }
    existing.durationUs += Math.max(node.end - node.start, 0);
    statsByTool.set(toolName, existing);
  }

  return Array.from(statsByTool.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([toolName, stats], index) => {
      const successRate = stats.total > 0 ? (stats.success / stats.total) * 100 : 0;
      const avgDurationUs = stats.total > 0 ? stats.durationUs / stats.total : 0;
      return {
        color: TOOL_ROW_COLORS[index % TOOL_ROW_COLORS.length],
        cells: [toolName, String(stats.total), `${successRate.toFixed(2)}%`, spanTimeFormatter(avgDurationUs)],
      };
    });
};

// Flattens the span tree into ordered timeline rows (depth-first, preserving the
// tree's display order), converting absolute span timestamps (microseconds) into
// offsets in milliseconds relative to the earliest span. Works for any number of
// spans / nesting depth.
export const getTimelineRowsFromNodes = (topLevelNodes: ModelTraceSpanNode[]): TimelineRow[] => {
  if (topLevelNodes.length === 0) {
    return [];
  }

  const traceStartUs = Math.min(...topLevelNodes.map((node) => node.start));
  const rows: TimelineRow[] = [];

  const visit = (node: ModelTraceSpanNode, depth: number) => {
    rows.push({
      label: typeof node.title === 'string' ? node.title : String(node.title ?? 'unknown'),
      start: (node.start - traceStartUs) / 1000,
      end: (node.end - traceStartUs) / 1000,
      depth,
    });
    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const node of topLevelNodes) {
    visit(node, 0);
  }

  return rows;
};

// Builds timeline rows directly from the nodeMap, optionally restricted to a
// single span type (e.g. only TOOL spans). Bars are flattened (depth 0) and
// positioned against the GLOBAL trace start (min start across ALL spans) so a
// filtered bar still sits at its true position on the trace timeline. Used by
// the binder to honor a `filterType` on the `timelineRows` source.
export const getTimelineRowsFromNodeMap = (
  nodeMap: Record<string, ModelTraceSpanNode>,
  filterType?: string,
): TimelineRow[] => {
  const nodes = Object.values(nodeMap);
  if (nodes.length === 0) {
    return [];
  }
  const traceStartUs = Math.min(...nodes.map((node) => node.start));
  return nodes
    .filter((node) => (filterType ? node.type === filterType : true))
    .sort((a, b) => a.start - b.start)
    .map((node) => ({
      label: typeof node.title === 'string' ? node.title : String(node.title ?? 'unknown'),
      start: (node.start - traceStartUs) / 1000,
      end: (node.end - traceStartUs) / 1000,
      depth: 0,
    }));
};

// Maps the span tree into generic TreeView nodes. We reuse the trace explorer's
// own icon mapping (getIconTypeForSpan) and log-level/exception helpers so the
// tree matches the Details & Timeline view, and stash the filterable fields in
// `attributes` for the TreeView's structured filter.
export const getTreeNodesFromNodes = (topLevelNodes: ModelTraceSpanNode[]): TreeNodeData[] => {
  const toTreeNode = (node: ModelTraceSpanNode): TreeNodeData => {
    const hasException = getSpanExceptionEvents(node).length > 0;
    const assessmentCount = node.assessments?.length ?? 0;
    return {
      id: String(node.key),
      label: typeof node.title === 'string' ? node.title : String(node.title ?? 'unknown'),
      icon: getIconTypeForSpan(node.type ?? ModelSpanType.UNKNOWN),
      hasException,
      isRootSpan: !node.parentId,
      badge: assessmentCount > 0 ? String(assessmentCount) : undefined,
      attributes: {
        type: node.type ?? ModelSpanType.UNKNOWN,
        hasException,
        logLevel: getSpanLogLevel(node),
        durationMs: Math.max(node.end - node.start, 0) / 1000,
      },
      children: (node.children ?? []).map(toTreeNode),
    };
  };

  return topLevelNodes.map(toTreeNode);
};

// Extracts the displayable value + error from any assessment variant
// (feedback / expectation), so the agent receives real judge/feedback results.
const getAssessmentValueAndError = (assessment: Assessment): { value: unknown; error?: string } => {
  if ('feedback' in assessment && assessment.feedback) {
    const err = assessment.feedback.error ?? assessment.error;
    return {
      value: assessment.feedback.value,
      error: err ? err.error_message ?? err.error_code : undefined,
    };
  }
  if ('expectation' in assessment && assessment.expectation) {
    const expectation = assessment.expectation;
    if ('value' in expectation) {
      return { value: expectation.value };
    }
    if ('serialized_value' in expectation) {
      return { value: expectation.serialized_value.value };
    }
  }
  return { value: undefined, error: assessment.error?.error_message ?? assessment.error?.error_code };
};

// Collects the trace's real assessments (trace-level + span-level), deduped by
// id and skipping invalidated ones, into the flat shape the agent prompt uses.
export const getAgentAssessments = (
  info: ModelTrace['info'],
  nodeMap: Record<string, ModelTraceSpanNode>,
): AgentAssessment[] => {
  const byId = new Map<string, AgentAssessment>();
  const add = (assessment: Assessment) => {
    if (assessment.valid === false || byId.has(assessment.assessment_id)) {
      return;
    }
    const { value, error } = getAssessmentValueAndError(assessment);
    byId.set(assessment.assessment_id, {
      name: assessment.assessment_name,
      value,
      rationale: assessment.rationale,
      source: assessment.source?.source_type ?? 'SOURCE_TYPE_UNSPECIFIED',
      spanId: assessment.span_id,
      error,
    });
  };

  const traceAssessments = (info as { assessments?: Assessment[] } | undefined)?.assessments ?? [];
  for (const assessment of traceAssessments) {
    add(assessment);
  }
  for (const node of Object.values(nodeMap)) {
    for (const assessment of node.assessments ?? []) {
      add(assessment);
    }
  }
  return Array.from(byId.values());
};

// Maps an assessment's raw value to a verdict polarity for coloring. Affirmative
// values (yes/true/pass/correct) are positive (green); negatives (no/false/fail)
// are negative (red); an error overrides everything; otherwise neutral.
const POSITIVE_VALUES = new Set(['yes', 'true', 'pass', 'passed', 'correct', 'good', 'success']);
const NEGATIVE_VALUES = new Set(['no', 'false', 'fail', 'failed', 'incorrect', 'bad', 'failure']);

const getAssessmentSentiment = ({ value, error }: AgentAssessment): AssessmentSentiment => {
  if (error) {
    return 'error';
  }
  if (typeof value === 'boolean') {
    return value ? 'positive' : 'negative';
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (POSITIVE_VALUES.has(normalized)) {
      return 'positive';
    }
    if (NEGATIVE_VALUES.has(normalized)) {
      return 'negative';
    }
  }
  return 'neutral';
};

// Shapes the trace's real assessments into AssessmentBoard items (category
// header, verdict value, rationale, and a derived sentiment that drives the
// green/red coloring) for binding into an agent template's AssessmentBoard.
export const getAssessmentBoardItems = (assessments: AgentAssessment[]): AssessmentBoardItem[] =>
  assessments.map((assessment) => {
    const hasError = Boolean(assessment.error);
    const hasValue = assessment.value !== undefined && assessment.value !== null;
    return {
      name: assessment.name,
      // Keep the badge short: errors show "Error" and surface the message in the
      // body, otherwise a long value would blow out the badge/card layout.
      value: hasError ? 'Error' : hasValue ? String(assessment.value) : undefined,
      rationale: assessment.rationale ?? (hasError ? assessment.error : undefined),
      source: assessment.source,
      sentiment: getAssessmentSentiment(assessment),
    };
  });

export const createSurfaceMessage = (surfaceId: string): A2uiMessage => ({
  version: 'v0.9',
  createSurface: {
    surfaceId,
    catalogId: CUSTOM_VIEW_CATALOG_ID,
    sendDataModel: true,
  },
});

// Prepares a stored/generated A2UI template for rendering on a specific surface.
// The template already carries concrete trace data (it is generated fresh per
// trace), so there is no data binding to do — we just inject a fresh
// `createSurface` and rewrite the `surfaceId` on every message, dropping any
// surface lifecycle messages the model emitted (the host owns the surface).
export const stampTemplateOnSurface = (template: A2uiMessage[], surfaceId: string): A2uiMessage[] => {
  const messages: A2uiMessage[] = [createSurfaceMessage(surfaceId)];
  for (const rawMessage of template) {
    const message = rawMessage as unknown as Record<string, unknown>;
    if ('createSurface' in message || 'deleteSurface' in message) {
      continue;
    }
    if ('updateComponents' in message && message.updateComponents && typeof message.updateComponents === 'object') {
      messages.push({
        version: 'v0.9',
        updateComponents: { ...(message.updateComponents as Record<string, unknown>), surfaceId },
      } as A2uiMessage);
      continue;
    }
    if ('updateDataModel' in message && message.updateDataModel && typeof message.updateDataModel === 'object') {
      messages.push({
        version: 'v0.9',
        updateDataModel: { ...(message.updateDataModel as Record<string, unknown>), surfaceId },
      } as A2uiMessage);
    }
  }
  return messages;
};

// Returns the span's "real" (non-`mlflow.`-prefixed) attributes, mirroring the
// Details & Timeline Attributes tab.
export const getSpanAttributes = (span?: ModelTraceSpanNode): Record<string, unknown> => {
  if (!span?.attributes) {
    return {};
  }
  return Object.fromEntries(Object.entries(span.attributes).filter(([key]) => !key.startsWith('mlflow.')));
};

// Mirrors the Details tab's attachment search depth so deeply nested media in a
// span's inputs/outputs is still found.
const MAX_ATTACHMENT_SEARCH_DEPTH = 10;

// Caps how many media elements one input/output panel item auto-renders. Each
// attachment triggers a blob fetch from the artifact store, so an unbounded
// span (e.g. dozens of images) could hammer the backend and bloat the panel.
const MAX_PANEL_MEDIA = 8;

// Recursively collects the raw `mlflow-attachment://` URIs in a parsed value, in
// encounter order, keeping only well-formed ones (validated via
// parseAttachmentUri). Returns the URI STRINGS (not parsed parts) because
// MediaRenderer takes a `url`. Mirrors `findAttachmentUris` in the Details tab's
// field renderer, the source of truth for the "Default" view's media detection.
const collectAttachmentUris = (value: unknown, depth = 0, acc: string[] = []): string[] => {
  if (depth > MAX_ATTACHMENT_SEARCH_DEPTH) {
    return acc;
  }
  if (typeof value === 'string') {
    if (value.startsWith('mlflow-attachment://') && parseAttachmentUri(value)) {
      acc.push(value);
    }
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAttachmentUris(entry, depth + 1, acc));
    return acc;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectAttachmentUris(entry, depth + 1, acc));
    return acc;
  }
  return acc;
};

// Builds the side-panel subtree for a selected TreeNode from its lightweight
// `panelItems` directives plus the span's real data (from `nodeMap`). The author
// /LLM only emits the directives; the host materializes the heavy components
// (KeyValueViewer / Markdown / FeedbackThumbsUpDownButtons) here, keyed off the deterministic
// `${nodeId}__panel` id the TreeView renders. For input/output items, any media
// attachments found in the field are auto-rendered as MediaRenderers above the
// JSON (mirroring the Details tab's Default view) so audio/images/PDFs are
// playable instead of showing a raw mlflow-attachment:// URI.
export const buildSpanPanelComponents = (
  nodeId: string,
  spanId: string | undefined,
  panelItems: PanelItem[],
  nodeMap: Record<string, ModelTraceSpanNode>,
): Record<string, unknown>[] => {
  const panelRootId = `${nodeId}__panel`;
  const span = spanId ? nodeMap[spanId] : undefined;
  const childIds: string[] = [];
  const components: Record<string, unknown>[] = [];

  panelItems.forEach((item, index) => {
    const itemId = `${panelRootId}-item-${index}`;
    switch (item.type) {
      case 'input':
      case 'output':
      case 'attributes': {
        const value =
          item.type === 'input' ? span?.inputs : item.type === 'output' ? span?.outputs : getSpanAttributes(span);
        const defaultLabel = item.type === 'input' ? 'Inputs' : item.type === 'output' ? 'Outputs' : 'Attributes';
        // Auto-render any media attachments (audio/image/PDF) found in the field
        // as playable MediaRenderers ABOVE the JSON. Dedupe (the same attachment
        // can appear in multiple messages) and cap to bound blob fetches.
        const mediaUris = Array.from(new Set(collectAttachmentUris(value))).slice(0, MAX_PANEL_MEDIA);
        mediaUris.forEach((url, mediaIndex) => {
          const mediaId = `${itemId}-media-${mediaIndex}`;
          childIds.push(mediaId);
          components.push({ id: mediaId, component: 'MediaRenderer', url });
        });
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'KeyValueViewer',
          label: item.title || defaultLabel,
          value: JSON.stringify(value ?? null),
          initialFormat: 'json',
        });
        break;
      }
      case 'markdown': {
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'Markdown',
          text: item.text ?? '',
          ...(item.title ? { title: item.title } : {}),
        });
        break;
      }
      case 'feedback': {
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'FeedbackThumbsUpDownButtons',
          label: item.label || 'Was this span helpful?',
          name: item.name || 'Span helpfulness',
          ...(spanId ? { spanId } : {}),
          value: { path: `/feedback/${nodeId}` },
        });
        break;
      }
      case 'rating': {
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'RadioGroup',
          ...(item.label ? { label: item.label } : {}),
          name: item.name || `Rating (${spanId ?? nodeId})`,
          options: Array.isArray(item.options) ? item.options : [],
          ...(spanId ? { spanId } : {}),
        });
        break;
      }
      case 'rationale': {
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'FeedbackInputText',
          ...(item.label ? { label: item.label } : {}),
          name: item.name || `Rating (${spanId ?? nodeId})`,
          field: 'rationale',
          ...(item.placeholder ? { placeholder: item.placeholder } : {}),
          ...(spanId ? { spanId } : {}),
        });
        break;
      }
      case 'submit': {
        childIds.push(itemId);
        components.push({
          id: itemId,
          component: 'FeedbackSubmit',
          ...(item.label ? { label: item.label } : {}),
        });
        break;
      }
      default:
        break;
    }
  });

  return [{ id: panelRootId, component: 'Column', children: childIds }, ...components];
};

// Materializes a `{ "$source": "spanTree" }` marker into concrete `TreeNode`
// components for the CURRENT trace (one per span), returning the root child ids
// to place into the host `TreeView`'s `children` and the component list to
// append. The same `panelItems` directives are attached to every node so the
// host can build each span's side panel on selection (from the live nodeMap).
// When `filterType` is set, the tree is flattened to only spans of that type
// (a flat list, no nesting) — the binding-layer equivalent of the prompt's
// "only tool calls" subset filtering.
export const buildTreeNodeComponents = (
  treeNodes: TreeNodeData[],
  panelItems: PanelItem[],
  { idPrefix, filterType }: { idPrefix: string; filterType?: string },
): { childIds: string[]; components: Record<string, unknown>[] } => {
  const components: Record<string, unknown>[] = [];
  const panel = Array.isArray(panelItems) && panelItems.length > 0 ? panelItems : undefined;

  const makeComponent = (node: TreeNodeData, id: string): Record<string, unknown> => ({
    id,
    component: 'TreeNode',
    label: node.label,
    icon: node.icon,
    ...(node.hasException ? { hasException: true } : {}),
    ...(node.isRootSpan ? { isRootSpan: true } : {}),
    ...(node.badge ? { badge: node.badge } : {}),
    spanId: node.id,
    ...(panel ? { panelItems: panel } : {}),
  });

  if (filterType) {
    const flat: TreeNodeData[] = [];
    const collect = (node: TreeNodeData) => {
      if (node.attributes?.type === filterType) {
        flat.push(node);
      }
      (node.children ?? []).forEach(collect);
    };
    treeNodes.forEach(collect);
    const childIds = flat.map((node, index) => {
      const id = `${idPrefix}-${index}`;
      components.push(makeComponent(node, id));
      return id;
    });
    return { childIds, components };
  }

  // Push each node BEFORE its children so parents always precede children in the
  // component list (the processor expects parents first).
  const build = (node: TreeNodeData, path: string): string => {
    const id = `${idPrefix}-${path}`;
    const component = makeComponent(node, id);
    components.push(component);
    const childIds = (node.children ?? []).map((child, index) => build(child, `${path}-${index}`));
    if (childIds.length > 0) {
      component.children = childIds;
    }
    return id;
  };

  const childIds = treeNodes.map((node, index) => build(node, String(index)));
  return { childIds, components };
};

// Materializes a `{ "$source": "assessments" }` marker into one `AssessmentCard`
// per assessment for the CURRENT trace, returning the child ids to place into
// the host `AssessmentBoard`'s `children` and the components to append.
export const buildAssessmentCardComponents = (
  items: AssessmentBoardItem[],
  { idPrefix }: { idPrefix: string },
): { childIds: string[]; components: Record<string, unknown>[] } => {
  const components: Record<string, unknown>[] = [];
  const childIds = items.map((item, index) => {
    const id = `${idPrefix}-card-${index}`;
    components.push({
      id,
      component: 'AssessmentCard',
      name: item.name,
      ...(item.value !== undefined ? { value: item.value } : {}),
      ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
      ...(item.source !== undefined ? { source: item.source } : {}),
      sentiment: item.sentiment,
    });
    return id;
  });
  return { childIds, components };
};
