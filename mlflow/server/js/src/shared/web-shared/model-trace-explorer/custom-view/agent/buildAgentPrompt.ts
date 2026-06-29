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

export const CATALOG_REFERENCE = `Available components (use the "component" field with these exact names). For DATA-bearing props you do NOT write literal trace values — you write a binding MARKER (see "Data binding" below). Layout text (titles, labels, column headers, option labels, icons, tones) stays a literal.

- "Row": horizontal layout. props: { "children": [<child ids>], "align"?: "start"|"center"|"end"|"stretch" }. For EQUAL-WIDTH columns, give EVERY direct child the SAME "weight" (e.g. "weight": 1) and set "align": "stretch" (so they also match heights). Without "weight" each child shrinks to its own content and the columns look uneven.
- "Column": vertical layout. props: { "children": [<child ids>] }
- "Text": a single-line/short text label rendered as real typography (NOT Markdown — do not put #, *, or _ in "text"; use the "Markdown" component for bold/italic/lists/multi-line). props: { "text": <string OR a spanField source marker>, "variant"?: "h1"|"h2"|"h3"|"h4"|"h5"|"caption"|"body", "weight"?: <number> }. Use "variant" to build hierarchy: a Card/section title should be an "h3" or "h4" heading (larger, bold); small secondary metadata should be "caption" (small + muted). "text" is normally a STATIC label, but to show a SPECIFIC span's name or id as a per-trace caption you may bind it to a "spanField" source, e.g. { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "name" } (see "Data binding"). Use static text for headings, spanField for per-span name/id captions.
- "Card": a bordered container around a SINGLE child. props: { "child": <child id>, "weight"?: <number> }. To put multiple elements in a card, wrap them in a Row/Column and pass that container's id as the child. When cards sit side by side in a Row, give each the SAME "weight" (e.g. "weight": 1) so they share the width equally.
- "MediaRenderer": renders trace media (image, audio, or PDF). props: { "url": <string>, "alt"?: <alt text> }. Only use when the trace actually references a media URL or attachment. (Media is otherwise auto-rendered by TreeView panel items — see TreeNode.)
- "Icon": a single Databricks Design System icon. props: { "name": <string>, "size"?: <number> }. Use a camelCase name, e.g. "check", "warning", "error", "info", "search". Use sparingly — most components already carry their own icon prop.
- "StatCard": a single metric tile. props: { "value": <SCALAR SOURCE marker>, "label": <string>, "icon"?: "wrench"|"clock"|"checkCircle"|"xCircle"|"hash"|"checklist", "tone"?: "info"|"success"|"warning"|"danger", "weight"?: <number> }. Bind "value" to a scalar source, e.g. { "$source": "metrics.latency" }. "label", "icon", "tone" are static. StatCards already flex to equal width in a Row; only set "weight" to bias the split.
- "DataTable": a column-aligned table. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "columns": [{ "label": <string>, "align"?: "left"|"center"|"right" }], "rows": <ARRAY SOURCE marker>, "emptyMessage"?: <string> }. "columns" are static (you define the headers). Bind "rows" to an array source, e.g. { "$source": "toolRows" } (the toolRows source's cells align to a Tool/Calls/Success/Latency column layout).
- "TimelineChart": a Gantt-style timeline. props: { "title"?: <string>, "icon"?: "list"|"wrench"|"clock"|"hash"|"checklist", "rows": <ARRAY SOURCE marker>, "emptyMessage"?: <string> }. Bind "rows" to { "$source": "timelineRows" } for ALL spans, or { "$source": "timelineRows", "filterType": "<SPAN_TYPE>" } to show only spans of that type (e.g. "TOOL" for a tool-calls timeline). When the user asks for "tool calls", "tools", or a specific span type, ALWAYS set "filterType" — do NOT bind the unfiltered source.
- "TreeView": a collapsible tree CONTAINER. props: { "title"?: <string>, "children": <STRUCTURAL SOURCE marker>, "emptyMessage"?: <string> }. Bind "children" to { "$source": "spanTree", "panelItems"?: [<side-panel directives>], "filterType"?: <SPAN_TYPE> }. The host materializes ONE TreeNode per span in the CURRENT trace (preserving hierarchy), attaching your "panelItems" to every node, so the tree is correct for a 5-span or a 50-span trace. Use "filterType" (e.g. "TOOL") to flatten the tree to only spans of that type. Do NOT hand-author TreeNode components — the host builds them.
- "TreeNode": a node built by the host from the spanTree source — you normally do NOT emit these directly. The side-panel "panelItems" you pass to the spanTree marker decide what each node's side panel shows when selected; the host builds the components from the span's REAL data. Each panel item is one of: { "type": "input" } / { "type": "output" } / { "type": "attributes" } (the span field as a KeyValueViewer; the host also auto-renders any media attachments found in the field), { "type": "markdown", "text": <STATIC markdown>, "title"?: <heading> } (a STATIC instructional/heading block — it is the SAME for every span and every trace, so it must NOT describe a specific span or trace; no "#span:" deeplinks), { "type": "feedback", "label"?: <prompt>, "name"?: <assessment name> } (thumbs up/down scoped to the selected node's span, logged immediately), { "type": "rating", "label"?: <prompt>, "name": <assessment name>, "options": [{ "label": <string>, "value": <string> }] } (a RadioGroup), { "type": "rationale", "label"?: <prompt>, "name": <SAME name as its rating>, "placeholder"?: <string> }, or { "type": "submit", "label"?: <button text> }. The host scopes feedback/rating panel items to the SELECTED node's span automatically (you don't set a spanId on panel items), and the "name" stays the SAME across spans/traces — it names the assessment DIMENSION (e.g. "Completeness"), never a specific span. Use rating(+rationale)+submit for multi-option ratings, feedback for a quick thumb. Keep panelItems empty by default unless the user asks to inspect spans, collect feedback, or summarize a trajectory.
- "Markdown": a STATIC markdown text block. props: { "text": <static markdown string>, "title"?: <string heading> }. Use it for instructions/headings only — it CANNOT show trace-varying data and MUST NOT contain trace-specific narrative or "#span:" deeplinks (those would point at a span that only exists in one trace and break when the view is reused). Prefer Text for short headings.
- "KeyValueViewer": displays a SINGLE labeled value. props: { "label"?: <string>, "value": <string OR a spanField source marker>, "initialFormat"?: "json"|"text"|"markdown", "hideFormatToggle"?: <bool> }. To show ONE specific span's input/output/attributes inline (e.g. a tool call's output in its own card), bind "value" to a "spanField" source with "initialFormat": "json", e.g. { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "outputs" } (see "Data binding"); the host re-resolves it per trace. To show input/output for EVERY span in a tree instead, use a TreeView spanTree "panelItems" directive. Do NOT paste literal span JSON into "value".
- "AssessmentCard": a single colored box for one assessment. You normally do NOT emit these directly — bind an AssessmentBoard's children to the assessments source and the host materializes one card per assessment. props (for reference): { "name", "value"?, "rationale"?, "source"?, "sentiment"? }.
- "AssessmentBoard": a wrapping container for assessment cards. props: { "title"?: <string>, "icon"?: "checklist"|"list"|"checkCircle", "children": <STRUCTURAL SOURCE marker>, "emptyMessage"?: <string> }. For ANY request about judge results / evaluations / assessments, bind "children" to { "$source": "assessments" }; the host builds one AssessmentCard per real assessment in the current trace. Do NOT hand-author AssessmentCards.
- "FeedbackThumbsUpDownButtons": an INTERACTIVE thumbs up/down control. props: { "label"?: <string prompt>, "name"?: <STATIC assessment name, defaults to "User feedback">, "value"?: bind to a "/feedback/..." path via { "path": "/..." }, "spanId"?: <SPAN-REF marker> }. Clicking a thumb logs an MLflow feedback assessment IMMEDIATELY against the CURRENT trace. To scope it to a span, set "spanId" to a span-ref marker (see "Data binding"); the host re-targets the equivalent span in whatever trace is open. Use ONLY when the user asks to COLLECT feedback — never to display judge results.
- "RadioGroup": an INTERACTIVE single-choice feedback control. props: { "label"?: <string prompt>, "name": <STATIC assessment name; REQUIRED, unique per dimension>, "options": [{ "label": <string>, "value": <string> }], "value"?: bind to "/feedback/...", "spanId"?: <SPAN-REF marker>, "weight"?: <number> }. Selecting STAGES the choice; logged on FeedbackSubmit.
- "FeedbackInputText": a feedback-scoped free-text box. props: { "label"?: <string>, "name": <STATIC name / staging key; REQUIRED>, "field"?: "value"|"rationale" (default "rationale"), "placeholder"?: <string>, "value"?: bind to "/feedback/...", "spanId"?: <SPAN-REF marker>, "weight"?: <number> }. With field "rationale", share the SAME "name" as a RadioGroup; with field "value", use standalone. STAGES; logged on FeedbackSubmit.
- "FeedbackSubmit": a button that submits ALL staged feedback at once. props: { "label"?: <string, default "Submit feedback">, "weight"?: <number> }. Emit EXACTLY ONE when the view collects RadioGroup/FeedbackInputText feedback.

Feedback authoring rules: RadioGroup/FeedbackInputText STAGE and require a single FeedbackSubmit; FeedbackThumbsUpDownButtons logs immediately (do not mix styles in one form). Feedback "name" is the STATIC assessment dimension (e.g. "Completeness", "Accuracy") and MUST be the same across every trace — never bake a span id or an authoring-trace span name into it. When a feedback control targets a span, qualify the name by ROLE if needed (e.g. "Completeness — LLM span"), set "spanId" to a span-ref marker, and the host re-resolves the right span per trace. NEVER point a RadioGroup and a field:"value" FeedbackInputText at the same "name". Only add feedback controls when the user explicitly asks to collect/capture feedback.`;

export const BINDING_REFERENCE = `Data binding (CRITICAL — author ONCE, reused for every trace):
You are authoring a REUSABLE, trace-agnostic TEMPLATE, not a one-off view. The "traceSample" in the context is ONLY an example of the shape of the data; you must NOT copy its concrete values, span ids, rows, or counts into the spec. Instead, every data-bearing prop is a binding MARKER that the host re-resolves against whatever trace is open. There are exactly two marker kinds and a CLOSED set of sources:

1. "$source" markers — fill a data prop with the current trace's data. Write { "$source": "<name>" } (structural sources also accept extra fields). Available sources:
   - Scalars (for a StatCard "value" or any scalar data prop): "metrics.status", "metrics.latency", "metrics.totalTokens", "metrics.assessments" (the latter is the COUNT of assessments).
   - Arrays (for a "rows" prop): "toolRows" (per-tool aggregate rows: Tool / Calls / Success / Latency — TOOL spans only), "timelineRows" (one bar per span; by DEFAULT this is EVERY span — add "filterType" to restrict it, e.g. { "$source": "timelineRows", "filterType": "TOOL" } for a tool-calls-only timeline).
   - Structural (for a "children" prop): "spanTree" (TreeView — one TreeNode per span; accepts "panelItems" and "filterType"), "assessments" (AssessmentBoard — one AssessmentCard per real assessment).
   - Per-span field (for a KeyValueViewer "value" or a Text "text", to show ONE specific span's data inline): "spanField". Write { "$source": "spanField", "spanRef": <selector>, "field": "<field>" } where "spanRef" is a BARE selector — exactly "root", { "type": "<SPAN_TYPE>", "nth"?: n }, or { "name": "<span name>" } — and "field" is one of "inputs", "outputs", "attributes" (rendered as JSON — use "initialFormat": "json"), "name", or "spanId" (short text). IMPORTANT: do NOT wrap the selector in "$spanRef" here — write "spanRef": "root" or "spanRef": { "type": "TOOL", "nth": 0 } (the "$spanRef": {...} wrapper is ONLY for a feedback control's "spanId", never for a spanField's "spanRef"). Use this for "rate the output of the first tool call"-style requests: bind the card's KeyValueViewer to { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "outputs" }, and the trace's user prompt to { "$source": "spanField", "spanRef": "root", "field": "inputs" }. If the selected span is absent in a trace, JSON fields resolve to an empty/null value and text fields to "" (an empty card), so the view degrades gracefully instead of showing another trace's data.
2. "$spanRef" markers — fill a feedback control's "spanId" so it targets the right span in EVERY trace. Write one of: { "$spanRef": "root" } (the trace's root span), { "$spanRef": { "type": "<SPAN_TYPE>", "nth"?: <n> } } (the nth span of that type, default 0; types include LLM, TOOL, CHAIN, AGENT, RETRIEVER), or { "$spanRef": { "name": "<span name>" } } (the first span whose name matches). If nothing matches in a trace, the host drops the spanId and the feedback logs at trace level. PREFER { "type": ..., "nth": ... } over { "name": ... } for "the first/second tool call", since a name from the authoring trace won't match other traces.

Conditional rendering:
- Any component may carry a "renderIfSpan": <bare selector> guard ("root" / { "type": "<SPAN_TYPE>", "nth"?: n } / { "name": "<span name>" }). The host OMITS that component AND its entire subtree when the selector matches no span in the current trace. ALWAYS put a "renderIfSpan" on each per-span card (e.g. the nth tool-call card) so a fixed N-card layout collapses to only the cards whose span exists — otherwise the extra card renders an empty/"null" output with dangling feedback. Use the SAME selector as the card's spanField/$spanRef. (Like spanField's "spanRef", this is a BARE selector — do not wrap it in "$spanRef".)

Rules:
- Do NOT inline literal trace data anywhere a marker belongs. A StatCard value is { "$source": "metrics.latency" }, NOT "1.20s". A DataTable "rows" is { "$source": "toolRows" }, NOT a literal array of rows. A specific span's output in a KeyValueViewer is a "spanField" marker, NOT pasted JSON. A span id/name caption is a "spanField" marker, NOT a literal id copied from the traceSample.
- Only these source names exist. If the user asks for data with no matching source, either bind a "spanField" (for one span's input/output/attributes/name/id), show it via a TreeView spanTree panel item, or state it is unavailable — do NOT invent a source name.
- Static layout text (titles, labels, column headers, option labels, icons, tones, feedback "name"s) stays a plain literal — it is the SAME for every trace.`;

export const LAYOUT_GUIDANCE = `Layout & visual polish (make views look designed, not flat):
1. Give structure with Cards. Group each logical section (a span, a response, a feedback block) into its own "Card". A Card holds ONE child, so put a "Column" inside it.
2. Title every Card. Make the FIRST child of a Card's Column a heading — a "Text" with "variant": "h3" or "h4" (or "h5" for sub-sections). Don't leave a bare body-text line acting as the title.
3. Demote metadata to captions. Render span ids, durations, timestamps, and other secondary details as a "Text" with "variant": "caption" (small + muted), e.g. { "text": "span: <id>", "variant": "caption" } — not as plain body text.
4. Use tiles for metrics. For single numbers/statuses (latency, tokens, status, counts) prefer "StatCard"s in a "Row" with "align": "stretch" rather than text lines.
5. Lay out intentionally and keep columns EVEN. Put side-by-side cards in a "Row" with "align": "stretch" AND give every card in that Row the SAME "weight" (e.g. "weight": 1) so they share the width equally and match heights — without equal "weight" the cards shrink to their content and look uneven. Use a "Column" for stacked sections. When you render one card PER repeated item (e.g. one Card per tool call), lay them out with a CONSISTENT number of equal-weight cards per Row (e.g. 2 per Row). If the items don't divide evenly and the final Row is left with a SINGLE card, let that card span the FULL width — put it alone in a "Row" with "weight": 1 (or place it directly in the parent "Column") so it covers the whole row instead of sitting half-width next to empty space. Do NOT add empty spacer columns.
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
8. DATA props are binding MARKERS, never literal trace data (see "Data binding"). An array-valued data prop (a DataTable/TimelineChart "rows") is an { "$source": "<array source>" } marker; a "children" prop that shows trace data (TreeView, AssessmentBoard) is an { "$source": "spanTree"|"assessments", ... } marker; a scalar data prop (StatCard "value") is an { "$source": "<scalar source>" } marker. Layout-only arrays ("columns", a Row/Column "children" listing your OWN component ids, "options") stay literal.
9. SCALAR data props are { "$source": "metrics.*" } markers — do NOT inline a literal like "1.83s" copied from the traceSample. The traceSample shows example shapes only; its concrete values belong to one trace and must NOT appear in your spec.
10. A feedback control's "spanId" (when span-scoped) is a { "$spanRef": ... } marker so it targets the equivalent span in every trace. Its "name" is a STATIC string naming the assessment dimension — never a span id or an authoring-trace span name.
11. Trace-specific narrative is FORBIDDEN. Do NOT write prose that describes what a specific trace did, and do NOT emit "#span:" deeplinks — the saved view is reused across many traces, so such text would be wrong for every other trace. Markdown is for STATIC instructions/headings only.
12. Only use the component types, props, source names, and spanRef selectors listed above. Do not invent components, props, icon names, enum values, or source names.
13. CRITICAL — never fabricate data. The only trace data that appears is what the bound sources resolve to; do NOT invent metrics, scores, counts, failure patterns, or recommendations. This is ONE single trace, so never reference cross-trace aggregates. The ONLY judge/evaluation results are the "assessments" source; "metrics.assessments" is merely their COUNT.
14. If the user asks for data that has no matching source, do NOT make one up. Bind a "spanField" marker (for one span's input/output/attributes/name/id), show it via a TreeView spanTree panel item, or render a single short static message stating it is unavailable (e.g. a "Text" with "text": "Not available in this view."). It is better to say the data is unavailable than to fabricate or hardcode values.
15. NEVER paste a specific span's input/output JSON as a literal "value", and NEVER copy a span id/name from the traceSample into "text", a "spanId", or a feedback "name". Per-span data and ids are ALWAYS "spanField"/"$spanRef" markers so they re-resolve for every trace; a literal would freeze the view to the authoring trace.`;

export const EXAMPLE = `Example — a tool performance table plus a metrics row. Note: the StatCard "value"s and the DataTable "rows" are binding MARKERS (no literal trace data); only the layout, titles, and columns are literal (and note the { "title", "messages" } wrapper):
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
          { "id": "stat-latency", "component": "StatCard", "value": { "$source": "metrics.latency" }, "label": "Latency", "icon": "clock", "tone": "warning" },
          { "id": "stat-tokens", "component": "StatCard", "value": { "$source": "metrics.totalTokens" }, "label": "Total Tokens", "icon": "hash", "tone": "info" },
          {
            "id": "tools",
            "component": "DataTable",
            "title": "Tool Performance",
            "icon": "wrench",
            "columns": [
              { "label": "Tool", "align": "left" },
              { "label": "Calls", "align": "center" },
              { "label": "Success", "align": "center" },
              { "label": "Latency (AVG)", "align": "center" }
            ],
            "rows": { "$source": "toolRows" },
            "emptyMessage": "No tool calls in this trace."
          }
        ]
      }
    }
  ]
}
\`\`\``;

export const TREE_EXAMPLE = `Example — a span tree. Bind the TreeView's "children" to the "spanTree" source; the host builds one TreeNode per span in the CURRENT trace (with the right label/icon/hierarchy). Do NOT hand-author TreeNode components:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "TreeView", "title": "Span Tree", "children": { "$source": "spanTree" }, "emptyMessage": "No spans." }
      ]
    }
  }
]
\`\`\`

To show a span's INPUT and OUTPUT (or attributes), add "panelItems" to the spanTree marker; the host attaches them to every node and builds the side panel from each span's real data on selection (no spanId needed — the host scopes to the selected node's span). Example — input/output for every span:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "TreeView", "title": "Span Tree", "children": { "$source": "spanTree", "panelItems": [ { "type": "input" }, { "type": "output" } ] } }
      ]
    }
  }
]
\`\`\`
This stays tiny no matter how large or how many spans the trace has, because the host fills in the data per trace. Add { "type": "feedback", "name": "Helpful" } to collect a thumbs up/down per span (the "name" is static; the host scopes it to the selected span). Use "filterType" (e.g. { "$source": "spanTree", "filterType": "TOOL", "panelItems": [ { "type": "input" }, { "type": "output" } ] }) to show only tool spans as a flat list.`;

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

export const CARD_STYLE_EXAMPLE = `Example — a DECORATED card (apply this styling pattern to every card: titled heading, caption, bound content, then inputs). Here a summary card shows bound metrics and a completeness rating scoped to the root span via a "$spanRef" marker (note the STATIC, role-qualified "name" and that there is NO literal span id or per-trace value):
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["summary-card", "submit"] },
        { "id": "summary-card", "component": "Card", "child": "summary-col" },
        { "id": "summary-col", "component": "Column", "children": ["summary-title", "summary-caption", "metrics-row", "rating", "rating-why"] },
        { "id": "summary-title", "component": "Text", "text": "Trace summary", "variant": "h4" },
        { "id": "summary-caption", "component": "Text", "text": "Status and latency for this trace", "variant": "caption" },
        { "id": "metrics-row", "component": "Row", "align": "stretch", "children": ["stat-status", "stat-latency"] },
        { "id": "stat-status", "component": "StatCard", "value": { "$source": "metrics.status" }, "label": "Status", "icon": "checkCircle", "tone": "success", "weight": 1 },
        { "id": "stat-latency", "component": "StatCard", "value": { "$source": "metrics.latency" }, "label": "Latency", "icon": "clock", "tone": "info", "weight": 1 },
        { "id": "rating", "component": "RadioGroup", "label": "How complete is the agent's answer?", "name": "Completeness — root span", "spanId": { "$spanRef": "root" }, "options": [ { "label": "Complete", "value": "Complete" }, { "label": "Mostly complete", "value": "Mostly complete" }, { "label": "Incomplete", "value": "Incomplete" } ] },
        { "id": "rating-why", "component": "FeedbackInputText", "label": "Optional rationale", "name": "Completeness — root span", "field": "rationale", "placeholder": "Briefly explain (optional)" },
        { "id": "submit", "component": "FeedbackSubmit", "label": "Submit feedback" }
      ]
    }
  }
]
\`\`\`
Note the heading ("variant":"h4") as the card title, the caption line, the bound StatCard "value"s, and the rating whose "name" is the static dimension ("Completeness — root span") with a "$spanRef" marker for the span — never a literal span id. To rate a specific span TYPE instead, use "spanId": { "$spanRef": { "type": "LLM", "nth": 0 } } and name it "Completeness — LLM span".`;

export const SPAN_CARD_EXAMPLE = `Example — per-span cards that rate the OUTPUT of specific tool calls (the "rate the first N tool calls side by side" pattern). The key idea: select each span by ROLE with "spanRef": { "type": "TOOL", "nth": <n> } (NOT by a baked span id/name), bind its caption and output to "spanField" markers, and scope its ratings with the SAME selector via "$spanRef". The card COUNT is fixed by the layout you author (here 2). To avoid a phantom empty card on a trace with FEWER tool calls, put a "renderIfSpan": <bare selector> guard on EACH per-span card (matching that card's span): the host OMITS the card and everything inside it when that span is absent in the current trace — so a 1-tool trace shows just one card, with NO null output and NO dangling feedback. Ratings use the SAME static "name" across both cards — qualify by ROLE/index (e.g. "Accuracy — tool #1"), never by a span id:
\`\`\`json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "${PLACEHOLDER_SURFACE_ID}",
      "components": [
        { "id": "root", "component": "Column", "children": ["header", "cards", "submit"] },

        { "id": "header", "component": "Card", "child": "header-col" },
        { "id": "header-col", "component": "Column", "children": ["header-title", "header-prompt"] },
        { "id": "header-title", "component": "Text", "text": "User prompt", "variant": "h3" },
        { "id": "header-prompt", "component": "KeyValueViewer", "label": "Question", "value": { "$source": "spanField", "spanRef": "root", "field": "inputs" }, "initialFormat": "json" },

        { "id": "cards", "component": "Row", "align": "stretch", "children": ["card-0", "card-1"] },

        { "id": "card-0", "component": "Card", "child": "col-0", "weight": 1, "renderIfSpan": { "type": "TOOL", "nth": 0 } },
        { "id": "col-0", "component": "Column", "children": ["name-0", "id-0", "out-0", "acc-0", "acc-0-why"] },
        { "id": "name-0", "component": "Text", "text": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "name" }, "variant": "h4" },
        { "id": "id-0", "component": "Text", "text": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "spanId" }, "variant": "caption" },
        { "id": "out-0", "component": "KeyValueViewer", "label": "Output", "value": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 0 }, "field": "outputs" }, "initialFormat": "json" },
        { "id": "acc-0", "component": "RadioGroup", "label": "How accurate is the output?", "name": "Accuracy — tool #1", "spanId": { "$spanRef": { "type": "TOOL", "nth": 0 } }, "options": [ { "label": "Mostly accurate", "value": "Mostly accurate" }, { "label": "Less accurate", "value": "Less accurate" }, { "label": "Not accurate", "value": "Not accurate" } ] },
        { "id": "acc-0-why", "component": "FeedbackInputText", "label": "Optional rationale (why?)", "name": "Accuracy — tool #1", "field": "rationale", "spanId": { "$spanRef": { "type": "TOOL", "nth": 0 } } },

        { "id": "card-1", "component": "Card", "child": "col-1", "weight": 1, "renderIfSpan": { "type": "TOOL", "nth": 1 } },
        { "id": "col-1", "component": "Column", "children": ["name-1", "id-1", "out-1", "acc-1", "acc-1-why"] },
        { "id": "name-1", "component": "Text", "text": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 1 }, "field": "name" }, "variant": "h4" },
        { "id": "id-1", "component": "Text", "text": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 1 }, "field": "spanId" }, "variant": "caption" },
        { "id": "out-1", "component": "KeyValueViewer", "label": "Output", "value": { "$source": "spanField", "spanRef": { "type": "TOOL", "nth": 1 }, "field": "outputs" }, "initialFormat": "json" },
        { "id": "acc-1", "component": "RadioGroup", "label": "How accurate is the output?", "name": "Accuracy — tool #2", "spanId": { "$spanRef": { "type": "TOOL", "nth": 1 } }, "options": [ { "label": "Mostly accurate", "value": "Mostly accurate" }, { "label": "Less accurate", "value": "Less accurate" }, { "label": "Not accurate", "value": "Not accurate" } ] },
        { "id": "acc-1-why", "component": "FeedbackInputText", "label": "Optional rationale (why?)", "name": "Accuracy — tool #2", "field": "rationale", "spanId": { "$spanRef": { "type": "TOOL", "nth": 1 } } },

        { "id": "submit", "component": "FeedbackSubmit", "label": "Submit feedback" }
      ]
    }
  }
]
\`\`\``;

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
    'The user is viewing the "Custom View" tab of the MLflow trace explorer and wants you to BUILD or MODIFY an A2UI view ("custom view"). You author a REUSABLE, TRACE-AGNOSTIC TEMPLATE exactly ONCE: the host saves it and re-binds it to every trace the user cycles through WITHOUT calling you again. So you must NOT bake in the current trace\'s data. The "traceSample" in the context shows only the SHAPE of the data (so you can pick sensible sources and layout); never copy its concrete span ids, values, rows, or counts into the spec. Every data-bearing prop must be a binding MARKER (see the Data binding rules) that the host resolves per trace.',
    `When (and only when) the user asks you to build, change, or update the custom view, reply with a single JSON object { "title": <short 2-5 word view name>, "messages": [ <the FULL A2UI message stream> ] } wrapped in a fenced code block tagged exactly \`${CUSTOM_VIEW_SPEC_FENCE}\` (NOT \`json\`). The "title" names the VIEW (e.g. "Trace Summary", "Span Cards") — not the user's raw words. The host detects that fenced block and applies it to the view automatically. You may add a brief sentence of prose before the block, but the block must contain ONLY that JSON object. If the user is just asking a question (not requesting a view change), answer normally without the fenced block.`,
    'Always return the COMPLETE spec for the single view (not a diff). When a "currentTemplate" is provided in the context, it is the existing reusable template (with its binding markers): KEEP its layout, component choices, and markers, and apply ONLY the change the user asked for. Do NOT replace markers with literal data and do NOT introduce trace-specific values. Re-pick the "title" whenever an edit changes what the view shows; keep the previous title for purely cosmetic edits (colors, spacing, minor wording).',
  ].join('\n');

  const fenceRule = `OUTPUT FENCE OVERRIDE: The rules above say to wrap the JSON in a \`json\` fence — for this custom-view surface, IGNORE that and wrap your final { "title", "messages" } object in a \`${CUSTOM_VIEW_SPEC_FENCE}\` fence instead. The example blocks below use a generic fence only for illustration of the JSON content; your actual reply MUST use the \`${CUSTOM_VIEW_SPEC_FENCE}\` fence.`;

  return [
    intro,
    CATALOG_REFERENCE,
    BINDING_REFERENCE,
    LAYOUT_GUIDANCE,
    OUTPUT_RULES,
    fenceRule,
    EXAMPLE,
    TREE_EXAMPLE,
    CARD_STYLE_EXAMPLE,
    SPAN_CARD_EXAMPLE,
    FEEDBACK_EXAMPLE,
  ].join('\n\n');
};
