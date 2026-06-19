import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { CustomViewDefinition, CustomViewPanel } from './customViewDefinition';

export type CustomViewDefinitionContextValue = {
  // The current (possibly edited) experiment-scoped definition.
  definition: CustomViewDefinition;
  // Whether the persisted definition has finished loading (false while the
  // experiment tag is still being fetched).
  isLoaded: boolean;
  // Whether this value can persist to a backend (false for the session-local
  // fallback used outside the experiment provider).
  canPersist: boolean;
  isSaving: boolean;
  isDirty: boolean;
  saveError?: string;
  addPanel: (panel: CustomViewPanel) => void;
  // Replace the panel with the same id in place (preserving order), or append it
  // if no panel with that id exists. Used by Agent Mode to iteratively modify the
  // single agent panel instead of appending a new one each prompt.
  upsertPanel: (panel: CustomViewPanel) => void;
  // Collapse the definition to EXACTLY this one panel. The custom view is a single
  // assistant-authored surface, so applying a template replaces whatever is there
  // (and atomically clears any duplicates a prior race may have left behind).
  setSinglePanel: (panel: CustomViewPanel) => void;
  removePanel: (panelId: string) => void;
  movePanel: (panelId: string, direction: -1 | 1) => void;
  clearPanels: () => void;
  save: () => void;
};

const CustomViewDefinitionContext = createContext<CustomViewDefinitionContextValue | undefined>(undefined);

// Core state hook shared by the persistent provider and the session-local
// fallback. It manages the working definition, tracks dirtiness against the last
// persisted snapshot, and (when given) delegates persistence to `onPersist`.
export const useCustomViewDefinitionState = (
  initialDefinition: CustomViewDefinition,
  isLoaded: boolean,
  onPersist?: (definition: CustomViewDefinition) => Promise<void>,
): CustomViewDefinitionContextValue => {
  const [definition, setDefinition] = useState<CustomViewDefinition>(initialDefinition);
  const [persistedDefinition, setPersistedDefinition] = useState<CustomViewDefinition>(initialDefinition);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Adopt the loaded definition exactly once, so a later refetch doesn't clobber
  // unsaved local edits.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (isLoaded && !adoptedRef.current) {
      adoptedRef.current = true;
      setDefinition(initialDefinition);
      setPersistedDefinition(initialDefinition);
    }
  }, [isLoaded, initialDefinition]);

  const isDirty = useMemo(
    () => JSON.stringify(definition) !== JSON.stringify(persistedDefinition),
    [definition, persistedDefinition],
  );

  const addPanel = useCallback((panel: CustomViewPanel) => {
    setDefinition((prev) => ({ ...prev, panels: [...prev.panels, panel] }));
  }, []);

  const upsertPanel = useCallback((panel: CustomViewPanel) => {
    setDefinition((prev) => {
      const index = prev.panels.findIndex((entry) => entry.id === panel.id);
      if (index < 0) {
        return { ...prev, panels: [...prev.panels, panel] };
      }
      const panels = [...prev.panels];
      panels[index] = panel;
      return { ...prev, panels };
    });
  }, []);

  const setSinglePanel = useCallback((panel: CustomViewPanel) => {
    setDefinition((prev) => ({ ...prev, panels: [panel] }));
  }, []);

  const removePanel = useCallback((panelId: string) => {
    setDefinition((prev) => ({ ...prev, panels: prev.panels.filter((panel) => panel.id !== panelId) }));
  }, []);

  const movePanel = useCallback((panelId: string, direction: -1 | 1) => {
    setDefinition((prev) => {
      const index = prev.panels.findIndex((panel) => panel.id === panelId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.panels.length) {
        return prev;
      }
      const panels = [...prev.panels];
      [panels[index], panels[target]] = [panels[target], panels[index]];
      return { ...prev, panels };
    });
  }, []);

  const clearPanels = useCallback(() => {
    setDefinition((prev) => ({ ...prev, panels: [] }));
  }, []);

  const save = useCallback(async () => {
    if (!onPersist) {
      return;
    }
    setIsSaving(true);
    setSaveError(undefined);
    const snapshot = definition;
    try {
      await onPersist(snapshot);
      setPersistedDefinition(snapshot);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save the custom view.');
    } finally {
      setIsSaving(false);
    }
  }, [onPersist, definition]);

  return {
    definition,
    isLoaded,
    canPersist: Boolean(onPersist),
    isSaving,
    isDirty,
    saveError,
    addPanel,
    upsertPanel,
    setSinglePanel,
    removePanel,
    movePanel,
    clearPanels,
    save,
  };
};

// Generic provider: experiment-tracking wires this up with a loaded definition +
// an `onPersist` that writes the experiment tag. Mounted high enough (e.g. in the
// traces table) that it survives drawer close / trace cycling.
export const CustomViewDefinitionProvider = ({
  initialDefinition,
  isLoaded,
  onPersist,
  children,
}: {
  initialDefinition: CustomViewDefinition;
  isLoaded: boolean;
  onPersist?: (definition: CustomViewDefinition) => Promise<void>;
  children: React.ReactNode;
}) => {
  const value = useCustomViewDefinitionState(initialDefinition, isLoaded, onPersist);
  return <CustomViewDefinitionContext.Provider value={value}>{children}</CustomViewDefinitionContext.Provider>;
};

// Returns the experiment-scoped value, or undefined when no provider is mounted
// (e.g. the notebook embed). Callers fall back to a session-local state hook.
export const useOptionalCustomViewDefinition = (): CustomViewDefinitionContextValue | undefined =>
  useContext(CustomViewDefinitionContext);
