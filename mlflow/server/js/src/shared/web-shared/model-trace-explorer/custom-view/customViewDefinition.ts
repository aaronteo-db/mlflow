import type { A2uiMessage } from '@a2ui/web_core/v0_9';

// The experiment tag key under which a single custom-view definition is
// persisted. The `mlflow.` prefix keeps it out of the user-facing tag editor
// (see isUserFacingTag), matching how notes / shared view state are stored.
export const CUSTOM_VIEW_TAG_KEY = 'mlflow.customView.v1';

export const CUSTOM_VIEW_DEFINITION_VERSION = 1 as const;

// A trace-agnostic recipe for one dashboard panel. The definition NEVER stores
// bound trace data — only how to (re)build a panel for whichever trace is open:
//
//  - 'agent' panels carry an LLM-generated `template` whose data is referenced via
//    `$source` markers; the host re-binds it per trace with no further LLM call.
//    When `requiresRegeneration` is true the template contains trace-specific
//    narrative the host cannot re-bind, so the LLM is re-called per trace.
export type CustomViewPanel = {
  id: string;
  kind: 'agent';
  instruction: string;
  endpointName?: string;
  template: A2uiMessage[];
  requiresRegeneration: boolean;
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
