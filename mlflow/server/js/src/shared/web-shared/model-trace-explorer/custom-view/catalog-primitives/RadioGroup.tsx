import { useState } from 'react';

import { z } from 'zod';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { type ComponentApi, DynamicStringSchema } from '@a2ui/web_core/v0_9';
import { Radio, Typography, useDesignSystemTheme } from '@databricks/design-system';

import { FEEDBACK_STAGED } from './feedbackActions';

/**
 * Schema (API) for the interactive RadioGroup feedback primitive: a single
 * choice among a fixed set of string options (e.g. "Response A" / "Response B"
 * / "Tie"). Selecting an option reflects the choice in the data model (via the
 * bound `value` path) AND stages it host-side under `name`; it is persisted as
 * an MLflow feedback assessment only when a FeedbackSubmit button is clicked.
 */
export const RadioGroupApi = {
  name: 'RadioGroup',
  schema: z
    .object({
      label: DynamicStringSchema.describe('Optional prompt shown above the options, e.g. "Who did better on Accuracy?".').optional(),
      name: DynamicStringSchema.describe(
        'The assessment name this dimension logs (also the staging key). Required, and must be unique per dimension; a FeedbackInputText sharing this name attaches as its rationale.',
      ),
      options: z
        .array(
          z.object({
            label: DynamicStringSchema.describe('The option text shown to the user.'),
            value: z.string().describe('The feedback value logged when this option is selected.'),
          }),
        )
        .describe('The selectable options, in display order.'),
      value: DynamicStringSchema.describe(
        'Selected option value. Bind to a /feedback/... path to reflect and seed the choice.',
      ).optional(),
      spanId: DynamicStringSchema.describe(
        'Optional span id to scope the feedback to a specific span instead of the whole trace.',
      ).optional(),
      weight: z.number().describe('Relative flex weight when placed directly inside a Row/Column.').optional(),
    })
    .strict(),
} satisfies ComponentApi;

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

export const RadioGroup = createComponentImplementation(RadioGroupApi, ({ props, context }) => {
  const { theme } = useDesignSystemTheme();

  const initial = typeof props.value === 'string' ? props.value : undefined;
  const [selected, setSelected] = useState<string | undefined>(initial);

  const label = props.label ? asString(props.label) : '';
  const name = props.name ? asString(props.name) : '';
  const options = Array.isArray(props.options) ? props.options : [];
  const weight = typeof props.weight === 'number' ? props.weight : undefined;

  const select = (value: string) => {
    setSelected(value);
    // Reflect the choice in the data model (no-op if `value` isn't bound).
    props.setValue(value);
    // Stage the choice host-side; it is persisted only on FeedbackSubmit.
    void context.dispatchAction({
      event: {
        name: FEEDBACK_STAGED,
        context: {
          name,
          value,
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
      <Radio.Group
        name={name || 'mlflow.custom-view.radio-group'}
        componentId="shared.model-trace-explorer.custom-view.radio-group"
        value={selected}
        onChange={(event) => select(asString(event.target.value))}
      >
        {options.map((option, index) => {
          const optionValue = asString(option?.value);
          return (
            <Radio key={`${optionValue}-${index}`} value={optionValue}>
              {asString(option?.label) || optionValue}
            </Radio>
          );
        })}
      </Radio.Group>
    </div>
  );
});
