import type { ZodTypeAny } from 'zod';
import {
  type A2uiMessage,
  CreateSurfaceMessageSchema,
  UpdateComponentsMessageSchema,
  UpdateDataModelMessageSchema,
} from '@a2ui/web_core/v0_9';

import { AssessmentBoardApi } from '../catalog-primitives/AssessmentBoard';
import { AssessmentCardApi } from '../catalog-primitives/AssessmentCard';
import { CardApi } from '../catalog-primitives/Card';
import { DataTableApi } from '../catalog-primitives/DataTable';
import { FeedbackInputTextApi } from '../catalog-primitives/FeedbackInputText';
import { FeedbackSubmitApi } from '../catalog-primitives/FeedbackSubmit';
import { FeedbackThumbsUpDownButtonsApi } from '../catalog-primitives/FeedbackThumbsUpDownButtons';
import { IconApi } from '../catalog-primitives/Icon';
import { KeyValueViewerApi } from '../catalog-primitives/KeyValueViewer';
import { MarkdownApi } from '../catalog-primitives/Markdown';
import { MediaRendererApi } from '../catalog-primitives/MediaRenderer';
import { RadioGroupApi } from '../catalog-primitives/RadioGroup';
import { StatCardApi } from '../catalog-primitives/StatCard';
import { TimelineChartApi } from '../catalog-primitives/TimelineChart';
import { TreeNodeApi } from '../catalog-primitives/TreeNode';
import { TreeViewApi } from '../catalog-primitives/TreeView';
import {
  SPAN_FIELD_SOURCE_NAME,
  isKnownSource,
  isSourceMarker,
  isSpanRefMarker,
  isValidSpanFieldMarker,
  isValidSpanRefSelector,
  unwrapSpanRefSelector,
} from '../customViewSources';

// Per-component prop schemas for the custom catalog components. The basic
// catalog components (Text/Row/Column) are intentionally absent: they're
// validated by the renderer at bind time, and we let them pass through here so
// the LLM can still lay out content with rows/columns.
const COMPONENT_SCHEMAS: Record<string, ZodTypeAny> = {
  [StatCardApi.name]: StatCardApi.schema,
  [IconApi.name]: IconApi.schema,
  [MediaRendererApi.name]: MediaRendererApi.schema,
  [CardApi.name]: CardApi.schema,
  [DataTableApi.name]: DataTableApi.schema,
  [TimelineChartApi.name]: TimelineChartApi.schema,
  [TreeViewApi.name]: TreeViewApi.schema,
  [TreeNodeApi.name]: TreeNodeApi.schema,
  [MarkdownApi.name]: MarkdownApi.schema,
  [AssessmentBoardApi.name]: AssessmentBoardApi.schema,
  [AssessmentCardApi.name]: AssessmentCardApi.schema,
  [KeyValueViewerApi.name]: KeyValueViewerApi.schema,
  [FeedbackThumbsUpDownButtonsApi.name]: FeedbackThumbsUpDownButtonsApi.schema,
  [RadioGroupApi.name]: RadioGroupApi.schema,
  [FeedbackInputTextApi.name]: FeedbackInputTextApi.schema,
  [FeedbackSubmitApi.name]: FeedbackSubmitApi.schema,
};

export type ValidateResult =
  | { ok: true; messages: A2uiMessage[] }
  | { ok: false; error: string };

type RawMessage = Record<string, unknown>;

// Pulls a message array out of whatever JSON the model returned. We accept the
// canonical encodings: a bare array of messages, a `{ messages: [...] }`
// wrapper, or a single message object.
const toMessageArray = (raw: unknown): RawMessage[] | undefined => {
  if (Array.isArray(raw)) {
    return raw as RawMessage[];
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return obj.messages as RawMessage[];
    }
    // A single message object (has one of the known top-level keys).
    if ('createSurface' in obj || 'updateComponents' in obj || 'updateDataModel' in obj) {
      return [obj as RawMessage];
    }
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Models occasionally emit a component as `{ id, component, props: { ... } }`
// (React-style) instead of our flat shape where every prop sits directly on the
// object alongside `id`/`component`. Hoist a nested `props` object up so both the
// strict per-component schema and the renderer (which consume the flat shape)
// see the real props. Existing top-level keys win over the nested ones.
const flattenComponentProps = (component: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(component.props)) {
    return component;
  }
  const { props, ...rest } = component;
  return { ...(props as Record<string, unknown>), ...rest };
};

// Validates the props of a single component against the custom catalog schema.
// `id` and `component` are stripped first since the per-component schemas (like
// the renderer) only describe the component's own props. Templates carry concrete
// trace data (they are generated fresh per trace), so every prop is validated
// strictly against its schema.
const validateComponentProps = (component: Record<string, unknown>): string | undefined => {
  const componentName = component.component;
  if (typeof componentName !== 'string') {
    return 'A component is missing its string "component" type.';
  }
  if (component.id === undefined || component.id === null || component.id === '') {
    return `Component "${componentName}" is missing a non-empty "id".`;
  }
  const { id: _id, component: _component, ...props } = component;

  const schema = COMPONENT_SCHEMAS[componentName];
  if (!schema) {
    // Basic catalog component (Text/Row/Column) or unknown — let it pass; the
    // renderer/binder is the source of truth for these.
    return undefined;
  }
  const result = schema.safeParse(props);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return `Component "${String(component.id)}" (${componentName}) has invalid props: ${detail}`;
  }
  return undefined;
};

/**
 * Validates and normalizes an LLM-generated A2UI message stream so it can be
 * safely handed to `MessageProcessor.processMessages` (which does NOT validate
 * against the catalog). We:
 *
 *  - extract the message array from the model's JSON (array / wrapper / single),
 *  - drop any `createSurface` / `deleteSurface` the model emitted and inject our
 *    own `createSurface` so the surface id + catalog id are host-controlled
 *    (the model shouldn't pick surface ids or delete surfaces),
 *  - rewrite the `surfaceId` on every kept message to the target surface,
 *  - validate each message envelope (Zod) and each custom component's props,
 *  - require at least one `updateComponents` containing a `root` component.
 */
export const validateAndPrepareMessages = (
  raw: unknown,
  { surfaceId, catalogId }: { surfaceId: string; catalogId: string },
): ValidateResult => {
  const rawMessages = toMessageArray(raw);
  if (!rawMessages || rawMessages.length === 0) {
    return { ok: false, error: 'The model did not return any A2UI messages.' };
  }

  const kept: A2uiMessage[] = [
    {
      version: 'v0.9',
      createSurface: { surfaceId, catalogId, sendDataModel: true },
    },
  ];

  let sawRoot = false;

  for (const message of rawMessages) {
    if (!isRecord(message)) {
      return { ok: false, error: 'Encountered a message that is not a JSON object.' };
    }
    // The model controls surface lifecycle for itself; we own it. Skip its
    // createSurface/deleteSurface entirely.
    if ('createSurface' in message || 'deleteSurface' in message) {
      continue;
    }

    if ('updateComponents' in message) {
      let payload: Record<string, unknown> | undefined = isRecord(message.updateComponents)
        ? { ...message.updateComponents, surfaceId }
        : undefined;
      // Flatten any nested `props` objects so validation and rendering both see
      // the flat shape we expect.
      if (payload && Array.isArray(payload.components)) {
        payload = {
          ...payload,
          components: payload.components.map((component: unknown) =>
            isRecord(component) ? flattenComponentProps(component) : component,
          ),
        };
      }
      const normalized = { version: 'v0.9', updateComponents: payload };
      const parsed = UpdateComponentsMessageSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Invalid updateComponents message: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      const components = ((payload as Record<string, unknown> | undefined)?.components ?? []) as Record<
        string,
        unknown
      >[];
      for (const component of components) {
        if (!isRecord(component)) {
          return { ok: false, error: 'A component entry is not a JSON object.' };
        }
        if (component.id === 'root') {
          sawRoot = true;
        }
        const componentError = validateComponentProps(component);
        if (componentError) {
          return { ok: false, error: componentError };
        }
      }
      kept.push(parsed.data);
      continue;
    }

    if ('updateDataModel' in message) {
      const payload = isRecord(message.updateDataModel) ? { ...message.updateDataModel, surfaceId } : undefined;
      const normalized = { version: 'v0.9', updateDataModel: payload };
      const parsed = UpdateDataModelMessageSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Invalid updateDataModel message: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      kept.push(parsed.data);
      continue;
    }

    // Unknown / unsupported message shape — ignore it rather than fail the whole
    // generation, since the processor would reject it anyway.
  }

  // Sanity-check our own injected createSurface against the schema too.
  const surfaceCheck = CreateSurfaceMessageSchema.safeParse(kept[0]);
  if (!surfaceCheck.success) {
    return { ok: false, error: 'Failed to construct a valid createSurface message.' };
  }

  if (!sawRoot) {
    return { ok: false, error: 'The generated UI has no "root" component to render.' };
  }

  return { ok: true, messages: kept };
};

// Placeholder surface id stamped on a stored template. The real, host-owned
// surface id is injected later by `validateAndPrepareMessages` when the resolved
// per-trace messages are prepared, so the template's value is never rendered.
const TEMPLATE_SURFACE_ID = 'main';

// Validates the binding markers + narrative rules for a single template
// component. Unlike `validateComponentProps`, this does NOT strict-check props
// against the catalog schema, because data-bearing props hold `$source` /
// `$spanRef` markers at template time; strict validation happens on the resolved
// per-trace output. Returns an error string, or undefined when the component is
// a valid template component.
const validateTemplateComponent = (component: Record<string, unknown>): string | undefined => {
  const componentName = typeof component.component === 'string' ? component.component : '(unknown)';
  const id = component.id === undefined ? '(no id)' : String(component.id);

  // A `renderIfSpan` guard must be a valid bare spanRef selector (the wrapped
  // { "$spanRef": ... } form is tolerated). Catch a malformed guard here so it
  // doesn't silently fail to prune at render time.
  if ('renderIfSpan' in component && !isValidSpanRefSelector(unwrapSpanRefSelector(component.renderIfSpan))) {
    return (
      `Component "${id}" (${componentName}) has an invalid "renderIfSpan" guard. Use a spanRef selector: ` +
      `"root", { "type": "<SPAN_TYPE>", "nth"?: n }, or { "name": "<span name>" }.`
    );
  }

  let error: string | undefined;

  const walk = (value: unknown) => {
    if (error) {
      return;
    }
    if (isSourceMarker(value)) {
      if (!isKnownSource(value.$source)) {
        error = `Component "${id}" (${componentName}) references unknown $source "${value.$source}".`;
        return;
      }
      if (value.$source === SPAN_FIELD_SOURCE_NAME && !isValidSpanFieldMarker(value)) {
        error =
          `Component "${id}" (${componentName}) has an invalid spanField marker. Provide a valid "spanRef" ` +
          `("root" / { "type": "<SPAN_TYPE>", "nth"?: n } / { "name": "<span name>" }) and a "field" of ` +
          `inputs|outputs|attributes|name|spanId.`;
        return;
      }
      // Fall through to recurse into the marker's other fields (e.g. spanTree's
      // panelItems) so narrative rules apply to nested markdown too.
    } else if (isSpanRefMarker(value)) {
      if (!isValidSpanRefSelector(value.$spanRef)) {
        error =
          `Component "${id}" (${componentName}) has an invalid $spanRef selector. Use "root", ` +
          `{ "type": "<SPAN_TYPE>", "nth"?: n }, or { "name": "<span name>" }.`;
      }
      return;
    }
    if (typeof value === 'string') {
      // Trace-specific narrative is forbidden in a reusable view: a baked
      // `#span:<id>` deeplink points at a span that only exists in the authoring
      // trace, so it breaks on every other trace.
      if (value.includes('#span:')) {
        error =
          `Component "${id}" (${componentName}) contains a "#span:" deeplink. Reusable views cannot embed ` +
          `trace-specific narrative; drive span selection from TreeView panel items instead.`;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (isRecord(value)) {
      Object.values(value).forEach(walk);
    }
  };

  walk(component);
  return error;
};

export type TemplateValidateResult =
  | { ok: true; messages: A2uiMessage[] }
  | { ok: false; error: string };

/**
 * Validates a trace-agnostic custom view TEMPLATE (authored once by the LLM with
 * `$source` / `$spanRef` markers). Unlike `validateAndPrepareMessages`, this is
 * marker-aware and lenient on data props: it
 *
 *  - extracts the message array and drops any createSurface/deleteSurface,
 *  - normalizes the surface id to a placeholder + flattens nested props,
 *  - validates each envelope (Zod) and each marker (known source name / valid
 *    spanRef selector) and rejects forbidden trace-specific narrative,
 *  - requires a `root` component,
 *
 * returning the marker-preserving template to persist. Per-trace rendering then
 * runs `resolveTemplate` (to swap markers for this trace's data) followed by
 * `validateAndPrepareMessages` (to strict-validate the resolved components).
 */
export const validateTemplate = (raw: unknown): TemplateValidateResult => {
  const rawMessages = toMessageArray(raw);
  if (!rawMessages || rawMessages.length === 0) {
    return { ok: false, error: 'The model did not return any A2UI messages.' };
  }

  const kept: A2uiMessage[] = [];
  let sawRoot = false;

  for (const message of rawMessages) {
    if (!isRecord(message)) {
      return { ok: false, error: 'Encountered a message that is not a JSON object.' };
    }
    if ('createSurface' in message || 'deleteSurface' in message) {
      continue;
    }

    if ('updateComponents' in message) {
      let payload: Record<string, unknown> | undefined = isRecord(message.updateComponents)
        ? { ...message.updateComponents, surfaceId: TEMPLATE_SURFACE_ID }
        : undefined;
      if (payload && Array.isArray(payload.components)) {
        payload = {
          ...payload,
          components: payload.components.map((component: unknown) =>
            isRecord(component) ? flattenComponentProps(component) : component,
          ),
        };
      }
      const normalized = { version: 'v0.9', updateComponents: payload };
      const parsed = UpdateComponentsMessageSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Invalid updateComponents message: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      const components = ((payload as Record<string, unknown> | undefined)?.components ?? []) as Record<
        string,
        unknown
      >[];
      for (const component of components) {
        if (!isRecord(component)) {
          return { ok: false, error: 'A component entry is not a JSON object.' };
        }
        if (component.id === 'root') {
          sawRoot = true;
        }
        const componentError = validateTemplateComponent(component);
        if (componentError) {
          return { ok: false, error: componentError };
        }
      }
      kept.push(parsed.data);
      continue;
    }

    if ('updateDataModel' in message) {
      const payload = isRecord(message.updateDataModel)
        ? { ...message.updateDataModel, surfaceId: TEMPLATE_SURFACE_ID }
        : undefined;
      const normalized = { version: 'v0.9', updateDataModel: payload };
      const parsed = UpdateDataModelMessageSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Invalid updateDataModel message: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      }
      kept.push(parsed.data);
      continue;
    }
  }

  if (!sawRoot) {
    return { ok: false, error: 'The generated UI has no "root" component to render.' };
  }

  return { ok: true, messages: kept };
};
