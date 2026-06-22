import { useState } from 'react';

import { z } from 'zod';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { type ComponentApi, DynamicStringSchema } from '@a2ui/web_core/v0_9';
import { Input, Typography, useDesignSystemTheme } from '@databricks/design-system';

import { FEEDBACK_STAGED } from './feedbackActions';

const FIELDS = ['value', 'rationale'] as const;
type FieldTarget = (typeof FIELDS)[number];

/**
 * Schema (API) for the FeedbackInputText primitive: a feedback-scoped free-text
 * box (NOT a generic input). Its text is staged host-side under `name` and only
 * persisted on FeedbackSubmit. `field` controls which part of the assessment
 * the text populates:
 *  - "rationale" (default): pair it with a RadioGroup sharing the same `name`
 *    to capture an optional "why" for that dimension.
 *  - "value": use standalone as a free-text feedback value (no radio needed).
 */
export const FeedbackInputTextApi = {
  name: 'FeedbackInputText',
  schema: z
    .object({
      label: DynamicStringSchema.describe('Optional prompt shown above the box, e.g. "Optional rationale (why?)".').optional(),
      name: DynamicStringSchema.describe(
        'The assessment name this text logs (also the staging key). Match a RadioGroup\'s name to attach as that dimension\'s rationale; use a unique name for a standalone free-text feedback value.',
      ),
      field: z
        .enum(FIELDS)
        .describe('Whether the typed text becomes the assessment "value" or its "rationale". Defaults to "rationale".')
        .default('rationale')
        .optional(),
      placeholder: DynamicStringSchema.describe('Placeholder text shown when the box is empty.').optional(),
      value: DynamicStringSchema.describe('Bind to a /feedback/... path to reflect and seed the text.').optional(),
      spanId: DynamicStringSchema.describe(
        'Optional span id to scope the feedback to a specific span instead of the whole trace.',
      ).optional(),
      weight: z.number().describe('Relative flex weight when placed directly inside a Row/Column.').optional(),
    })
    .strict(),
} satisfies ComponentApi;

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

export const FeedbackInputText = createComponentImplementation(FeedbackInputTextApi, ({ props, context }) => {
  const { theme } = useDesignSystemTheme();

  const initial = typeof props.value === 'string' ? props.value : '';
  const [text, setText] = useState<string>(initial);

  const label = props.label ? asString(props.label) : '';
  const name = props.name ? asString(props.name) : '';
  const placeholder = props.placeholder ? asString(props.placeholder) : undefined;
  const field: FieldTarget = props.field === 'value' ? 'value' : 'rationale';
  const weight = typeof props.weight === 'number' ? props.weight : undefined;

  // Stage on blur (a click on FeedbackSubmit blurs this box first, so the latest
  // text is buffered before submit). Keystrokes only update local state to avoid
  // dispatching an action per character.
  const stage = (next: string) => {
    props.setValue(next);
    void context.dispatchAction({
      event: {
        name: FEEDBACK_STAGED,
        context: {
          name,
          ...(field === 'value' ? { value: next } : { rationale: next }),
          ...(typeof props.spanId === 'string' && props.spanId ? { spanId: props.spanId } : {}),
        },
      },
    });
  };

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.xs,
        ...(weight !== undefined ? { flex: `${weight}`, minWidth: 0 } : {}),
      }}
    >
      {label && <Typography.Text color="secondary">{label}</Typography.Text>}
      <Input.TextArea
        componentId="shared.model-trace-explorer.custom-view.feedback-input-text"
        placeholder={placeholder}
        value={text}
        autoSize={{ minRows: 2, maxRows: 6 }}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => stage(event.target.value)}
      />
    </div>
  );
});
