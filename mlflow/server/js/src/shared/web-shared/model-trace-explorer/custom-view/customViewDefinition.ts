import type { A2uiMessage } from '@a2ui/web_core/v0_9';

// The experiment tag key under which a single custom-view definition is
// persisted. The `mlflow.` prefix keeps it out of the user-facing tag editor
// (see isUserFacingTag), matching how notes / shared view state are stored.
export const CUSTOM_VIEW_TAG_KEY = 'mlflow.customView.v1';

export const CUSTOM_VIEW_DEFINITION_VERSION = 1 as const;

// The persisted recipe for one dashboard panel — the reusable "design" we store,
// not bound trace data. A panel is regenerated per trace by MLflow Assistant:
//
//  - `template` is the most recent Assistant-generated A2UI spec. It serves two
//    roles: the design reference handed back to the Assistant when regenerating
//    for another trace, and the instant cache seed for the trace it was authored
//    on. It is NOT used as an offline render — when the Assistant is unavailable
//    the host shows an explicit "view can't be generated" placeholder rather than
//    this template, which holds the authoring trace's data and would mismatch the
//    open trace.
//  - `instruction` is the latest natural-language request (the human intent)
//    replayed alongside the reference template on regeneration.
//  - `label` is the short, LLM-chosen view title (e.g. "Trace Summary") shown as
//    the panel header and persisted across traces.
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

// Narrow + version-check an arbitrary parsed object into a CustomViewDefinition.
// Returns the empty definition for anything we don't recognize so a corrupt or
// future-version tag never crashes the view.
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
