import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  Button,
  Empty,
  Input,
  PlusIcon,
  SegmentedControlButton,
  SegmentedControlGroup,
  SimpleSelect,
  SimpleSelectOption,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { useEndpointsQuery } from '@mlflow/mlflow/src/gateway/hooks/useEndpointsQuery';
import { Catalog, MessageProcessor, type A2uiClientAction, type A2uiMessage } from '@a2ui/web_core/v0_9';
import { BASIC_FUNCTIONS } from '@a2ui/web_core/v0_9/basic_catalog';
import { A2uiSurface, Column, Row, Text, type ReactComponentImplementation } from '@a2ui/react/v0_9';

import type { Feedback, ModelTrace } from '../ModelTrace.types';
import { ModelSpanType } from '../ModelTrace.types';
import { isV3ModelTraceInfo } from '../ModelTraceExplorer.utils';
import { useModelTraceExplorerViewState } from '../ModelTraceExplorerViewStateContext';
import { getUser } from '../../global-settings/getUser';
import { useCreateAssessment } from '../hooks/useCreateAssessment';
import { AssessmentBoard } from './AssessmentBoard';
import { AssessmentCard } from './AssessmentCard';
import { Card } from './Card';
import { DataTable } from './DataTable';
import { DEFAULT_FEEDBACK_NAME, FEEDBACK_SUBMITTED, FeedbackButtons } from './FeedbackButtons';
import { Icon } from './Icon';
import { KeyValueViewer } from './KeyValueViewer';
import { Markdown } from './Markdown';
import { MediaRenderer } from './MediaRenderer';
import { StatCard } from './StatCard';
import { TimelineChart } from './TimelineChart';
import { type PanelItem } from './TreeSelectionContext';
import { TreeNode } from './TreeNode';
import { TREE_NODE_SELECTED, TreeView } from './TreeView';
import type { AgentNode } from './agent/buildAgentPrompt';
import { useAgentDashboard } from './agent/useAgentDashboard';
import {
  CUSTOM_VIEW_CATALOG_ID,
  type CustomViewData,
  type FirstToolIO,
  MESSAGE_SETS,
  buildSpanPanelComponents,
  getAgentAssessments,
  getAssessmentBoardItems,
  getContentFields,
  getMessageSet,
  getMetricsFromTraceInfo,
  getTimelineRowsFromNodes,
  getToolRowsFromNodeMap,
  getTreeNodesFromNodes,
} from './customViewBuilders';
import { type CustomViewPanel, EMPTY_CUSTOM_VIEW_DEFINITION } from './customViewDefinition';
import { useCustomViewDefinitionState, useOptionalCustomViewDefinition } from './CustomViewDefinitionContext';
import { classifyPanelRequiresRegeneration, resolveTemplate } from './resolveTemplate';

// Deterministic surface id per panel so React/A2UI reuse the same surface across
// trace cycling (we rebuild the surface contents, not its identity).
const surfaceIdForPanel = (panel: CustomViewPanel): string => `cv-${panel.id}`;

let panelIdCounter = 0;
const nextPanelId = (): string => `${Date.now().toString(36)}-${(panelIdCounter++).toString(36)}`;

const placeholderMessages = (surfaceId: string, text: string): A2uiMessage[] => [
  { version: 'v0.9', createSurface: { surfaceId, catalogId: CUSTOM_VIEW_CATALOG_ID, sendDataModel: true } },
  { version: 'v0.9', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Text', text }] } },
];

export const ModelTraceExplorerCustomView = ({ modelTraceInfo }: { modelTraceInfo: ModelTrace['info'] }) => {
  const { theme } = useDesignSystemTheme();

  // Span data comes from the shared view-state context (the same source the
  // Summary tab uses). `nodeMap` holds every parsed span; `topLevelNodes`
  // preserves the hierarchy/order for the timeline.
  const { nodeMap, topLevelNodes } = useModelTraceExplorerViewState();

  // The experiment-scoped definition (persisted across traces). Falls back to a
  // session-local definition when no provider is mounted (e.g. notebook embed);
  // both hooks are always called to satisfy the rules of hooks.
  const providedDefinition = useOptionalCustomViewDefinition();
  const localDefinition = useCustomViewDefinitionState(EMPTY_CUSTOM_VIEW_DEFINITION, true);
  const cv = providedDefinition ?? localDefinition;

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
          FeedbackButtons,
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

  actionHandlerRef.current = (action: A2uiClientAction) => {
    if (action.name === FEEDBACK_SUBMITTED) {
      handleFeedbackAction(action);
    } else if (action.name === TREE_NODE_SELECTED) {
      handleTreeNodeSelected(action);
    }
  };

  // A single long-lived processor holds the state for every panel surface.
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

  const firstToolIO = useMemo<FirstToolIO | undefined>(() => {
    const toolNodes = Object.values(nodeMap)
      .filter((node) => node.type === ModelSpanType.TOOL)
      .sort((a, b) => a.start - b.start);
    if (toolNodes.length === 0) {
      return undefined;
    }
    const tool = toolNodes[0];
    return {
      toolName: typeof tool.title === 'string' ? tool.title : String(tool.title ?? 'tool'),
      input: getContentFields(tool.inputs)[0],
      output: getContentFields(tool.outputs)[0],
    };
  }, [nodeMap]);

  const viewData = useMemo<CustomViewData>(
    () => ({ metrics, toolRows, timelineRows, treeNodes, treeRoots, assessmentItems, firstToolIO }),
    [metrics, toolRows, timelineRows, treeNodes, treeRoots, assessmentItems, firstToolIO],
  );

  // The trace's nodeMap as plain JSON (keyed by span id) for Agent Mode.
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

  const [selectedSetId, setSelectedSetId] = useState(MESSAGE_SETS[0].id);

  // 'predefined' appends a canned message set; 'agent' asks an LLM to generate
  // the (trace-agnostic) A2UI template.
  const [viewMode, setViewMode] = useState<'predefined' | 'agent'>('predefined');
  const { data: endpoints, isLoading: endpointsLoading } = useEndpointsQuery();
  const [selectedEndpoint, setSelectedEndpoint] = useState('');
  const [instruction, setInstruction] = useState('');
  const { generate, isLoading: agentLoading, error: agentError, reset: resetAgent } = useAgentDashboard();

  useEffect(() => {
    if (!selectedEndpoint && endpoints.length > 0) {
      setSelectedEndpoint(endpoints[0].name);
    }
  }, [endpoints, selectedEndpoint]);

  // Per-(trace, panel) cache of LLM-generated templates for panels that must be
  // regenerated per trace (trace-specific narrative the host can't re-bind). The
  // template is still bound through resolveTemplate so its `$source` parts pick
  // up the active trace's data.
  const regenCacheRef = useRef<Map<string, A2uiMessage[]>>(new Map());
  const regenInFlightRef = useRef<Set<string>>(new Set());
  const [regenErrors, setRegenErrors] = useState<Record<string, string>>({});
  // Bumped whenever a background regeneration resolves so the rebuild effect re-runs.
  const [regenVersion, setRegenVersion] = useState(0);

  // The set of surfaceIds we've created, so we can delete the ones whose panels
  // were removed.
  const managedSurfacesRef = useRef<Set<string>>(new Set());

  // The rebuild effect mutates the processor model AFTER render (creating new
  // surface objects). `A2uiSurface` binds to a specific surface instance, so we
  // force one render afterwards to re-read the current surfaces. This tick is
  // intentionally NOT a rebuild-effect dependency, so it never re-runs the
  // rebuild (no loop).
  const [, refreshSurfaces] = useReducer((tick: number) => tick + 1, 0);

  // Rebuild every panel's surface whenever the definition or the active trace
  // changes: predefined panels re-run their builder; agent panels bind their
  // template to the current trace (regenerating per trace only when required).
  useEffect(() => {
    if (!cv.isLoaded) {
      return;
    }

    const desired = new Set(cv.definition.panels.map(surfaceIdForPanel));
    for (const surfaceId of Array.from(managedSurfacesRef.current)) {
      if (!desired.has(surfaceId)) {
        processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId } }]);
        managedSurfacesRef.current.delete(surfaceId);
      }
    }

    const triggerRegen = (panel: Extract<CustomViewPanel, { kind: 'agent' }>, cacheKey: string) => {
      if (regenInFlightRef.current.has(cacheKey) || regenErrors[cacheKey]) {
        return;
      }
      regenInFlightRef.current.add(cacheKey);
      generate({
        instruction: panel.instruction,
        endpointName: panel.endpointName ?? selectedEndpoint,
        surfaceId: `regen-${cacheKey}`,
        catalogId: CUSTOM_VIEW_CATALOG_ID,
        data: { ...viewData, nodeMap: agentNodeMap, assessments: agentAssessments },
        // Reproduce the saved structure for the new trace (with fresh narrative).
        previousTemplate: panel.template,
      })
        .then((messages) => {
          regenCacheRef.current.set(cacheKey, messages);
          setRegenVersion((version) => version + 1);
        })
        .catch((error) => {
          setRegenErrors((prev) => ({
            ...prev,
            [cacheKey]: error instanceof Error ? error.message : 'Failed to generate view for this trace.',
          }));
          // Re-run the rebuild so the panel's placeholder shows the error.
          setRegenVersion((version) => version + 1);
        })
        .finally(() => {
          regenInFlightRef.current.delete(cacheKey);
        });
    };

    for (const panel of cv.definition.panels) {
      const surfaceId = surfaceIdForPanel(panel);
      // Delete any prior contents so the surface rebinds cleanly to this trace.
      if (managedSurfacesRef.current.has(surfaceId)) {
        processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId } }]);
      }

      let messages: A2uiMessage[];
      if (panel.kind === 'predefined') {
        const messageSet = getMessageSet(panel.setId);
        messages = messageSet
          ? messageSet.build(surfaceId, viewData)
          : placeholderMessages(surfaceId, 'This view is no longer available.');
      } else if (!panel.requiresRegeneration) {
        messages = resolveTemplate(panel.template, surfaceId, viewData);
      } else {
        const cacheKey = `${traceId}::${panel.id}`;
        const cached = regenCacheRef.current.get(cacheKey);
        if (cached) {
          messages = resolveTemplate(cached, surfaceId, viewData);
        } else if (regenErrors[cacheKey]) {
          messages = placeholderMessages(surfaceId, `Could not generate this view: ${regenErrors[cacheKey]}`);
        } else {
          messages = placeholderMessages(surfaceId, 'Generating this view for the current trace…');
          triggerRegen(panel, cacheKey);
        }
      }

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

    // Re-read the (possibly recreated) surface objects on the next render so each
    // panel renders its latest content rather than a deleted/stale surface.
    refreshSurfaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cv.definition, cv.isLoaded, viewData, traceId, regenVersion, processor]);

  const handleAddBlock = () => {
    const messageSet = getMessageSet(selectedSetId) ?? MESSAGE_SETS[0];
    cv.addPanel({ id: nextPanelId(), kind: 'predefined', setId: messageSet.id, label: messageSet.label });
  };

  // Drops all cached per-trace regenerations for a panel whose template changed,
  // so other traces re-generate against the new spec instead of showing stale UI.
  const purgeRegenForPanel = (panelId: string) => {
    const suffix = `::${panelId}`;
    for (const key of Array.from(regenCacheRef.current.keys())) {
      if (key.endsWith(suffix)) {
        regenCacheRef.current.delete(key);
      }
    }
    setRegenErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.endsWith(suffix)) {
          delete next[key];
        }
      }
      return next;
    });
  };

  // Agent Mode uses a SINGLE surface: the first prompt creates the agent panel,
  // and every subsequent prompt MODIFIES that same panel (the model receives the
  // current spec and returns the full edited spec). So we reuse the existing
  // agent panel's id (hence its surface) instead of appending a new block.
  const handleGenerateAgentBlock = async () => {
    const endpointName = selectedEndpoint;
    const prompt = instruction.trim();
    if (!endpointName || !prompt) {
      return;
    }
    const existingAgent = cv.definition.panels.find(
      (entry): entry is Extract<CustomViewPanel, { kind: 'agent' }> => entry.kind === 'agent',
    );
    const panelId = existingAgent?.id ?? nextPanelId();
    try {
      const template = await generate({
        instruction: prompt,
        endpointName,
        surfaceId: `cv-template-${panelId}`,
        catalogId: CUSTOM_VIEW_CATALOG_ID,
        data: { ...viewData, nodeMap: agentNodeMap, assessments: agentAssessments },
        // Iterative edit: hand the model the current spec so it modifies it.
        previousTemplate: existingAgent?.template,
      });
      const requiresRegeneration = classifyPanelRequiresRegeneration(template);
      // The template changed, so any cached regenerations for it are stale.
      purgeRegenForPanel(panelId);
      if (requiresRegeneration) {
        // Seed the cache for the current trace so the panel renders immediately
        // without a second LLM call.
        regenCacheRef.current.set(`${traceId}::${panelId}`, template);
      }
      cv.upsertPanel({
        id: panelId,
        kind: 'agent',
        instruction: prompt,
        endpointName,
        template,
        requiresRegeneration,
        label: prompt,
      });
      setInstruction('');
    } catch {
      // The failure is surfaced via `agentError` below; the panel is not added.
    }
  };

  const panels = cv.definition.panels;
  // Agent Mode is a single surface: once an agent panel exists, prompts edit it.
  const hasAgentPanel = panels.some((panel) => panel.kind === 'agent');

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
        <div css={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <SegmentedControlGroup
            name="custom-view-mode"
            componentId="shared.model-trace-explorer.custom-view.mode-toggle"
            value={viewMode}
            onChange={(event) => {
              setViewMode(event.target.value);
              resetAgent();
            }}
          >
            <SegmentedControlButton value="predefined">Predefined Prompts</SegmentedControlButton>
            <SegmentedControlButton value="agent">Agent Mode</SegmentedControlButton>
          </SegmentedControlGroup>
          <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
            {cv.canPersist && (
              <Button
                componentId="shared.model-trace-explorer.custom-view.save"
                onClick={cv.save}
                loading={cv.isSaving}
                disabled={!cv.isDirty || cv.isSaving}
              >
                {cv.isDirty ? 'Save to experiment' : 'Saved'}
              </Button>
            )}
            <Button
              componentId="shared.model-trace-explorer.custom-view.clear-all"
              onClick={cv.clearPanels}
              disabled={panels.length === 0}
            >
              Clear all
            </Button>
          </div>
        </div>

        {cv.saveError && (
          <Typography.Text size="sm" css={{ color: theme.colors.textValidationDanger }}>
            {cv.saveError}
          </Typography.Text>
        )}

        {viewMode === 'predefined' ? (
          <div css={{ display: 'flex', alignItems: 'flex-end', gap: theme.spacing.sm }}>
            <div css={{ width: 380 }}>
              <SimpleSelect
                componentId="shared.model-trace-explorer.custom-view.message-set-select"
                id="model-trace-explorer-custom-view-message-set-select"
                label="View"
                value={selectedSetId}
                onChange={(event) => setSelectedSetId(event.target.value)}
              >
                {MESSAGE_SETS.map((set) => (
                  <SimpleSelectOption key={set.id} value={set.id}>
                    {set.label}
                  </SimpleSelectOption>
                ))}
              </SimpleSelect>
            </div>
            <Button
              componentId="shared.model-trace-explorer.custom-view.add-block"
              icon={<PlusIcon />}
              onClick={handleAddBlock}
            >
              Add to dashboard
            </Button>
          </div>
        ) : (
          <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
            {endpoints.length === 0 ? (
              <Typography.Text color="secondary">
                {endpointsLoading
                  ? 'Loading AI gateway endpoints…'
                  : 'No AI gateway endpoints are configured. Add one to use Agent Mode.'}
              </Typography.Text>
            ) : (
              <>
                <div css={{ display: 'flex', alignItems: 'flex-end', gap: theme.spacing.sm }}>
                  <div css={{ width: 240 }}>
                    <SimpleSelect
                      componentId="shared.model-trace-explorer.custom-view.agent-endpoint-select"
                      id="model-trace-explorer-custom-view-agent-endpoint-select"
                      label="AI endpoint"
                      value={selectedEndpoint}
                      onChange={(event) => setSelectedEndpoint(event.target.value)}
                    >
                      {endpoints.map((endpoint) => (
                        <SimpleSelectOption key={endpoint.name} value={endpoint.name}>
                          {endpoint.name}
                        </SimpleSelectOption>
                      ))}
                    </SimpleSelect>
                  </div>
                  <Button
                    componentId="shared.model-trace-explorer.custom-view.agent-generate"
                    icon={<PlusIcon />}
                    loading={agentLoading}
                    disabled={!selectedEndpoint || !instruction.trim() || agentLoading}
                    onClick={handleGenerateAgentBlock}
                  >
                    {hasAgentPanel ? 'Update view' : 'Generate'}
                  </Button>
                </div>
                <Input.TextArea
                  componentId="shared.model-trace-explorer.custom-view.agent-instruction"
                  placeholder={
                    hasAgentPanel
                      ? 'Refine the current view, e.g. “add a feedback button to each span” or “also show a tool latency table”.'
                      : 'Describe the dashboard to generate, e.g. “Show a table of tool latencies and a timeline of all spans”.'
                  }
                  value={instruction}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => setInstruction(event.target.value)}
                  disabled={agentLoading}
                />
                {agentError && (
                  <Typography.Text size="sm" css={{ color: theme.colors.textValidationDanger }}>
                    {agentError.message}
                  </Typography.Text>
                )}
              </>
            )}
          </div>
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
            <Typography.Text color="secondary">Loading saved custom view…</Typography.Text>
          </div>
        ) : panels.length === 0 ? (
          <div
            css={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              minHeight: 240,
              width: '100%',
              '& > div': {
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
              },
            }}
          >
            <Empty description="Add a predefined view or generate one with Agent Mode. Saved views apply to every trace in this experiment." />
          </div>
        ) : (
          panels.map((panel) => {
            const surfaceId = surfaceIdForPanel(panel);
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
                  <Typography.Text bold>{panel.label}</Typography.Text>
                </div>
                <div css={{ padding: theme.spacing.md }}>
                  {surface && <A2uiSurface key={`${surfaceId}-${traceId}`} surface={surface} />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
