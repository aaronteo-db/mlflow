import { useState } from 'react';

import { z } from 'zod';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { type ComponentApi, DynamicStringSchema } from '@a2ui/web_core/v0_9';
import { Button, CheckIcon, useDesignSystemTheme } from '@databricks/design-system';

import { FEEDBACK_SUBMIT_ALL } from './feedbackActions';

/**
 * Schema (API) for the FeedbackSubmit primitive: a button that flushes all
 * staged feedback (from RadioGroup / FeedbackInputText) on this surface. The
 * host logs one MLflow assessment per staged dimension and clears the buffer.
 * Emit exactly one per view when collecting multi-dimension feedback.
 */
export const FeedbackSubmitApi = {
  name: 'FeedbackSubmit',
  schema: z
    .object({
      label: DynamicStringSchema.describe('Button text. Defaults to "Submit feedback".').optional(),
      weight: z.number().describe('Relative flex weight when placed directly inside a Row/Column.').optional(),
    })
    .strict(),
} satisfies ComponentApi;

const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));

export const FeedbackSubmit = createComponentImplementation(FeedbackSubmitApi, ({ props, context }) => {
  const { theme } = useDesignSystemTheme();

  const [submitted, setSubmitted] = useState(false);

  const label = props.label ? asString(props.label) : 'Submit feedback';
  const weight = typeof props.weight === 'number' ? props.weight : undefined;

  const submit = () => {
    void context.dispatchAction({ event: { name: FEEDBACK_SUBMIT_ALL, context: {} } });
    setSubmitted(true);
    // Briefly confirm, then return the button to its normal state so further
    // edits can be resubmitted.
    window.setTimeout(() => setSubmitted(false), 2000);
  };

  return (
    <div css={{ ...(weight !== undefined ? { flex: `${weight}`, minWidth: 0 } : {}), marginTop: theme.spacing.xs }}>
      <Button
        componentId="shared.model-trace-explorer.custom-view.feedback-submit"
        type="primary"
        icon={submitted ? <CheckIcon /> : undefined}
        onClick={submit}
      >
        {submitted ? 'Feedback submitted' : label}
      </Button>
    </div>
  );
});
