import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  Button,
  ChevronDownIcon,
  DropdownMenu,
  Empty,
  FormUI,
  GenericSkeleton,
  Input,
  Modal,
  OverflowIcon,
  PlusIcon,
  SparkleDoubleIcon,
  TrashIcon,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { Catalog, MessageProcessor, type A2uiClientAction, type A2uiMessage } from '@a2ui/web_core/v0_9';
import { BASIC_FUNCTIONS } from '@a2ui/web_core/v0_9/basic_catalog';
import { A2uiSurface, Column, Row, type ReactComponentImplementation } from '@a2ui/react/v0_9';

import type { Feedback, ModelTrace } from '../ModelTrace.types';
import { ModelSpanType } from '../ModelTrace.types';
import { displaySuccessNotification, isV3ModelTraceInfo } from '../ModelTraceExplorer.utils';
import { useModelTraceExplorerViewState } from '../ModelTraceExplorerViewStateContext';
import { getUser } from '../../global-settings/getUser';
import { useCreateAssessment } from '../hooks/useCreateAssessment';
import { AssessmentBoard } from './catalog-primitives/AssessmentBoard';
import { AssessmentCard } from './catalog-primitives/AssessmentCard';
import { Card } from './catalog-primitives/Card';
import { DataTable } from './catalog-primitives/DataTable';
import {
  DEFAULT_FEEDBACK_NAME,
  FEEDBACK_SUBMITTED,
  FeedbackThumbsUpDownButtons,
} from './catalog-primitives/FeedbackThumbsUpDownButtons';
import { FEEDBACK_STAGED, FEEDBACK_SUBMIT_ALL, type StagedFeedbackContext } from './catalog-primitives/feedbackActions';
import { FeedbackInputText } from './catalog-primitives/FeedbackInputText';
import { FeedbackSubmit } from './catalog-primitives/FeedbackSubmit';
import { RadioGroup } from './catalog-primitives/RadioGroup';
import { Text } from './catalog-primitives/Text';
import { Icon } from './catalog-primitives/Icon';
import { KeyValueViewer } from './catalog-primitives/KeyValueViewer';
import { Markdown } from './catalog-primitives/Markdown';
import { MediaRenderer } from './catalog-primitives/MediaRenderer';
import { StatCard } from './catalog-primitives/StatCard';
import { TimelineChart } from './catalog-primitives/TimelineChart';
import { type PanelItem } from './TreeSelectionContext';
import { TreeNode } from './catalog-primitives/TreeNode';
import { TREE_NODE_SELECTED, TreeView } from './catalog-primitives/TreeView';
import type { AgentNode } from './agent/buildAgentPrompt';
import { validateAndPrepareMessages, validateTemplate } from './agent/validateA2uiMessages';
import { resolveTemplate } from './resolveTemplate';
import { useCustomViewAssistantBridge } from './assistant/useCustomViewAssistantBridge';
import {
  CUSTOM_VIEW_CATALOG_ID,
  type CustomViewData,
  buildSpanPanelComponents,
  getAgentAssessments,
  getAssessmentBoardItems,
  getMetricsFromTraceInfo,
  getTimelineRowsFromNodes,
  getToolRowsFromNodeMap,
  getTreeNodesFromNodes,
} from './customViewBuilders';
import { type CustomView } from './customViewDefinition';
import { useCustomViewDefinitionState, useOptionalCustomViewDefinition } from './CustomViewDefinitionContext';

// Deterministic surface id per view so React/A2UI reuse the same surface across
// trace cycling (we rebuild the surface contents, not its identity).
const surfaceIdForView = (view: CustomView): string => `cv-${view.id}`;

let viewIdCounter = 0;
const nextViewId = (): string => `${Date.now().toString(36)}-${(viewIdCounter++).toString(36)}`;

const DEFAULT_NEW_VIEW_NAME = 'View';

const placeholderMessages = (surfaceId: string, text: string): A2uiMessage[] => [
  { version: 'v0.9', createSurface: { surfaceId, catalogId: CUSTOM_VIEW_CATALOG_ID, sendDataModel: true } },
  { version: 'v0.9', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Text', text }] } },
];

// Host-rendered loading state shown in the empty state while MLflow Assistant
// streams the FIRST authoring reply (before any view exists). Per-trace cycling
// re-binds host-side with no LLM call, so there is no per-trace loading state.
const CustomViewGeneratingSkeleton = () => {
  const { theme } = useDesignSystemTheme();
  return (
    <div
      role="status"
      aria-label="Building this custom view"
      css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}
    >
      <Typography.Text color="secondary">Building this custom view…</Typography.Text>
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
        <GenericSkeleton style={{ height: 24, width: '40%' }} />
        <GenericSkeleton style={{ height: 72 }} />
        <GenericSkeleton style={{ height: 72 }} />
        <div css={{ display: 'flex', gap: theme.spacing.sm }}>
          <GenericSkeleton style={{ height: 56, flex: 1 }} />
          <GenericSkeleton style={{ height: 56, flex: 1 }} />
        </div>
        <GenericSkeleton style={{ height: 96 }} />
      </div>
    </div>
  );
};

export const ModelTraceExplorerCustomView = ({ modelTraceInfo }: { modelTraceInfo: ModelTrace['info'] }) => {
  const { theme } = useDesignSystemTheme();

  // Span data comes from the shared view-state context (the same source the
  // Summary tab uses). `nodeMap` holds every parsed span; `topLevelNodes`
  // preserves the hierarchy/order for the timeline.
  const { nodeMap, topLevelNodes } = useModelTraceExplorerViewState();

  // The experiment-scoped views (persisted across traces). Falls back to a
  // session-local registry when no provider is mounted (e.g. notebook embed);
  // both hooks are always called to satisfy the rules of hooks.
  const providedDefinition = useOptionalCustomViewDefinition();
  const localDefinition = useCustomViewDefinitionState([], true);
  const cv = providedDefinition ?? localDefinition;
  const activeView = cv.activeView;

  // The catalog maps component type names to their React implementations.
  const catalog = useMemo(
    () =>
      new Catalog<ReactComponentImplementation>(
        CUSTOM_VIEW_CATALOG_ID,
        [
          Text,
          Row,
          Column,
          MediaRenderer,
          Card,
          Icon,
          StatCard,
          DataTable,
          TimelineChart,
          TreeView,
          TreeNode,
          Markdown,
          AssessmentBoard,
          AssessmentCard,
          KeyValueViewer,
          FeedbackThumbsUpDownButtons,
          RadioGroup,
          FeedbackInputText,
          FeedbackSubmit,
        ],
        BASIC_FUNCTIONS,
      ),
    [],
  );

  const traceId = useMemo(
    () => (isV3ModelTraceInfo(modelTraceInfo) ? modelTraceInfo.trace_id : (modelTraceInfo.request_id ?? '')),
    [modelTraceInfo],
  );
  const { createAssessmentMutation } = useCreateAssessment({ traceId });

  // The processor's action handler is created once, so we route through a ref
  // that always points at the latest mutation / traceId / nodeMap.
  const actionHandlerRef = useRef<(action: A2uiClientAction) => void>(() => {});

  // The currently selected TreeView node per surface, captured from the
  // selection action. The TreeView's side panel is injected lazily on selection,
  // so when we rebuild a surface (trace cycle / feedback) we re-inject the
  // selected node's panel — but only when it belongs to the active trace.
  const selectionBySurfaceRef = useRef<
    Map<string, { nodeId: string; spanId?: string; panelItems: PanelItem[]; traceId: string }>
  >(new Map());

  // Staged-but-unsubmitted feedback per surface, keyed by `name` + `spanId` so
  // the same assessment dimension rated on two different spans (e.g. "Accuracy"
  // on two tool cards) does not collide. The RadioGroup / FeedbackInputText
  // primitives merge their value/rationale here (no POST); FeedbackSubmit
  // flushes the surface's entries into assessments.
  const pendingFeedbackRef = useRef<
    Map<string, Map<string, { name: string; value?: string; rationale?: string; spanId?: string }>>
  >(new Map());

  const handleFeedbackAction = (action: A2uiClientAction) => {
    const context = action.context ?? {};
    const value = context.value;
    if (typeof value !== 'boolean') {
      return;
    }
    const name = typeof context.name === 'string' && context.name ? context.name : DEFAULT_FEEDBACK_NAME;
    const spanId = typeof context.spanId === 'string' && context.spanId ? context.spanId : undefined;
    const feedbackValue: { feedback: Feedback } = { feedback: { value } };
    createAssessmentMutation({
      assessment: {
        assessment_name: name,
        trace_id: traceId,
        source: { source_type: 'HUMAN', source_id: getUser() ?? '' },
        ...(spanId ? { span_id: spanId } : {}),
        ...feedbackValue,
      },
    });
  };

  const handleTreeNodeSelected = (action: A2uiClientAction) => {
    const context = action.context ?? {};
    const nodeId = typeof context.nodeId === 'string' && context.nodeId ? context.nodeId : undefined;
    if (!nodeId) {
      return;
    }
    const spanId = typeof context.spanId === 'string' && context.spanId ? context.spanId : undefined;
    const panelItems = Array.isArray(context.panelItems) ? (context.panelItems as PanelItem[]) : [];
    // Remember the selection (tagged with the active trace) so a later rebuild of
    // this surface can re-inject the panel instead of leaving the TreeView
    // pointing at a wiped subtree.
    selectionBySurfaceRef.current.set(action.surfaceId, { nodeId, spanId, panelItems, traceId });
    const components = buildSpanPanelComponents(nodeId, spanId, panelItems, nodeMap);
    processor.processMessages([{ version: 'v0.9', updateComponents: { surfaceId: action.surfaceId, components } }]);
  };

  // Merge a staged-feedback change into the surface's pending buffer (no POST).
  const handleStageFeedback = (action: A2uiClientAction) => {
    const context = (action.context ?? {}) as StagedFeedbackContext;
    const name = typeof context.name === 'string' && context.name ? context.name : undefined;
    if (!name) {
      return;
    }
    let surfaceBuffer = pendingFeedbackRef.current.get(action.surfaceId);
    if (!surfaceBuffer) {
      surfaceBuffer = new Map();
      pendingFeedbackRef.current.set(action.surfaceId, surfaceBuffer);
    }
    const spanId = typeof context.spanId === 'string' && context.spanId ? context.spanId : undefined;
    // Key by name + spanId so the same dimension on different spans stays distinct.
    const bufferKey = `${name}\u0000${spanId ?? ''}`;
    const previous = surfaceBuffer.get(bufferKey) ?? { name };
    surfaceBuffer.set(bufferKey, {
      ...previous,
      name,
      ...(typeof context.value === 'string' ? { value: context.value } : {}),
      ...(typeof context.rationale === 'string' ? { rationale: context.rationale } : {}),
      ...(spanId ? { spanId } : {}),
    });
  };

  // Flush every staged dimension for the surface into MLflow assessments (one
  // per name), then clear the buffer. Entries with neither a value nor a
  // rationale are skipped.
  const handleSubmitAllFeedback = (action: A2uiClientAction) => {
    const surfaceBuffer = pendingFeedbackRef.current.get(action.surfaceId);
    if (!surfaceBuffer || surfaceBuffer.size === 0) {
      return;
    }
    let submitted = 0;
    for (const entry of surfaceBuffer.values()) {
      const hasValue = typeof entry.value === 'string' && entry.value.length > 0;
      const hasRationale = typeof entry.rationale === 'string' && entry.rationale.length > 0;
      if (!hasValue && !hasRationale) {
        continue;
      }
      const feedbackValue: { feedback: Feedback } = { feedback: { value: hasValue ? entry.value! : null } };
      createAssessmentMutation({
        assessment: {
          assessment_name: entry.name,
          trace_id: traceId,
          source: { source_type: 'HUMAN', source_id: getUser() ?? '' },
          ...(entry.spanId ? { span_id: entry.spanId } : {}),
          ...feedbackValue,
          ...(hasRationale ? { rationale: entry.rationale } : {}),
        },
      });
      submitted += 1;
    }
    pendingFeedbackRef.current.delete(action.surfaceId);
    if (submitted > 0) {
      displaySuccessNotification(`Submitted ${submitted} feedback ${submitted === 1 ? 'response' : 'responses'}.`);
    }
  };

  actionHandlerRef.current = (action: A2uiClientAction) => {
    if (action.name === FEEDBACK_SUBMITTED) {
      handleFeedbackAction(action);
    } else if (action.name === FEEDBACK_STAGED) {
      handleStageFeedback(action);
    } else if (action.name === FEEDBACK_SUBMIT_ALL) {
      handleSubmitAllFeedback(action);
    } else if (action.name === TREE_NODE_SELECTED) {
      handleTreeNodeSelected(action);
    }
  };

  // A single long-lived processor holds the state for the active view's surface.
  const [processor] = useState(
    () => new MessageProcessor<ReactComponentImplementation>([catalog], (action) => actionHandlerRef.current(action)),
  );

  // The tree starts one layer below the trace root (omit the top-level wrapper
  // span). Falls back to the top-level nodes if the root has no children.
  const treeRoots = useMemo(() => {
    const children = topLevelNodes.flatMap((node) => node.children ?? []);
    return children.length > 0 ? children : topLevelNodes;
  }, [topLevelNodes]);

  const metrics = useMemo(() => getMetricsFromTraceInfo(modelTraceInfo), [modelTraceInfo]);
  const toolRows = useMemo(() => getToolRowsFromNodeMap(nodeMap), [nodeMap]);
  const timelineRows = useMemo(() => getTimelineRowsFromNodes(topLevelNodes), [topLevelNodes]);
  const treeNodes = useMemo(() => getTreeNodesFromNodes(treeRoots), [treeRoots]);

  const agentAssessments = useMemo(() => getAgentAssessments(modelTraceInfo, nodeMap), [modelTraceInfo, nodeMap]);
  const assessmentItems = useMemo(() => getAssessmentBoardItems(agentAssessments), [agentAssessments]);

  const viewData = useMemo<CustomViewData>(
    () => ({ metrics, toolRows, timelineRows, treeNodes, assessmentItems }),
    [metrics, toolRows, timelineRows, treeNodes, assessmentItems],
  );

  // The trace's nodeMap as plain JSON (keyed by span id) for the assistant.
  const agentNodeMap = useMemo(() => {
    const nodes = Object.values(nodeMap);
    if (nodes.length === 0) {
      return {};
    }
    const traceStartUs = Math.min(...nodes.map((node) => node.start));
    const json: Record<string, AgentNode> = {};
    for (const node of nodes) {
      json[String(node.key)] = {
        name: typeof node.title === 'string' ? node.title : String(node.title ?? 'unknown'),
        type: node.type ?? ModelSpanType.UNKNOWN,
        startMs: Math.max(node.start - traceStartUs, 0) / 1000,
        endMs: Math.max(node.end - traceStartUs, 0) / 1000,
        durationMs: Math.max(node.end - node.start, 0) / 1000,
        parentId: node.parentId ? String(node.parentId) : undefined,
        inputs: node.inputs,
        outputs: node.outputs,
      };
    }
    return json;
  }, [nodeMap]);

  // The full trace data handed to the Assistant bridge. Memoized so its
  // reference is stable across renders (it only changes when the active trace's
  // data changes).
  const agentData = useMemo(
    () => ({ ...viewData, nodeMap: agentNodeMap, assessments: agentAssessments }),
    [viewData, agentNodeMap, agentAssessments],
  );

  // The prompt typed in the empty-state box before/while a view is being built.
  const [instruction, setInstruction] = useState('');

  // True after the user submits the FIRST (chat-driven) build prompt and before
  // a view exists, so the empty state can show a loading skeleton instead of the
  // prompt box while MLflow Assistant streams its first reply.
  const [isInitialBuilding, setIsInitialBuilding] = useState(false);

  // The naming modal collects the user-facing view name (distinct from the
  // LLM-generated panel label). Opened by "Create trace view" and by the first
  // save of a never-named view.
  const [nameModalOpen, setNameModalOpen] = useState(false);
  const [nameModalMode, setNameModalMode] = useState<'create' | 'save'>('create');
  const [nameInput, setNameInput] = useState(DEFAULT_NEW_VIEW_NAME);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // The set of surfaceIds we've created, so we can delete the ones whose views
  // are no longer active.
  const managedSurfacesRef = useRef<Set<string>>(new Set());

  // The id of the view targeted by the next assistant spec. Held in a ref so
  // that several specs applied in the SAME tick (the bridge can apply more than
  // one assistant reply synchronously, before React commits the first) all
  // resolve to the same id instead of each minting a fresh one. Kept in sync
  // with the active view's id.
  const draftViewIdRef = useRef<string | undefined>(cv.activeViewId);
  useEffect(() => {
    draftViewIdRef.current = cv.activeViewId;
  }, [cv.activeViewId]);

  // The rebuild effect mutates the processor model AFTER render (creating new
  // surface objects). `A2uiSurface` binds to a specific surface instance, so we
  // force one render afterwards to re-read the current surfaces. This tick is
  // intentionally NOT a rebuild-effect dependency, so it never re-runs the
  // rebuild (no loop).
  const [, refreshSurfaces] = useReducer((tick: number) => tick + 1, 0);

  // Parses + validates a raw JSON spec (captured from an MLflow Assistant reply)
  // into a stored, trace-agnostic BOUND TEMPLATE (markers preserved). Throws a
  // descriptive Error on failure. The template is re-bound per trace at render
  // time by `resolveTemplateForTrace` — no further LLM call.
  const prepareTemplateFromJson = (jsonText: string): A2uiMessage[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('The assistant did not return valid JSON.');
    }
    const result = validateTemplate(parsed);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.messages;
  };

  // Re-binds a stored template to the CURRENT trace: resolves every $source /
  // $spanRef marker against this trace's data, then strict-validates the resolved
  // components and stamps the host surface id. Falls back to an inline error
  // placeholder if the resolved stream fails validation. NO LLM call.
  const resolveTemplateForTrace = (template: A2uiMessage[], surfaceId: string): A2uiMessage[] => {
    const resolved = resolveTemplate(template, { viewData, nodeMap });
    const result = validateAndPrepareMessages(resolved, { surfaceId, catalogId: CUSTOM_VIEW_CATALOG_ID });
    if (!result.ok) {
      return placeholderMessages(surfaceId, `Could not render this view for the current trace: ${result.error}`);
    }
    return result.messages;
  };

  // The assistant wraps its spec as { title, messages }. Pulls out the LLM-chosen
  // title (used as the panel label); returns undefined for a bare array or a
  // missing/empty title so the caller can fall back.
  const extractTitleFromJson = (jsonText: string): string | undefined => {
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const title = (parsed as Record<string, unknown>)['title'];
        if (typeof title === 'string' && title.trim()) {
          return title.trim();
        }
      }
    } catch {
      // Fall through to undefined; prepareTemplateFromJson surfaces parse errors.
    }
    return undefined;
  };

  // All custom-view authoring goes through MLflow Assistant: the empty-state box
  // and the "Edit" button open the assistant chat (frontend-capture via onSpec).
  // The assistant authors a trace-agnostic BOUND TEMPLATE once; cycling traces
  // re-binds it host-side with no further LLM call. Each spec targets the SINGLE
  // active view: the first spec creates it, later specs edit it (same id). The
  // user-provided `name` is preserved; the assistant only sets the panel `label`.
  const assistant = useCustomViewAssistantBridge({
    data: agentData,
    currentTemplate: activeView?.template,
    onSpec: (jsonText, assistantInstruction) => {
      const active = cv.activeView;
      const id = active?.id ?? draftViewIdRef.current ?? nextViewId();
      draftViewIdRef.current = id;
      try {
        const template = prepareTemplateFromJson(jsonText);
        // Prefer the LLM-chosen title for the panel label; keep the prior label
        // on an edit that omits one; fall back to the raw request for a brand-new
        // untitled view.
        const label = extractTitleFromJson(jsonText) ?? active?.label ?? assistantInstruction;
        // The user-facing name comes from the draft (naming modal) or the
        // existing view; never from the assistant. First-ever views are unnamed
        // until the first save prompts for one.
        const name = active?.name ?? cv.draftName ?? '';
        const createdAtMs = active?.createdAtMs ?? Date.now();
        cv.upsertViewContent({ id, name, label, instruction: assistantInstruction, template, createdAtMs });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Failed to apply the assistant view.';
      }
    },
  });

  // Staged-but-unsubmitted feedback is scoped to the trace it was entered on;
  // drop it when cycling so it never leaks onto a different trace's surface.
  useEffect(() => {
    pendingFeedbackRef.current.clear();
  }, [traceId]);

  // Rebuild the active view's surface whenever the active view, its template, or
  // the trace changes: re-bind the stored trace-agnostic template against the
  // CURRENT trace's data (no LLM call). Surfaces for non-active views are torn
  // down.
  useEffect(() => {
    if (!cv.isLoaded) {
      return;
    }

    const panelsToRender = activeView ? [activeView] : [];
    const desired = new Set(panelsToRender.map(surfaceIdForView));
    for (const surfaceId of Array.from(managedSurfacesRef.current)) {
      if (!desired.has(surfaceId)) {
        processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId } }]);
        managedSurfacesRef.current.delete(surfaceId);
      }
    }

    for (const view of panelsToRender) {
      const surfaceId = surfaceIdForView(view);
      // Delete any prior contents so the surface rebinds cleanly to this trace.
      if (managedSurfacesRef.current.has(surfaceId)) {
        processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId } }]);
      }

      const messages =
        view.template && view.template.length > 0
          ? resolveTemplateForTrace(view.template, surfaceId)
          : placeholderMessages(surfaceId, 'This view has no content yet. Edit it with MLflow Assistant.');

      processor.processMessages(messages);
      managedSurfacesRef.current.add(surfaceId);

      // Re-inject the selected node's side panel (lazily built on selection, so
      // wiped by the rebuild above). Only when the selection belongs to the
      // active trace; on a trace change the surface remounts and selection resets.
      const selection = selectionBySurfaceRef.current.get(surfaceId);
      if (selection && selection.traceId === traceId) {
        const panelComponents = buildSpanPanelComponents(
          selection.nodeId,
          selection.spanId,
          selection.panelItems,
          nodeMap,
        );
        processor.processMessages([
          { version: 'v0.9', updateComponents: { surfaceId, components: panelComponents } },
        ]);
      }
    }

    // Re-read the (possibly recreated) surface objects on the next render so the
    // panel renders its latest content rather than a deleted/stale surface.
    refreshSurfaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, cv.isLoaded, viewData, nodeMap, traceId, processor]);

  // Opens MLflow Assistant with the typed prompt as its first message; the reply
  // is captured by the bridge and applied via onSpec. Used by the empty/draft
  // state (before the active view has any content).
  const handleSubmitPrompt = () => {
    const prompt = instruction.trim();
    if (!prompt) {
      return;
    }
    assistant.openAssistant(prompt);
    setInstruction('');
    setIsInitialBuilding(true);
  };

  // Clear the initial-build skeleton once the build resolves: a view was created
  // (success), the apply failed (error), or the assistant finished streaming
  // without producing a spec. `isStreaming` flips true shortly after submit, so
  // we only treat its falling edge as "done" once it has actually started.
  const buildStreamStartedRef = useRef(false);
  useEffect(() => {
    if (!isInitialBuilding) {
      buildStreamStartedRef.current = false;
      return;
    }
    if (activeView || assistant.applyError) {
      setIsInitialBuilding(false);
      buildStreamStartedRef.current = false;
      return;
    }
    if (assistant.isStreaming) {
      buildStreamStartedRef.current = true;
    } else if (buildStreamStartedRef.current) {
      setIsInitialBuilding(false);
      buildStreamStartedRef.current = false;
    }
  }, [isInitialBuilding, activeView, assistant.applyError, assistant.isStreaming]);

  const openCreateModal = () => {
    setNameModalMode('create');
    setNameInput(DEFAULT_NEW_VIEW_NAME);
    setNameModalOpen(true);
  };

  const handleNameConfirm = () => {
    const name = nameInput.trim() || DEFAULT_NEW_VIEW_NAME;
    setNameModalOpen(false);
    if (nameModalMode === 'create') {
      cv.startNewView(name);
      setInstruction('');
    } else {
      cv.saveActiveView(name);
    }
  };

  const handleSave = () => {
    if (!activeView) {
      return;
    }
    // A never-named view (the first-ever view, built before any modal) prompts
    // for a name on its first save.
    if (!activeView.name.trim()) {
      setNameModalMode('save');
      setNameInput(DEFAULT_NEW_VIEW_NAME);
      setNameModalOpen(true);
      return;
    }
    cv.saveActiveView();
  };

  const handleDelete = () => {
    const id = cv.activeViewId;
    if (!id) {
      return;
    }
    cv.deleteView(id);
    setDeleteModalOpen(false);
  };

  const views = cv.views;

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        gap: theme.spacing.md,
        padding: theme.spacing.md,
      }}
    >
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm, flexShrink: 0 }}>
        <div css={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
            {views.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    componentId="shared.model-trace-explorer.custom-view.switch-view"
                    endIcon={<ChevronDownIcon />}
                  >
                    {activeView?.name || (cv.isDraft && cv.draftName ? cv.draftName : 'Select a view')}
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" minWidth={200}>
                  {views.map((view) => (
                    <DropdownMenu.CheckboxItem
                      key={view.id}
                      componentId="shared.model-trace-explorer.custom-view.switch-view-item"
                      checked={view.id === cv.activeViewId}
                      onClick={() => cv.selectView(view.id)}
                    >
                      <DropdownMenu.ItemIndicator />
                      {view.name || 'Untitled view'}
                    </DropdownMenu.CheckboxItem>
                  ))}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    componentId="shared.model-trace-explorer.custom-view.create-view"
                    onClick={openCreateModal}
                  >
                    <DropdownMenu.IconWrapper>
                      <PlusIcon />
                    </DropdownMenu.IconWrapper>
                    Create trace view
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            )}
          </div>

          <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
            {cv.canPersist && activeView && cv.isDirty && (
              <Button
                componentId="shared.model-trace-explorer.custom-view.save"
                type="primary"
                onClick={handleSave}
                loading={cv.isSaving}
                disabled={cv.isSaving}
              >
                Save
              </Button>
            )}
            {assistant.isAvailable && activeView && (
              <Button
                componentId="shared.model-trace-explorer.custom-view.assistant"
                icon={<SparkleDoubleIcon />}
                onClick={() => assistant.openAssistant()}
              >
                Edit with MLflow Assistant
              </Button>
            )}
            {activeView && cv.isActivePersisted && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    componentId="shared.model-trace-explorer.custom-view.actions-menu"
                    icon={<OverflowIcon />}
                    aria-label="More view actions"
                    disabled={cv.isSaving}
                  />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" minWidth={160}>
                  <DropdownMenu.Item
                    componentId="shared.model-trace-explorer.custom-view.delete"
                    onClick={() => setDeleteModalOpen(true)}
                  >
                    <DropdownMenu.IconWrapper>
                      <TrashIcon />
                    </DropdownMenu.IconWrapper>
                    Delete view
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            )}
          </div>
        </div>

        {cv.saveError && (
          <Typography.Text size="sm" css={{ color: theme.colors.textValidationDanger }}>
            {cv.saveError}
          </Typography.Text>
        )}

        {assistant.applyError && (
          <Typography.Text size="sm" css={{ color: theme.colors.textValidationDanger }}>
            MLflow Assistant: {assistant.applyError}
          </Typography.Text>
        )}
      </div>

      <div
        css={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing.md,
        }}
      >
        {!cv.isLoaded ? (
          <div css={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 240 }}>
            <Typography.Text color="secondary">Loading saved custom views…</Typography.Text>
          </div>
        ) : !activeView && isInitialBuilding ? (
          <div css={{ padding: theme.spacing.md }}>
            <CustomViewGeneratingSkeleton />
          </div>
        ) : !activeView ? (
          <div
            css={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              minHeight: 240,
              width: '100%',
              padding: theme.spacing.lg,
            }}
          >
            {assistant.isAvailable ? (
              <div
                css={{
                  width: '100%',
                  maxWidth: 720,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.spacing.md,
                }}
              >
                <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs, textAlign: 'center' }}>
                  <Typography.Title level={3} withoutMargins>
                    {cv.isDraft && cv.draftName ? `Build "${cv.draftName}"` : 'Build a custom trace view'}
                  </Typography.Title>
                  <Typography.Text color="secondary">
                    Describe how you want to view your trace data and MLflow Assistant will build it.
                  </Typography.Text>
                </div>
                <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
                  <Input.TextArea
                    componentId="shared.model-trace-explorer.custom-view.prompt"
                    placeholder="Example: Show me all the spans in this trace with their information"
                    value={instruction}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={(event) => setInstruction(event.target.value)}
                  />
                  <div css={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      componentId="shared.model-trace-explorer.custom-view.build"
                      icon={<SparkleDoubleIcon />}
                      disabled={!instruction.trim()}
                      onClick={handleSubmitPrompt}
                    >
                      Build with MLflow Assistant
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <Empty description="Set up MLflow Assistant to build a custom view for this experiment." />
            )}
          </div>
        ) : (
          (() => {
            const surfaceId = surfaceIdForView(activeView);
            const surface = processor.model.getSurface(surfaceId);
            return (
              <div
                key={surfaceId}
                css={{
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: theme.borders.borderRadiusMd,
                  backgroundColor: theme.colors.backgroundPrimary,
                }}
              >
                <div
                  css={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                    padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
                    borderBottom: `1px solid ${theme.colors.border}`,
                  }}
                >
                  <Typography.Title level={2} withoutMargins css={{ fontSize: 22, lineHeight: '28px', fontWeight: 600 }}>
                    {activeView.label}
                  </Typography.Title>
                </div>
                <div css={{ padding: theme.spacing.md }}>
                  {surface && <A2uiSurface key={`${surfaceId}-${traceId}`} surface={surface} />}
                </div>
              </div>
            );
          })()
        )}
      </div>

      <Modal
        componentId="shared.model-trace-explorer.custom-view.name-modal"
        title="Create trace view"
        visible={nameModalOpen}
        onCancel={() => setNameModalOpen(false)}
        onOk={handleNameConfirm}
        okText="Create"
        cancelText="Cancel"
        okButtonProps={{ disabled: !nameInput.trim() }}
      >
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <Typography.Text color="secondary">Create a new trace view for this project</Typography.Text>
          <FormUI.Label htmlFor="custom-view-name">Name</FormUI.Label>
          <Input
            id="custom-view-name"
            componentId="shared.model-trace-explorer.custom-view.name-input"
            value={nameInput}
            autoFocus
            onChange={(event) => setNameInput(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && nameInput.trim()) {
                handleNameConfirm();
              }
            }}
          />
        </div>
      </Modal>

      <Modal
        componentId="shared.model-trace-explorer.custom-view.delete-modal"
        title="Delete trace view"
        visible={deleteModalOpen}
        onCancel={() => setDeleteModalOpen(false)}
        onOk={handleDelete}
        okText="Delete"
        cancelText="Cancel"
        okButtonProps={{ danger: true }}
      >
        <Typography.Text>
          Delete the view{activeView?.name ? ` "${activeView.name}"` : ''}? This removes it from the experiment for
          everyone.
        </Typography.Text>
      </Modal>
    </div>
  );
};
