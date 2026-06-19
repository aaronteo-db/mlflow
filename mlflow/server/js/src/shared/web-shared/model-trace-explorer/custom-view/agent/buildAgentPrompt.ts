// Builds the chat messages sent to the gateway LLM to generate an A2UI message
// stream for one custom-view dashboard block. Follows A2UI v0.9's "prompt-first"
// contract: the schema + examples are embedded in the prompt and the model
// returns the full message stream, which the host validates before processing.

import type { A2uiMessage } from '@a2ui/web_core/v0_9';

export type AgentChatMessage = { role: 'system' | 'user'; content: string };

// One span's entry in the nodeMap JSON handed to the model. Keyed by span id,
// this is just the trace's nodeMap serialized to plain JSON (no curated shape).
export type AgentNode = {
  name: string;
  type: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  parentId?: string;
  inputs: unknown;
  outputs: unknown;
};

// A real assessment on the trace (LLM-judge or human feedback / expectation).
// This is the actual evaluation data — the model must use these values rather
// than inventing scores or judge results.
export type AgentAssessment = {
  name: string;
  value: unknown;
  rationale?: string;
  source: string;
  spanId?: string;
  error?: string;
};

// The trace data the model can use. `nodeMap` is the raw per-span source
// (including inputs/outputs) the model parses to extract what it needs; the
// other fields are precomputed conveniences for common views.
export type AgentTraceData = {
  metrics: Record<string, unknown>;
  toolRows: { color?: string; cells: string[] }[];
  timelineRows: { label: string; start: number; end: number; depth: number }[];
  treeNodes: unknown[];
  // The trace's nodeMap as plain JSON, keyed by span id. The model parses this
  // and binds the data it needs into components via the A2UI data model.
  nodeMap?: Record<string, AgentNode>;
  // The trace's real assessments (LLM-judge / human feedback). This is the ONLY
  // source of evaluation/judge results — there are no other scores.
  assessments?: AgentAssessment[];
};

// The surface id is a fixed placeholder; the host rewrites it to a unique id
// after generation, so the model never has to invent one.
const PLACEHOLDER_SURFACE_ID = 'main';

// The fenced code-block tag the MLflow Assistant must wrap its A2UI spec in, so
// the host can reliably extract the view spec from a free-form chat reply
// without hijacking unrelated assistant responses.
export const CUSTOM_VIEW_SPEC_FENCE = 'mlflow-custom-view';

export const CATALOG_REFERENCE = `Available components (use the "component" field with these exact names):

- "Row": horizontal layout. props: { "children": [<child ids>], "align"?: "start"|"center"|"end"|"stretch" }
- "Column": vertical layout. props: { "children": [<child ids>] }
- "Text": plain text. props: { "text": <string> }
- "Card": a bordered container around a SINGLE child. props: { "child": <child id> }. To put multiple elements in a card, wrap them in a Row/Column and pass that container's id as the child.
- "MediaRenderer": renders trace media (image, audio, or PDF). props: { "url": <string>, "alt"?: <alt text> }. "url" accepts a direct http(s):// URL, a data: URI, or an mlflow-attachment:// URI (the latter is fetched from the trace artifact store and rendered as a blob; image/audio/PDF are dispatched by content type). Audio and PDFs always arrive as mlflow-attachment:// URIs; only images can be a direct URL. Only use when the trace actually references a media URL or attachment.
- "Icon": a single Databricks Design System icon. props: { "name": <string>, "size"?: <number> }. Use a camelCase name, e.g. "check", "close", "warning", "error", "info", "search", "download", "settings", "star", "person", "folder", "play", "pause" (DS-native aliases like "trash"/"gear"/"pencil"/"tag" also work). Unknown names render a neutral default. Use sparingly — most components (StatCard/DataTable/etc.) already carry their own icon prop.
- "StatCard": a single metric tile. props: { "value": <string>, "label": <string>, "icon"?: "wrench"|"clock"|"checkCircle"|"xCircle"|"hash"|"checklist", "tone"?: "info"|"success"|"warning"|"danger" }
- "DataTable": a column-aligned table. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "columns": [{ "label": <string>, "align"?: "left"|"center"|"right" }], "rows": [{ "color"?: <css color>, "cells": [<string>, ...] }], "emptyMessage"?: <string> }. Each row's "cells" are positional, aligned to "columns" by index.
- "TimelineChart": a Gantt-style timeline. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "rows": [{ "label": <string>, "start": <number ms>, "end": <number ms>, "depth"?: <number>, "color"?: <css color> }], "emptyMessage"?: <string> }
- "TreeView": a collapsible tree CONTAINER. props: { "title"?: <string>, "children": [<TreeNode ids>], "emptyMessage"?: <string> }. It lays out its TreeNode children on the left and, when a node with "panelItems" is selected, shows that node's side panel (built by the host from the span's data) on the right. Build the tree from "TreeNode" components referenced by id.
- "TreeNode": one node in a TreeView. props: { "label"?: <string>, "title"?: <string heading; overrides label>, "icon"?: <span icon type, reuse the value from treeNodes>, "hasException"?: <bool>, "isRootSpan"?: <bool>, "badge"?: <string>, "spanId"?: <string span id>, "panelItems"?: [<side-panel directives>], "children"?: [<nested TreeNode ids>] }. "panelItems" declares WHAT the side panel shows when the node is selected; the host builds the actual components from the span's data, so you NEVER emit the span inputs/outputs yourself. Each item is one of: { "type": "input" } / { "type": "output" } / { "type": "attributes" } (the span field as a KeyValueViewer; optional "title" overrides the label), { "type": "markdown", "text": <markdown>, "title"?: <heading> } (a Markdown block; supports [text](#span:<spanId>) deeplinks), or { "type": "feedback", "label"?: <prompt>, "name"?: <assessment name> } (thumbs up/down scoped to this node's span). Give the node a "spanId" whenever you use input/output/attributes/feedback items so the host can find the span. Keep nodes MINIMAL by default (no "panelItems") unless the user asks to inspect spans, collect feedback, or summarize a trajectory.
- "Markdown": a markdown text block. props: { "text": <markdown string>, "title"?: <string heading> }. Links of the form [text](#span:<spanId>) select the TreeView node for that span instead of navigating. Usually you produce markdown via a TreeNode "panelItems" entry rather than a standalone component.
- "KeyValueViewer": displays a SINGLE labeled value with a format toggle (text/json/markdown for strings; JSON tree for objects). props: { "label"?: <string>, "value": <JSON-encoded string>, "initialFormat"?: "json"|"text"|"markdown", "hideFormatToggle"?: <bool> }. Use this when the user asks to see ONE specific attribute/field of a span (e.g. a span's "model" input) OUTSIDE a tree. "value" is a scalar string, so you may inline it or bind it via updateDataModel + { "path": "/..." }; when the value is an object, JSON-stringify it first. (Inside a TreeView, prefer a TreeNode "panelItems" input/output/attributes directive instead — the host builds the KeyValueViewer for you.)
- "AssessmentCard": a single colored box for one assessment/judge result. props: { "name": <string>, "value"?: <string>, "rationale"?: <string>, "source"?: <string>, "sentiment"?: "positive"|"negative"|"neutral"|"error" }. Set "name" to the assessment name, "value" to a SHORT verdict (e.g. "yes"/"no"/"Error" — never a long string), "rationale" to its rationale (put any long error message here, not in "value"), "source" to its source, and "sentiment" to "positive" for yes/true/pass values, "negative" for no/false/fail values, "error" if it has an error, else "neutral".
- "AssessmentBoard": a wrapping container for AssessmentCards. props: { "title"?: <string>, "icon"?: "checklist"|"list"|"checkCircle", "children": [<AssessmentCard ids>], "emptyMessage"?: <string> }. For any request about judge results / evaluations / feedback, emit one AssessmentCard per entry in the "assessments" data and list their ids in this board's "children".
- "FeedbackButtons": an INTERACTIVE thumbs up/down control that lets the user log feedback on the trace. props: { "label"?: <string prompt, e.g. "Was this helpful?">, "name"?: <assessment name, defaults to "User feedback">, "value"?: bind to a "/feedback/..." path via { "path": "/..." } to reflect the choice, "spanId"?: <string> }. Clicking a thumb logs an MLflow feedback assessment (thumbs up = true, thumbs down = false). Use this ONLY when the user explicitly asks to COLLECT/CAPTURE feedback or add a thumbs up/down control — never to display existing judge results (use AssessmentCard/AssessmentBoard for those).`;

export const SOURCES_REFERENCE = `Data binding with "$source" markers (IMPORTANT — makes the view reusable across traces):

The dashboard you generate is SAVED and reused for EVERY trace in the experiment, not just this one. So you must NOT hard-code this trace's data. Instead of inlining concrete values, reference the trace's data with a "$source" marker object; the host replaces each marker with the ACTIVE trace's data when the view is shown, with no further generation. Use these markers:

- { "$source": "metrics" } — the whole metrics object ({ status, latency, totalTokens, assessments }). Place it as the "value" of an "updateDataModel" message, then bind individual StatCard "value"s by path (e.g. { "path": "/status" }).
- { "$source": "metric", "key": "latency" } — a single metric string (key is one of "status" | "latency" | "totalTokens" | "assessments"). Use directly as a StatCard "value" or Text "text".
- { "$source": "toolRows" } — set as a DataTable "rows" value; resolves to per-tool rows whose cells are [tool, calls, success, avg latency]. Pair with literal "columns": [ {"label":"Tool"}, {"label":"Calls"}, {"label":"Success"}, {"label":"Latency (AVG)"} ].
- { "$source": "timelineRows" } — set as a TimelineChart "rows" value; resolves to one bar per span.
- { "$source": "assessmentItems" } — array of { name, value, rationale, source, sentiment } for the trace's judge/feedback results (rarely needed directly; prefer the structural marker below).
- { "$source": "spanTree", "panelItems"?: [ ... ] } — set as a TreeView "children" value; the host materializes a TreeNode per span (full hierarchy, correct icons/spanIds). Add "panelItems" (e.g. [ { "type": "input" }, { "type": "output" } ]) to attach a side panel to every span node.
- { "$source": "assessmentCards" } — set as an AssessmentBoard "children" value; the host materializes one AssessmentCard per assessment.

A view that sources ALL of its data via markers is re-bound instantly for any trace (no regeneration). It is fine to still write literal, trace-SPECIFIC narrative (e.g. a milestone markdown summary with [text](#span:<id>) deeplinks) when the user asks for a written summary; the host detects that and regenerates just that view per trace. Prefer markers wherever the data is structured (tables, timelines, metrics, span trees).`;

export const OUTPUT_RULES = `Output format rules (A2UI v0.9):
1. Respond with ONLY a single JSON array of message objects, wrapped in a \`\`\`json code fence. No prose before or after.
2. EVERY message object MUST include "version": "v0.9".
3. Each message object contains EXACTLY ONE of: "createSurface", "updateComponents", "updateDataModel".
4. Do NOT emit "createSurface" or "deleteSurface" — the host creates the surface for you. Emit only "updateComponents" (and optionally "updateDataModel"). Always use "surfaceId": "${PLACEHOLDER_SURFACE_ID}".
5. The "updateComponents" message has { "surfaceId": "${PLACEHOLDER_SURFACE_ID}", "components": [...] }.
6. Components are a flat adjacency list: each has a unique "id" and a "component" type. Reference children by their string ids in a "children" array (do NOT nest component objects).
7. There MUST be exactly one component with "id": "root", and it MUST be the first component. Parents must appear before their children.
8. ARRAY-VALUED props MUST be EITHER a literal array OR a single "$source" marker (NOT a { "path": ... } binding). PREFER a "$source" marker for any whole-trace data so the view is reusable: set a DataTable/TimelineChart "rows" to { "$source": "toolRows" } / { "$source": "timelineRows" }, a TreeView "children" to { "$source": "spanTree", ... }, and an AssessmentBoard "children" to { "$source": "assessmentCards" }. Use literal arrays only for static, trace-independent content (e.g. a DataTable's "columns" headers). "columns", a row's "cells", and "panelItems" are otherwise literal. Do NOT bind array props with { "path": ... }.
9. SCALAR string props may use a { "$source": "metric", "key": "..." } marker (preferred for metrics), a { "path": "/..." } data-model binding, or a literal. For metrics, emit ONE "updateDataModel" with "value": { "$source": "metrics" } and bind each StatCard "value" by path (e.g. { "path": "/latency" }), OR put { "$source": "metric", "key": "latency" } directly on the StatCard "value". Avoid inlining concrete trace numbers as literals — that would freeze the view to this trace.
10. Only use the component types and props listed in the catalog. Do not invent components, props, icon names, or enum values.
11. CRITICAL — never fabricate data. Use ONLY values that appear literally in the provided trace data. Do NOT invent, estimate, or infer metrics, scores, counts, percentages, failure patterns, recommendations, or config values that are not present. In particular: this is ONE single trace (not a corpus), so never reference a number of "traces analyzed"/"low-score traces" or any cross-trace aggregate. The ONLY judge/evaluation results are the entries in "assessments" (each with name/value/rationale/source); "metrics.assessments" is merely their COUNT. There are NO retrieval scores, average scores, failure patterns, threshold/chunk-size settings, or config recommendations unless they appear verbatim in "assessments" or a span's inputs/outputs.
12. If the requested information is not present in the provided data, do NOT make something up. Instead render a single short message stating it is unavailable (e.g. a "Text" component with "text": "No LLM judge feedback is available in this trace." as the root, or a "StatCard" with value "N/A"). It is better to say the data is unavailable than to display fabricated values.`;

export const EXAMPLE = `Example — a tool performance table plus a metrics row:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["metrics", "tools"] },
        { "id": "metrics", "component": "Row", "children": ["stat-latency", "stat-tokens"], "align": "stretch" },
        { "id": "stat-latency", "component": "StatCard", "value": "1.20s", "label": "Latency", "icon": "clock", "tone": "warning" },
        { "id": "stat-tokens", "component": "StatCard", "value": "3,120", "label": "Total Tokens", "icon": "hash", "tone": "info" },
        {
          "id": "tools",
          "component": "DataTable",
          "title": "Tool Performance",
          "icon": "wrench",
          "columns": [
            { "label": "Tool", "align": "left" },
            { "label": "Calls", "align": "center" },
            { "label": "Latency (AVG)", "align": "center" }
          ],
          "rows": [
            { "color": "#077A9D", "cells": ["run_sql_query", "4", "38.57ms"] },
            { "color": "#00A972", "cells": ["validate_schema", "4", "46.50ms"] }
          ],
          "emptyMessage": "No tool calls in this trace."
        }
      ]
    }
  }
]
\`\`\``;

export const TREE_EXAMPLE = `Example — a span tree. Build a "TreeView" whose "children" are "TreeNode" ids, one TreeNode per span (reuse each span's "label"/"icon"/"hasException"/"isRootSpan" from the "treeNodes" data, and set "spanId" to its id). Keep nodes MINIMAL by default — omit "panelItems" unless the user asks to inspect spans, collect feedback, or summarize a trajectory:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "TreeView", "title": "Span Tree", "children": ["n-0", "n-3"], "emptyMessage": "No spans." },
        { "id": "n-0", "component": "TreeNode", "label": "agent", "icon": "agent", "isRootSpan": true, "spanId": "span-0", "children": ["n-1", "n-2"] },
        { "id": "n-1", "component": "TreeNode", "label": "run_sql_query", "icon": "wrench", "spanId": "span-1" },
        { "id": "n-2", "component": "TreeNode", "label": "format_response", "icon": "function", "spanId": "span-2" },
        { "id": "n-3", "component": "TreeNode", "label": "validate_schema", "icon": "wrench", "spanId": "span-3" }
      ]
    }
  }
]
\`\`\`
A TreeNode's "children" are nested TreeNode ids (recurse the same way).

To show a span's INPUT and OUTPUT (or attributes), DO NOT emit the data yourself — just add "panelItems" directives and a "spanId"; the host builds the side panel from the span's real data when the node is selected. Example — input/output for each span:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "TreeView", "title": "Span Tree", "children": ["n-0", "n-1"] },
        { "id": "n-0", "component": "TreeNode", "label": "agent", "icon": "agent", "isRootSpan": true, "spanId": "span-0", "panelItems": [ { "type": "input" }, { "type": "output" } ], "children": ["n-1"] },
        { "id": "n-1", "component": "TreeNode", "label": "run_sql_query", "icon": "wrench", "spanId": "span-1", "panelItems": [ { "type": "input" }, { "type": "output" } ] }
      ]
    }
  }
]
\`\`\`
This stays tiny no matter how large the span inputs/outputs are, because the host fills in the data. Add { "type": "feedback" } to also collect a thumbs up/down per span, or { "type": "markdown", "text": "..." } for a summary.`;

export const MILESTONE_EXAMPLE = `Example — KEY ACTIONS / milestones that GROUP several spans. Each milestone is a span-less node (NO "spanId") with a markdown summary that deeplinks to the member spans; the member spans are its "children" (real nodes with a "spanId", each keeping its own sub-spans nested):
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "TreeView", "title": "Agent Key Actions", "children": ["ms-1", "ms-2"] },
        { "id": "ms-1", "component": "TreeNode", "title": "Step 1: Agent plans the deployment", "icon": "agent", "isRootSpan": true, "panelItems": [ { "type": "markdown", "title": "Action summary", "text": "The agent reasoned with [generate_content](#span:span-1), then issued a tool call to [generate_k8s_manifest](#span:span-2)." } ], "children": ["n-1", "n-2"] },
        { "id": "n-1", "component": "TreeNode", "label": "generate_content", "icon": "models", "spanId": "span-1", "panelItems": [ { "type": "input" }, { "type": "output" } ] },
        { "id": "n-2", "component": "TreeNode", "label": "generate_k8s_manifest", "icon": "wrench", "spanId": "span-2", "panelItems": [ { "type": "input" }, { "type": "output" } ] },
        { "id": "ms-2", "component": "TreeNode", "title": "Step 2: Agent delivers the workflow", "icon": "agent", "panelItems": [ { "type": "markdown", "title": "Action summary", "text": "The agent finalized the deployment via [format_response](#span:span-3)." } ], "children": ["n-3"] },
        { "id": "n-3", "component": "TreeNode", "label": "format_response", "icon": "function", "spanId": "span-3", "panelItems": [ { "type": "input" }, { "type": "output" } ] }
      ]
    }
  }
]
\`\`\`
Note: milestone nodes ("ms-*") have NO "spanId" and only a markdown summary; the real spans ("n-*") are nested as "children" and carry the "spanId" + input/output. A member span with its OWN sub-spans nests them the same way.`;

export const SOURCE_EXAMPLE = `Example — a REUSABLE dashboard that sources every value via "$source" markers (metrics row + tool table + span tree), so it re-binds to any trace with no regeneration:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateDataModel": { "surfaceId": "${PLACEHOLDER_SURFACE_ID}", "value": { "$source": "metrics" } }
  },
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["metrics", "tools", "tree"] },
        { "id": "metrics", "component": "Row", "children": ["stat-latency", "stat-tokens"], "align": "stretch" },
        { "id": "stat-latency", "component": "StatCard", "value": { "path": "/latency" }, "label": "Latency", "icon": "clock", "tone": "warning" },
        { "id": "stat-tokens", "component": "StatCard", "value": { "path": "/totalTokens" }, "label": "Total Tokens", "icon": "hash", "tone": "info" },
        {
          "id": "tools",
          "component": "DataTable",
          "title": "Tool Performance",
          "icon": "wrench",
          "columns": [ { "label": "Tool", "align": "left" }, { "label": "Calls", "align": "center" }, { "label": "Success", "align": "center" }, { "label": "Latency (AVG)", "align": "center" } ],
          "rows": { "$source": "toolRows" },
          "emptyMessage": "No tool calls in this trace."
        },
        { "id": "tree", "component": "TreeView", "title": "Span Tree", "children": { "$source": "spanTree", "panelItems": [ { "type": "input" }, { "type": "output" } ] }, "emptyMessage": "No spans." }
      ]
    }
  }
]
\`\`\`
Note: NO concrete trace values appear in the template — only markers + static labels/columns — so the host re-binds it to whichever trace is open.`;

export const BINDING_EXAMPLE = `Example — extract span inputs/outputs from nodeMap into the data model, then bind them:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateDataModel": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "value": {
        "calls": [
          { "name": "generate_content", "input": "{\\"prompt\\":\\"Summarize\\"}", "output": "{\\"text\\":\\"...\\"}" }
        ]
      }
    }
  },
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        {
          "id": "root",
          "component": "DataTable",
          "title": "generate_content I/O",
          "columns": [ { "label": "Call" }, { "label": "Input" }, { "label": "Output" } ],
          "rows": [
            { "cells": [ { "path": "/calls/0/name" }, { "path": "/calls/0/input" }, { "path": "/calls/0/output" } ] }
          ]
        }
      ]
    }
  }
]
\`\`\`
Note how each object input/output was JSON-stringified before being placed in the data model, so it renders as text in the table cells.`;

// Caps a potentially large array for the prompt, appending a note when trimmed
// so the model knows more data exists than what it can inline.
const cap = <T>(items: T[], max: number): { items: T[]; truncated: number } => {
  if (items.length <= max) {
    return { items, truncated: 0 };
  }
  return { items: items.slice(0, max), truncated: items.length - max };
};

// Keeps small inputs/outputs structured, but truncates large payloads to a
// string so a single span can't blow up the prompt.
const truncateValue = (value: unknown, max = 500): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  const str = JSON.stringify(value);
  if (str === undefined) {
    return value;
  }
  return str.length <= max ? value : `${str.slice(0, max)}… (truncated)`;
};

// Builds the compact, capped/truncated trace snapshot embedded in the prompt so
// the model understands what data exists (its shape), without copying concrete
// values into the (reusable) template. Shared by Agent Mode and the Assistant
// authoring guide.
export const buildAgentDataSnapshot = (data: AgentTraceData): Record<string, unknown> => {
  const timeline = cap(data.timelineRows, 60);
  const tree = cap(data.treeNodes, 40);

  // Serialize the nodeMap for the prompt: cap the number of spans and truncate
  // each span's inputs/outputs so a large trace can't blow up the context.
  const nodeMapEntries = Object.entries(data.nodeMap ?? {});
  const cappedEntries = nodeMapEntries.slice(0, 40);
  const nodeMapJson = Object.fromEntries(
    cappedEntries.map(([id, node]) => [
      id,
      { ...node, inputs: truncateValue(node.inputs), outputs: truncateValue(node.outputs) },
    ]),
  );
  const nodeMapTruncated = Math.max(nodeMapEntries.length - cappedEntries.length, 0);

  return {
    metrics: data.metrics,
    toolRows: data.toolRows,
    timelineRows: timeline.items,
    timelineRowsTruncated: timeline.truncated,
    treeNodes: tree.items,
    treeNodesTruncated: tree.truncated,
    // Raw per-span source (including inputs/outputs), keyed by span id.
    nodeMap: nodeMapJson,
    nodeMapTruncated,
    // The trace's real assessments (LLM-judge / human feedback). This is the
    // ONLY evaluation/judge data available.
    assessments: data.assessments ?? [],
  };
};

export const buildAgentMessages = ({
  instruction,
  data,
  previousTemplate,
}: {
  instruction: string;
  data: AgentTraceData;
  // The current dashboard's A2UI spec (trace-agnostic template). When present,
  // the model EDITS this single surface instead of producing a fresh one.
  previousTemplate?: A2uiMessage[];
}): AgentChatMessage[] => {
  const systemContent = [
    'You are a UI generation assistant for the MLflow trace explorer. You turn a user request into a REUSABLE A2UI dashboard. The dashboard is saved and shown for every trace in the experiment, so it must bind to trace data via "$source" markers rather than hard-coding this trace\'s values.',
    CATALOG_REFERENCE,
    SOURCES_REFERENCE,
    OUTPUT_RULES,
    SOURCE_EXAMPLE,
    EXAMPLE,
    TREE_EXAMPLE,
    MILESTONE_EXAMPLE,
    BINDING_EXAMPLE,
  ].join('\n\n');

  const dataSnapshot = buildAgentDataSnapshot(data);

  const editingLines =
    previousTemplate && previousTemplate.length > 0
      ? [
          'You are EDITING the experiment\'s existing single-surface dashboard. Its CURRENT A2UI spec is below (it uses "$source" markers to stay reusable across traces). Treat the user request as a MODIFICATION of THIS spec: keep everything the user did not ask to change, apply the requested change, and return the FULL updated message stream for the SAME single surface (NOT a diff, and NOT an unrelated new dashboard).',
          '```json',
          JSON.stringify(previousTemplate, null, 2),
          '```',
          '',
        ]
      : [];

  const userContent = [
    `User request: ${instruction}`,
    '',
    ...editingLines,
    'Trace data is below — but it is THIS trace\'s snapshot, shown only so you understand the shape/what exists. Do NOT copy its concrete values into the template. Bind the data with "$source" markers so the saved view re-binds to whichever trace is open:',
    '- whole-trace timeline → a TimelineChart "rows": { "$source": "timelineRows" }',
    '- per-tool table → a DataTable "rows": { "$source": "toolRows" } (with literal "columns" headers [Tool, Calls, Success, Latency (AVG)])',
    '- trace metrics → updateDataModel "value": { "$source": "metrics" } then bind StatCards by path, or { "$source": "metric", "key": "..." } per StatCard',
    '- the WHOLE span tree → a TreeView "children": { "$source": "spanTree", "panelItems"?: [ { "type": "input" }, { "type": "output" } ] }. The host materializes a TreeNode per span (correct icons/spanIds/hierarchy). The `treeNodes` array below shows you the shape so you can decide whether the user wants the tree at all and what panelItems to attach; you do NOT emit the nodes yourself for the full tree.',
    '- judge/feedback results → an AssessmentBoard "children": { "$source": "assessmentCards" }',
    'Only emit explicit per-span TreeNode components yourself when the user asks for a SUBSET of spans (e.g. only tool calls / only errors) that the spanTree marker cannot express, or for grouped milestones (below). In those cases reuse the `treeNodes`/`nodeMap` shape, set each node\'s "spanId", and add "panelItems" as needed.',
    'IMPORTANT — filtering to a subset: if the request asks for only a SUBSET of spans (e.g. "only tool calls", "only retrievers", "only errors"), emit TreeNodes ONLY for the matching spans. Every `treeNodes` entry has `attributes.type` and every `nodeMap` entry has a "type" field (the span type: "TOOL", "LLM", "RETRIEVER", "CHAIN", "PARSER", "AGENT", etc.). Select the matching spans (e.g. type === "TOOL"), emit a flat list of TreeNodes for them (no "children"), and reference their ids in the TreeView. For tool calls specifically, you may instead use `toolRows` which already contains only tools.',
    'MILESTONE / KEY-ACTION view: if the request asks to summarize the agent\'s KEY ACTIONS, trajectory, steps, or milestones, do NOT map one node per span. Instead read the WHOLE trace (use `nodeMap` + the `treeNodes` hierarchy) and CLUSTER related spans into a FEW key actions — a single key action usually covers MULTIPLE spans (e.g. an LLM call plus the tool calls it triggered, or a span and its whole subtree). Emit one milestone TreeNode per key action: give it a "title" (e.g. "Step 1: Agent plans the deployment"), DO NOT give it a "spanId" (it is a logical grouping, not a span), and add a "panelItems" markdown directive that summarizes the action using ONLY facts present in the data, with [text](#span:<spanId>) deeplinks to the member spans it summarizes: { "type": "markdown", "title": "Action summary", "text": "The agent called [generate_content](#span:<id>) then [run_sql_query](#span:<id>) ..." } (optionally also { "type": "feedback" }). Set the milestone\'s "children" to the actual member-span TreeNodes — each with its real "spanId", an optional "panelItems": [ { "type": "input" }, { "type": "output" } ], and any of THAT span\'s own child spans nested underneath (preserve the span hierarchy). Selecting a milestone shows its summary; following a deeplink selects the linked child span and opens its input/output panel.',
    'FLEXIBILITY — 1:1 vs grouped: the tree supports BOTH. If the user asks for a plain span tree or a node per span, give every node its own "spanId" and skip the grouping (see the span-tree example). Only group spans under span-less milestone nodes when the user asks for key actions / a summary / a trajectory (see the milestone example).',
    '`assessments` is the trace\'s REAL evaluation data (LLM-judge / human feedback): each has a `name`, a `value` (e.g. "yes"/"no"/a score/boolean), an optional `rationale`, a `source` (e.g. LLM_JUDGE), and an optional `error`. For any request about judge results, evaluations, scores, or feedback, use ONLY `assessments` — there is no other scoring data. If `assessments` is empty, say it is unavailable.',
    '`nodeMap` (keyed by span id) is the raw per-span source including each span\'s `type` and `inputs`/`outputs`; use it for anything the precomputed arrays do not cover. Only individual scalar values may be bound via an `updateDataModel` message and `{ "path": "/..." }`; all arrays must be inlined.',
    '```json',
    JSON.stringify(dataSnapshot, null, 2),
    '```',
    '',
    'Generate the A2UI message stream that best satisfies the request using ONLY the data above. Do not invent any values that are not present in this data. This is a single trace; if the requested information is not available, render a short "unavailable" message instead of fabricating numbers.',
  ].join('\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
};

// Static authoring guide handed to MLflow Assistant via page context (the
// assistant has no built-in knowledge of A2UI or the custom view). It mirrors
// the Agent Mode system prompt, but tells the assistant to wrap its A2UI spec in
// the CUSTOM_VIEW_SPEC_FENCE so the host can extract it from a free-form chat
// reply. The active trace snapshot and current view spec are delivered as
// separate context fields (see KnownAssistantContext.customViewAuthoring).
export const buildCustomViewAuthoringGuide = (): string => {
  const intro = [
    'CUSTOM TRACE VIEW AUTHORING MODE.',
    'The user is viewing the "Custom View" tab of the MLflow trace explorer for an experiment, and wants you to BUILD or MODIFY a reusable A2UI dashboard ("custom view") for it. The dashboard is SAVED on the experiment and shown for EVERY trace, so it must bind to trace data via "$source" markers rather than hard-coding this trace\'s values.',
    `When (and only when) the user asks you to build, change, or update the custom view, reply with the FULL A2UI message stream that satisfies the request, wrapped in a fenced code block tagged exactly \`${CUSTOM_VIEW_SPEC_FENCE}\` (NOT \`json\`). The host detects that fenced block and applies it to the view automatically. You may add a brief sentence of prose before the block, but the block must contain ONLY the JSON array. If the user is just asking a question (not requesting a view change), answer normally without the fenced block.`,
    'Always return the COMPLETE spec for the single view (not a diff). When a "currentTemplate" is provided in the context, treat the request as a modification of THAT spec: keep everything the user did not ask to change. Use the "traceSample" in the context only to understand the data shape — do NOT copy its concrete values into the template.',
  ].join('\n');

  const fenceRule = `OUTPUT FENCE OVERRIDE: The rules above say to wrap the JSON in a \`json\` fence — for this custom-view surface, IGNORE that and wrap your final A2UI array in a \`${CUSTOM_VIEW_SPEC_FENCE}\` fence instead. The example blocks below use a generic fence only for illustration of the JSON content; your actual reply MUST use the \`${CUSTOM_VIEW_SPEC_FENCE}\` fence.`;

  return [intro, CATALOG_REFERENCE, SOURCES_REFERENCE, OUTPUT_RULES, fenceRule, SOURCE_EXAMPLE, TREE_EXAMPLE, MILESTONE_EXAMPLE].join('\n\n');
};
