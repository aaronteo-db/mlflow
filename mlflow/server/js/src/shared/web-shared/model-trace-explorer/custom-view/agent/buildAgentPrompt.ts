// A2UI authoring building blocks for the custom view. Provides the component
// catalog / data-binding references and examples, the per-trace data snapshot,
// and the MLflow Assistant authoring guide. Follows A2UI v0.9's "prompt-first"
// contract: the schema + examples are embedded in the prompt and the model
// returns the full message stream, which the host validates before processing.

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
- "Text": a single-line/short text label rendered as real typography (NOT Markdown — do not put #, *, or _ in "text"; use the "Markdown" component for bold/italic/lists/multi-line). props: { "text": <string>, "variant"?: "h1"|"h2"|"h3"|"h4"|"h5"|"caption"|"body", "weight"?: <number> }. Use "variant" to build hierarchy: a Card/section title should be an "h3" or "h4" heading (larger, bold); small secondary metadata (a span id, a timestamp, a duration) should be "caption" (small + muted), e.g. { "text": "span: 17a1d...", "variant": "caption" }. Omit "variant" (or use "body") for normal text.
- "Card": a bordered container around a SINGLE child. props: { "child": <child id> }. To put multiple elements in a card, wrap them in a Row/Column and pass that container's id as the child.
- "MediaRenderer": renders trace media (image, audio, or PDF). props: { "url": <string>, "alt"?: <alt text> }. "url" accepts a direct http(s):// URL, a data: URI, or an mlflow-attachment:// URI (the latter is fetched from the trace artifact store and rendered as a blob; image/audio/PDF are dispatched by content type). Audio and PDFs always arrive as mlflow-attachment:// URIs; only images can be a direct URL. Only use when the trace actually references a media URL or attachment.
- "Icon": a single Databricks Design System icon. props: { "name": <string>, "size"?: <number> }. Use a camelCase name, e.g. "check", "close", "warning", "error", "info", "search", "download", "settings", "star", "person", "folder", "play", "pause" (DS-native aliases like "trash"/"gear"/"pencil"/"tag" also work). Unknown names render a neutral default. Use sparingly — most components (StatCard/DataTable/etc.) already carry their own icon prop.
- "StatCard": a single metric tile. props: { "value": <string>, "label": <string>, "icon"?: "wrench"|"clock"|"checkCircle"|"xCircle"|"hash"|"checklist", "tone"?: "info"|"success"|"warning"|"danger" }
- "DataTable": a column-aligned table. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "columns": [{ "label": <string>, "align"?: "left"|"center"|"right" }], "rows": [{ "color"?: <css color>, "cells": [<string>, ...] }], "emptyMessage"?: <string> }. Each row's "cells" are positional, aligned to "columns" by index.
- "TimelineChart": a Gantt-style timeline. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "rows": [{ "label": <string>, "start": <number ms>, "end": <number ms>, "depth"?: <number>, "color"?: <css color> }], "emptyMessage"?: <string> }
- "TreeView": a collapsible tree CONTAINER. props: { "title"?: <string>, "children": [<TreeNode ids>], "emptyMessage"?: <string> }. It lays out its TreeNode children on the left and, when a node with "panelItems" is selected, shows that node's side panel (built by the host from the span's data) on the right. Build the tree from "TreeNode" components referenced by id.
- "TreeNode": one node in a TreeView. props: { "label"?: <string>, "title"?: <string heading; overrides label>, "icon"?: <span icon type, reuse the value from treeNodes>, "hasException"?: <bool>, "isRootSpan"?: <bool>, "badge"?: <string>, "spanId"?: <string span id>, "panelItems"?: [<side-panel directives>], "children"?: [<nested TreeNode ids>] }. "panelItems" declares WHAT the side panel shows when the node is selected; the host builds the actual components from the span's data, so you NEVER emit the span inputs/outputs yourself. Each item is one of: { "type": "input" } / { "type": "output" } / { "type": "attributes" } (the span field as a KeyValueViewer; optional "title" overrides the label; the host also auto-renders any media attachments — audio/image/PDF — found in the field as playable players/thumbnails above the JSON, so you never need to handle media yourself), { "type": "markdown", "text": <markdown>, "title"?: <heading> } (a Markdown block; supports [text](#span:<spanId>) deeplinks), { "type": "feedback", "label"?: <prompt>, "name"?: <assessment name> } (thumbs up/down scoped to this node's span, logged immediately), { "type": "rating", "label"?: <prompt>, "name": <assessment name>, "options": [{ "label": <string>, "value": <string> }] } (a RadioGroup of choices), { "type": "rationale", "label"?: <prompt>, "name": <SAME name as its rating>, "placeholder"?: <string> } (an optional free-text "why" paired to a rating), or { "type": "submit", "label"?: <button text> } (logs all staged rating/rationale on this view). For a per-span rating panel, give each span a rating (+ optional rationale) with a UNIQUE "name" that includes the span (so spans don't collide), plus exactly ONE submit per node panel. Give the node a "spanId" whenever you use input/output/attributes/feedback/rating/rationale items so the host can find the span. Keep nodes MINIMAL by default (no "panelItems") unless the user asks to inspect spans, collect feedback, or summarize a trajectory.
- "Markdown": a markdown text block. props: { "text": <markdown string>, "title"?: <string heading> }. Links of the form [text](#span:<spanId>) select the TreeView node for that span instead of navigating. Usually you produce markdown via a TreeNode "panelItems" entry rather than a standalone component.
- "KeyValueViewer": displays a SINGLE labeled value with a format toggle (text/json/markdown for strings; JSON tree for objects). props: { "label"?: <string>, "value": <JSON-encoded string>, "initialFormat"?: "json"|"text"|"markdown", "hideFormatToggle"?: <bool> }. Use this when the user asks to see ONE specific attribute/field of a span (e.g. a span's "model" input) OUTSIDE a tree. "value" is a scalar string, so you may inline it or bind it via updateDataModel + { "path": "/..." }; when the value is an object, JSON-stringify it first. (Inside a TreeView, prefer a TreeNode "panelItems" input/output/attributes directive instead — the host builds the KeyValueViewer for you.)
- "AssessmentCard": a single colored box for one assessment/judge result. props: { "name": <string>, "value"?: <string>, "rationale"?: <string>, "source"?: <string>, "sentiment"?: "positive"|"negative"|"neutral"|"error" }. Set "name" to the assessment name, "value" to a SHORT verdict (e.g. "yes"/"no"/"Error" — never a long string), "rationale" to its rationale (put any long error message here, not in "value"), "source" to its source, and "sentiment" to "positive" for yes/true/pass values, "negative" for no/false/fail values, "error" if it has an error, else "neutral".
- "AssessmentBoard": a wrapping container for AssessmentCards. props: { "title"?: <string>, "icon"?: "checklist"|"list"|"checkCircle", "children": [<AssessmentCard ids>], "emptyMessage"?: <string> }. For any request about judge results / evaluations / feedback, emit one AssessmentCard per entry in the "assessments" data and list their ids in this board's "children".
- "FeedbackThumbsUpDownButtons": an INTERACTIVE thumbs up/down control that lets the user log feedback on the trace. props: { "label"?: <string prompt, e.g. "Was this helpful?">, "name"?: <assessment name, defaults to "User feedback">, "value"?: bind to a "/feedback/..." path via { "path": "/..." } to reflect the choice, "spanId"?: <string> }. Clicking a thumb logs an MLflow feedback assessment (thumbs up = true, thumbs down = false) IMMEDIATELY. Use this ONLY when the user explicitly asks to COLLECT/CAPTURE feedback or add a thumbs up/down control — never to display existing judge results (use AssessmentCard/AssessmentBoard for those).
- "RadioGroup": an INTERACTIVE single-choice feedback control (e.g. comparing responses: "Response A"/"Response B"/"Tie"). props: { "label"?: <string prompt, e.g. "Who did better on Accuracy?">, "name": <assessment name; REQUIRED and unique per dimension>, "options": [{ "label": <string>, "value": <string logged when selected> }], "value"?: bind to a "/feedback/..." path, "spanId"?: <string>, "weight"?: <number> }. Selecting an option STAGES the choice; it is logged only when a FeedbackSubmit is clicked. Emit one RadioGroup per feedback dimension.
- "FeedbackInputText": a feedback-scoped free-text box (NOT a generic input). props: { "label"?: <string>, "name": <assessment name / staging key; REQUIRED>, "field"?: "value"|"rationale" (default "rationale"), "placeholder"?: <string>, "value"?: bind to "/feedback/...", "spanId"?: <string>, "weight"?: <number> }. With field "rationale", give it the SAME "name" as a RadioGroup to capture that dimension's optional "why"; with field "value", use it standalone as a free-text feedback value. Like RadioGroup, its text STAGES and is logged only on FeedbackSubmit.
- "FeedbackSubmit": a button that submits ALL staged feedback (RadioGroup + FeedbackInputText) at once. props: { "label"?: <string, default "Submit feedback">, "weight"?: <number> }. Logs one assessment per staged dimension. Emit EXACTLY ONE when the view collects RadioGroup/FeedbackInputText feedback.

Feedback authoring rules: RadioGroup/FeedbackInputText STAGE their values and require a single FeedbackSubmit to persist; FeedbackThumbsUpDownButtons logs immediately and needs no submit (do not mix the two styles in one form). To build a comparison/rating form, emit one RadioGroup per dimension (unique "name"), an optional FeedbackInputText with field "rationale" and the SAME "name" for each, and one FeedbackSubmit. NEVER point a RadioGroup and a field:"value" FeedbackInputText at the same "name" (they would both write the value). Only add feedback controls when the user explicitly asks to collect/capture feedback.`;

export const LAYOUT_GUIDANCE = `Layout & visual polish (make views look designed, not flat):
1. Give structure with Cards. Group each logical section (a span, a response, a feedback block) into its own "Card". A Card holds ONE child, so put a "Column" inside it.
2. Title every Card. Make the FIRST child of a Card's Column a heading — a "Text" with "variant": "h3" or "h4" (or "h5" for sub-sections). Don't leave a bare body-text line acting as the title.
3. Demote metadata to captions. Render span ids, durations, timestamps, and other secondary details as a "Text" with "variant": "caption" (small + muted), e.g. { "text": "span: <id>", "variant": "caption" } — not as plain body text.
4. Use tiles for metrics. For single numbers/statuses (latency, tokens, status, counts) prefer "StatCard"s in a "Row" with "align": "stretch" rather than text lines.
5. Lay out intentionally. Use a "Row" ("align": "stretch") for side-by-side cards and a "Column" for stacked sections; keep one logical thing per Card so widths stay even.
6. Emphasize with Markdown. For bold/italic labels, lists, or multi-line prose use the "Markdown" component (the "Text" component is plain — never put # or ** inside its "text").
7. Aim for a consistent rhythm: heading -> optional caption -> content -> any inputs, inside each Card.`;

export const OUTPUT_RULES = `Output format rules (A2UI v0.9):
1. Respond with ONLY a single JSON OBJECT wrapped in a \`\`\`json code fence: { "title": <string>, "messages": [ <message objects> ] }. "title" is a SHORT (2-5 word) human-readable name describing the view (e.g. "Trace Summary", "Span Cards", "Agent Key Actions") — NOT the user's raw prompt. "messages" is the A2UI message array described by all rules below. No prose inside the fence. (The examples below show only the "messages" array for brevity; you must still wrap them as { "title", "messages" }.)
2. EVERY message object MUST include "version": "v0.9".
3. Each message object contains EXACTLY ONE of: "createSurface", "updateComponents", "updateDataModel".
4. Do NOT emit "createSurface" or "deleteSurface" — the host creates the surface for you. Emit only "updateComponents" (and optionally "updateDataModel"). Always use "surfaceId": "${PLACEHOLDER_SURFACE_ID}".
5. The "updateComponents" message has { "surfaceId": "${PLACEHOLDER_SURFACE_ID}", "components": [...] }.
6. Components are a flat adjacency list: each has a unique "id" and a "component" type. Reference children by their string ids in a "children" array (do NOT nest component objects). Put EVERY prop DIRECTLY on the component object alongside "id" and "component" — do NOT wrap them in a "props" object. Write { "id": "c1", "component": "Card", "child": "c2" }, NOT { "id": "c1", "component": "Card", "props": { "child": "c2" } }.
7. There MUST be exactly one component with "id": "root", and it MUST be the first component. Parents must appear before their children.
8. ARRAY-VALUED props (a DataTable/TimelineChart "rows", a "columns" list, a row's "cells", a TreeView/TreeNode "children", an AssessmentBoard "children", "panelItems") are LITERAL arrays. Build them directly from the values in the trace snapshot — e.g. one row per tool in "toolRows", one TreeNode per span in "treeNodes"/"nodeMap", one AssessmentCard per entry in "assessments".
9. SCALAR props are literal strings taken from the trace snapshot (e.g. a StatCard "value" of "1.83s" read from "metrics.latency"). You MAY instead stage values in an "updateDataModel" and reference them with a { "path": "/..." } binding within the same surface, but literals are simplest. Use the trace's REAL values — do not leave placeholders.
10. Only use the component types and props listed in the catalog. Do not invent components, props, icon names, or enum values.
11. CRITICAL — never fabricate data. Use ONLY values that appear literally in the provided trace data. Do NOT invent, estimate, or infer metrics, scores, counts, percentages, failure patterns, recommendations, or config values that are not present. In particular: this is ONE single trace (not a corpus), so never reference a number of "traces analyzed"/"low-score traces" or any cross-trace aggregate. The ONLY judge/evaluation results are the entries in "assessments" (each with name/value/rationale/source); "metrics.assessments" is merely their COUNT. There are NO retrieval scores, average scores, failure patterns, threshold/chunk-size settings, or config recommendations unless they appear verbatim in "assessments" or a span's inputs/outputs.
12. If the requested information is not present in the provided data, do NOT make something up. Instead render a single short message stating it is unavailable (e.g. a "Text" component with "text": "No LLM judge feedback is available in this trace." as the root, or a "StatCard" with value "N/A"). It is better to say the data is unavailable than to display fabricated values.`;

export const EXAMPLE = `Example — a tool performance table plus a metrics row (note the { "title", "messages" } wrapper):
\`\`\`json
{
  "title": "Trace Summary",
  "messages": [
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
}
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

export const FEEDBACK_EXAMPLE = `Example — a multi-dimension human-feedback form (only when the user asks to COLLECT feedback). One "RadioGroup" per dimension (unique "name"), an optional "FeedbackInputText" with field "rationale" sharing that "name", and exactly one "FeedbackSubmit" at the end. Values STAGE on change and are logged only when Submit is clicked:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["accuracy", "accuracy-why", "helpfulness", "submit"] },
        { "id": "accuracy", "component": "RadioGroup", "label": "Who did better on Accuracy?", "name": "Accuracy", "options": [ { "label": "Response A", "value": "Response A" }, { "label": "Response B", "value": "Response B" }, { "label": "Tie / Neither", "value": "Tie" } ] },
        { "id": "accuracy-why", "component": "FeedbackInputText", "label": "Optional rationale (why?)", "name": "Accuracy", "field": "rationale", "placeholder": "Briefly explain your choice (optional)" },
        { "id": "helpfulness", "component": "RadioGroup", "label": "Who did better on Helpfulness?", "name": "Helpfulness", "options": [ { "label": "Response A", "value": "Response A" }, { "label": "Response B", "value": "Response B" }, { "label": "Tie / Neither", "value": "Tie" } ] },
        { "id": "submit", "component": "FeedbackSubmit", "label": "Submit feedback" }
      ]
    }
  }
]
\`\`\`
For a single free-text feedback value instead of a rating, use a standalone "FeedbackInputText" with field "value" (its own unique "name") plus one "FeedbackSubmit".`;

export const CARD_STYLE_EXAMPLE = `Example — a DECORATED card (apply this styling pattern to every card: titled heading, caption metadata, content, then inputs). Here one span Card is rated for completeness:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["span-card", "submit"] },
        { "id": "span-card", "component": "Card", "child": "span-col" },
        { "id": "span-col", "component": "Column", "children": ["span-title", "span-id", "span-output", "rating", "rating-why"] },
        { "id": "span-title", "component": "Text", "text": "chat_agent", "variant": "h4" },
        { "id": "span-id", "component": "Text", "text": "span: 17a1d77743cce439", "variant": "caption" },
        { "id": "span-output", "component": "KeyValueViewer", "label": "Output", "value": "{...span output JSON...}", "initialFormat": "json" },
        { "id": "rating", "component": "RadioGroup", "label": "How complete is this span?", "name": "Completeness — chat_agent", "spanId": "17a1d77743cce439", "options": [ { "label": "Complete", "value": "Complete" }, { "label": "Mostly complete", "value": "Mostly complete" }, { "label": "Partially complete", "value": "Partially complete" }, { "label": "Incomplete", "value": "Incomplete" }, { "label": "Not applicable", "value": "Not applicable" } ] },
        { "id": "rating-why", "component": "FeedbackInputText", "label": "Optional rationale", "name": "Completeness — chat_agent", "field": "rationale", "placeholder": "Briefly explain (optional)" },
        { "id": "submit", "component": "FeedbackSubmit", "label": "Submit feedback" }
      ]
    }
  }
]
\`\`\`
Note the heading ("variant":"h4") as the card title and the span id as a ("variant":"caption") line — repeat this pattern for each card, and give each span's RadioGroup a UNIQUE "name" (+ its "spanId") so per-span ratings don't collide.`;

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
const truncateValue = (value: unknown, max = 2000): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  const str = JSON.stringify(value);
  if (str === undefined) {
    return value;
  }
  return str.length <= max ? value : `${str.slice(0, max)}… (truncated)`;
};

// Builds the compact, capped/truncated trace snapshot embedded in the prompt.
// This is the model's source of truth for the CURRENT trace: it reads concrete
// values (span ids, inputs/outputs, metrics, assessments) straight from here and
// bakes them into the generated view. Caps/truncation keep a large trace from
// blowing up the prompt (very large values may be truncated in the rendered UI).
export const buildAgentDataSnapshot = (data: AgentTraceData): Record<string, unknown> => {
  const timeline = cap(data.timelineRows, 300);
  const tree = cap(data.treeNodes, 200);

  // Serialize the nodeMap for the prompt: cap the number of spans and truncate
  // each span's inputs/outputs so a large trace can't blow up the context.
  const nodeMapEntries = Object.entries(data.nodeMap ?? {});
  const cappedEntries = nodeMapEntries.slice(0, 200);
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

// Static authoring guide handed to MLflow Assistant via page context (the
// assistant has no built-in knowledge of A2UI or the custom view). It tells the
// assistant to author the view for the CURRENT trace (using its real data) and
// to wrap its A2UI spec in the CUSTOM_VIEW_SPEC_FENCE so the host can extract it
// from a free-form chat reply. The active trace snapshot and the current view
// spec (as a layout reference) are delivered as separate context fields (see
// KnownAssistantContext.customViewAuthoring).
export const buildCustomViewAuthoringGuide = (): string => {
  const intro = [
    'CUSTOM TRACE VIEW AUTHORING MODE.',
    'The user is viewing the "Custom View" tab of the MLflow trace explorer and wants you to BUILD or MODIFY an A2UI view ("custom view") for the trace that is currently open. Build the view for THIS trace using its REAL data from the "traceSample" in the context — you may reference concrete span ids, inputs/outputs, metrics, and assessments directly. The host regenerates the view for each trace, so you do NOT need to make it reusable or generic; just produce the best view for this trace.',
    `When (and only when) the user asks you to build, change, or update the custom view, reply with a single JSON object { "title": <short 2-5 word view name>, "messages": [ <the FULL A2UI message stream> ] } wrapped in a fenced code block tagged exactly \`${CUSTOM_VIEW_SPEC_FENCE}\` (NOT \`json\`). The "title" names the VIEW (e.g. "Trace Summary", "Span Cards") — not the user's raw words. The host detects that fenced block and applies it to the view automatically. You may add a brief sentence of prose before the block, but the block must contain ONLY that JSON object. If the user is just asking a question (not requesting a view change), answer normally without the fenced block.`,
    'Always return the COMPLETE spec for the single view (not a diff). When a "currentTemplate" is provided in the context, it is the existing view\'s design (authored on a DIFFERENT trace): REPRODUCE the same layout and component choices, but regenerate ALL data — span ids, values, rows, text — from THIS trace\'s "traceSample". Do NOT reuse the reference\'s span ids or values, as they belong to another trace. Treat any wording change the user requests as a modification of that design, keeping everything else. Re-pick the "title" whenever an edit changes what the view shows — if the user redesigns it (e.g. from a span tree to per-span cards, or refocuses on different data), give it a new name that fits the new view; only keep the previous title when the edit is cosmetic (colors, spacing, minor wording).',
  ].join('\n');

  const fenceRule = `OUTPUT FENCE OVERRIDE: The rules above say to wrap the JSON in a \`json\` fence — for this custom-view surface, IGNORE that and wrap your final { "title", "messages" } object in a \`${CUSTOM_VIEW_SPEC_FENCE}\` fence instead. The example blocks below use a generic fence only for illustration of the JSON content; your actual reply MUST use the \`${CUSTOM_VIEW_SPEC_FENCE}\` fence.`;

  return [
    intro,
    CATALOG_REFERENCE,
    LAYOUT_GUIDANCE,
    OUTPUT_RULES,
    fenceRule,
    EXAMPLE,
    TREE_EXAMPLE,
    MILESTONE_EXAMPLE,
    CARD_STYLE_EXAMPLE,
    FEEDBACK_EXAMPLE,
  ].join('\n\n');
};
