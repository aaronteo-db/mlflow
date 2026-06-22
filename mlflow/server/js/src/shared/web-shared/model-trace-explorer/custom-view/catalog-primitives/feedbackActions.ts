/**
 * Shared action names for the staged-feedback primitives (RadioGroup,
 * FeedbackInputText, FeedbackSubmit). Unlike FeedbackButtons (which logs an
 * assessment immediately on click), these controls only STAGE their values into
 * a host-side buffer; a single FeedbackSubmit click flushes the buffer and logs
 * one MLflow assessment per dimension. Kept in their own module so every
 * primitive can import the names without pulling in sibling components (avoids
 * import cycles).
 */

/**
 * Dispatched whenever a staged-feedback input changes. The host merges the
 * action context into its pending buffer keyed by `{ surfaceId -> name }`.
 * Context: `{ name, value?, rationale?, spanId? }` — `value` and `rationale`
 * are both optional so an input can stage either field (or both over time).
 */
export const FEEDBACK_STAGED = 'mlflow.custom-view.feedback-staged';

/**
 * Dispatched by FeedbackSubmit. The host reads every staged entry for the
 * surface, logs one assessment per `name` (value and/or rationale), then clears
 * the buffer for that surface.
 */
export const FEEDBACK_SUBMIT_ALL = 'mlflow.custom-view.feedback-submit-all';

/** Shape of the action context carried by a FEEDBACK_STAGED dispatch. */
export type StagedFeedbackContext = {
  name: string;
  value?: string;
  rationale?: string;
  spanId?: string;
};
