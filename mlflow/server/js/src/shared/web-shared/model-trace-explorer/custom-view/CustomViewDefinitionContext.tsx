import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { CustomView } from './customViewDefinition';

export type CustomViewDefinitionContextValue = {
  // Every view available for this experiment (persisted views + in-memory
  // edits + a freshly generated, not-yet-saved view).
  views: CustomView[];
  // The currently selected view id (undefined while a brand-new view is being
  // drafted, or before anything is selected).
  activeViewId?: string;
  // The currently selected view, or undefined (empty-state / draft).
  activeView?: CustomView;
  // True while the user has started "Create trace view" but the assistant
  // hasn't produced the first spec yet (the empty-state textbox is showing).
  isDraft: boolean;
  // The name chosen in the naming modal for the in-progress draft.
  draftName: string;
  // Whether the persisted views have finished loading.
  isLoaded: boolean;
  // Whether this value can persist to a backend (false for the session-local
  // fallback used outside the experiment provider).
  canPersist: boolean;
  isSaving: boolean;
  // Whether the active view differs from its persisted counterpart (or has none).
  isDirty: boolean;
  // Whether the active view has been persisted to the backend (false for a
  // freshly built, never-saved view — for which Reset, not Delete, applies).
  isActivePersisted: boolean;
  saveError?: string;
  selectView: (id: string) => void;
  // Begin a brand-new view with the given user-provided name. Clears the active
  // selection so the empty-state prompt box shows; the name rides along until
  // the assistant materializes the view.
  startNewView: (name: string) => void;
  // Create or replace the active view's content (instruction / template / LLM
  // label). Creates the view (and selects it) when it doesn't exist yet. The
  // user-provided `name` is preserved, never overwritten by the assistant.
  upsertViewContent: (view: CustomView) => void;
  // Persist the active view, optionally renaming it first (the first-save flow
  // passes the name collected from the modal).
  saveActiveView: (nameOverride?: string) => void;
  deleteView: (id: string) => void;
  // Revert the active view's unsaved edits, or cancel an in-progress draft.
  resetActiveView: () => void;
};

const CustomViewDefinitionContext = createContext<CustomViewDefinitionContextValue | undefined>(undefined);

// Upsert a view by id into a list, preserving order (replace in place or append).
const upsertById = (views: CustomView[], view: CustomView): CustomView[] => {
  const index = views.findIndex((entry) => entry.id === view.id);
  if (index < 0) {
    return [...views, view];
  }
  const next = [...views];
  next[index] = view;
  return next;
};

// Core state hook shared by the persistent provider and the session-local
// fallback. It manages the working view registry + active selection, tracks
// per-view dirtiness against the last persisted snapshot, and (when given)
// delegates persistence to `onPersistView` / `onDeleteView`.
export const useCustomViewDefinitionState = (
  initialViews: CustomView[],
  isLoaded: boolean,
  onPersistView?: (view: CustomView) => Promise<void>,
  onDeleteView?: (id: string) => Promise<void>,
): CustomViewDefinitionContextValue => {
  const [views, setViews] = useState<CustomView[]>(initialViews);
  const [persistedViews, setPersistedViews] = useState<CustomView[]>(initialViews);
  const [activeViewId, setActiveViewId] = useState<string | undefined>(initialViews[0]?.id);
  const [isDraft, setIsDraft] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Adopt the loaded views exactly once (defaulting the active view to the
  // first), so a later refetch doesn't clobber unsaved local edits.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (isLoaded && !adoptedRef.current) {
      adoptedRef.current = true;
      setViews(initialViews);
      setPersistedViews(initialViews);
      setActiveViewId((current) => current ?? initialViews[0]?.id);
    }
  }, [isLoaded, initialViews]);

  const activeView = useMemo(() => views.find((view) => view.id === activeViewId), [views, activeViewId]);

  const isDirty = useMemo(() => {
    if (!activeView) {
      return false;
    }
    const persisted = persistedViews.find((view) => view.id === activeView.id);
    return JSON.stringify(activeView) !== JSON.stringify(persisted);
  }, [activeView, persistedViews]);

  const isActivePersisted = useMemo(
    () => Boolean(activeViewId) && persistedViews.some((view) => view.id === activeViewId),
    [activeViewId, persistedViews],
  );

  const selectView = useCallback((id: string) => {
    setSaveError(undefined);
    setIsDraft(false);
    setDraftName('');
    setActiveViewId(id);
  }, []);

  const startNewView = useCallback((name: string) => {
    setSaveError(undefined);
    setDraftName(name);
    setIsDraft(true);
    setActiveViewId(undefined);
  }, []);

  const upsertViewContent = useCallback((view: CustomView) => {
    setViews((prev) => upsertById(prev, view));
    setActiveViewId(view.id);
    setIsDraft(false);
    setDraftName('');
  }, []);

  const saveActiveView = useCallback(
    async (nameOverride?: string) => {
      if (!onPersistView || !activeView) {
        return;
      }
      const view =
        nameOverride !== undefined && nameOverride.trim() ? { ...activeView, name: nameOverride.trim() } : activeView;
      setIsSaving(true);
      setSaveError(undefined);
      try {
        await onPersistView(view);
        setViews((prev) => upsertById(prev, view));
        setPersistedViews((prev) => upsertById(prev, view));
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Failed to save the custom view.');
      } finally {
        setIsSaving(false);
      }
    },
    [onPersistView, activeView],
  );

  const deleteView = useCallback(
    async (id: string) => {
      setSaveError(undefined);
      if (onDeleteView && persistedViews.some((view) => view.id === id)) {
        try {
          await onDeleteView(id);
        } catch (error) {
          setSaveError(error instanceof Error ? error.message : 'Failed to delete the custom view.');
          return;
        }
      }
      const remaining = views.filter((view) => view.id !== id);
      setPersistedViews((prev) => prev.filter((view) => view.id !== id));
      setViews(remaining);
      setActiveViewId((current) => (current === id ? remaining[0]?.id : current));
    },
    [onDeleteView, persistedViews, views],
  );

  const resetActiveView = useCallback(() => {
    setSaveError(undefined);
    // Cancel an in-progress draft: drop back to the first persisted view.
    if (isDraft || !activeViewId) {
      setIsDraft(false);
      setDraftName('');
      setActiveViewId((current) => current ?? persistedViews[0]?.id);
      return;
    }
    const persisted = persistedViews.find((view) => view.id === activeViewId);
    if (persisted) {
      // Revert unsaved edits to the persisted snapshot.
      setViews((prev) => upsertById(prev, persisted));
    } else {
      // Never saved: drop it and fall back to the first persisted view.
      setViews((prev) => prev.filter((view) => view.id !== activeViewId));
      setActiveViewId(persistedViews[0]?.id);
    }
  }, [isDraft, activeViewId, persistedViews]);

  return {
    views,
    activeViewId,
    activeView,
    isDraft,
    draftName,
    isLoaded,
    canPersist: Boolean(onPersistView),
    isSaving,
    isDirty,
    isActivePersisted,
    saveError,
    selectView,
    startNewView,
    upsertViewContent,
    saveActiveView,
    deleteView,
    resetActiveView,
  };
};

// Generic provider: experiment-tracking wires this up with the loaded views +
// persist/delete callbacks that write per-view experiment tags. Mounted high
// enough (e.g. in the traces table) that it survives drawer close / trace
// cycling.
export const CustomViewDefinitionProvider = ({
  views,
  isLoaded,
  onPersistView,
  onDeleteView,
  children,
}: {
  views: CustomView[];
  isLoaded: boolean;
  onPersistView?: (view: CustomView) => Promise<void>;
  onDeleteView?: (id: string) => Promise<void>;
  children: React.ReactNode;
}) => {
  const value = useCustomViewDefinitionState(views, isLoaded, onPersistView, onDeleteView);
  return <CustomViewDefinitionContext.Provider value={value}>{children}</CustomViewDefinitionContext.Provider>;
};

// Returns the experiment-scoped value, or undefined when no provider is mounted
// (e.g. the notebook embed). Callers fall back to a session-local state hook.
export const useOptionalCustomViewDefinition = (): CustomViewDefinitionContextValue | undefined =>
  useContext(CustomViewDefinitionContext);
