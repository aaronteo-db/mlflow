import type { A2uiMessage } from '@a2ui/web_core/v0_9';

// Legacy single-view tag (pre multi-view). Kept ONLY so we can read & migrate an
// experiment that still has the old packed definition; new writes never use it.
export const CUSTOM_VIEW_TAG_KEY = 'mlflow.customView.v1';

// One experiment tag per saved view: `mlflow.customView.view.v1.<viewId>`. The
// `mlflow.` prefix keeps these out of the user-facing tag editor (see
// isUserFacingTag), and one-tag-per-view means the 5000-char tag value cap
// applies per view rather than to the whole collection.
export const CUSTOM_VIEW_PREFIX = 'mlflow.customView.view.v1.';
export const viewTagKey = (id: string): string => `${CUSTOM_VIEW_PREFIX}${id}`;

export const CUSTOM_VIEW_DEFINITION_VERSION = 1 as const;

// A single saved custom view. Two distinct titles:
//
//  - `name` is the USER-provided name (from the "Create trace view" naming
//    modal). It's shown in the view switcher dropdown + the selected-view
//    button and is never overwritten by the assistant.
//  - `label` is the LLM-generated surface title (from the assistant `{title}`)
//    shown as the panel header inside the rendered view.
//  - `template` is the most recent Assistant-generated A2UI spec. It serves as
//    the design reference handed back to the Assistant when regenerating for
//    another trace, and the instant cache seed for the trace it was authored on.
//    It is NOT used as an offline render — when the Assistant is unavailable the
//    host shows an explicit "view can't be generated" placeholder rather than
//    this template (which holds the authoring trace's data and would mismatch
//    the open trace).
//  - `instruction` is the latest natural-language request (the human intent)
//    replayed alongside the reference template on regeneration.
//  - `createdAtMs` orders the switcher and picks the default-on-load view.
export type CustomView = {
  id: string;
  name: string;
  label: string;
  instruction: string;
  template: A2uiMessage[];
  createdAtMs: number;
};

// Narrow + validate an arbitrary parsed object into a CustomView. Returns
// undefined for anything we don't recognize so a corrupt or future-version tag
// is skipped rather than crashing the view.
export const parseCustomView = (value: unknown): CustomView | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<CustomView>;
  if (typeof candidate.id !== 'string' || !Array.isArray(candidate.template)) {
    return undefined;
  }
  return {
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    label: typeof candidate.label === 'string' ? candidate.label : (candidate.name ?? ''),
    instruction: typeof candidate.instruction === 'string' ? candidate.instruction : '',
    template: candidate.template as A2uiMessage[],
    createdAtMs: typeof candidate.createdAtMs === 'number' ? candidate.createdAtMs : 0,
  };
};

export const serializeCustomView = (view: CustomView): string => JSON.stringify(view);

// --- Legacy single-tag schema (read-only, for migration) -------------------

export type CustomViewPanel = {
  id: string;
  kind: 'agent';
  instruction: string;
  template: A2uiMessage[];
  label: string;
};

export type CustomViewDefinition = {
  version: typeof CUSTOM_VIEW_DEFINITION_VERSION;
  panels: CustomViewPanel[];
};

export const EMPTY_CUSTOM_VIEW_DEFINITION: CustomViewDefinition = {
  version: CUSTOM_VIEW_DEFINITION_VERSION,
  panels: [],
};

// Narrow + version-check the legacy packed definition so a migration read of a
// corrupt or future-version tag never crashes the view.
export const parseCustomViewDefinition = (value: unknown): CustomViewDefinition => {
  if (!value || typeof value !== 'object') {
    return EMPTY_CUSTOM_VIEW_DEFINITION;
  }
  const candidate = value as Partial<CustomViewDefinition>;
  if (candidate.version !== CUSTOM_VIEW_DEFINITION_VERSION || !Array.isArray(candidate.panels)) {
    return EMPTY_CUSTOM_VIEW_DEFINITION;
  }
  const panels = candidate.panels.filter((panel): panel is CustomViewPanel => {
    if (!panel || typeof panel !== 'object') {
      return false;
    }
    const entry = panel as CustomViewPanel;
    if (entry.kind === 'agent') {
      return typeof entry.id === 'string' && Array.isArray(entry.template);
    }
    return false;
  });
  return { version: CUSTOM_VIEW_DEFINITION_VERSION, panels };
};
