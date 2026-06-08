import { useCallback } from 'react';

import { useMutation, useQuery, useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import {
  isTextCompressedDeflate,
  textCompressDeflate,
  textDecompressDeflate,
} from '@mlflow/mlflow/src/common/utils/StringUtils';
import {
  CUSTOM_VIEW_PREFIX,
  CUSTOM_VIEW_TAG_KEY,
  parseCustomView,
  parseCustomViewDefinition,
  serializeCustomView,
  viewTagKey,
  type CustomView,
} from '@mlflow/mlflow/src/shared/web-shared/model-trace-explorer/custom-view/customViewDefinition';

import { MlflowService } from '../../../../sdk/MlflowService';

// Experiment tag values are capped at 5000 chars by the backend; we deflate-
// compress anything that would exceed it (the same approach as shared view
// state) and reject the rare view that's still too large afterwards. With one
// tag per view this cap now applies per view, not to the whole collection.
const TAG_VALUE_MAX_LENGTH = 5000;

const deserializeView = async (value: string): Promise<CustomView | undefined> => {
  try {
    const json = isTextCompressedDeflate(value) ? await textDecompressDeflate(value) : value;
    return parseCustomView(JSON.parse(json));
  } catch {
    return undefined;
  }
};

const serializeView = async (view: CustomView): Promise<string> => {
  const json = serializeCustomView(view);
  const value = json.length > TAG_VALUE_MAX_LENGTH ? await textCompressDeflate(json) : json;
  if (value.length > TAG_VALUE_MAX_LENGTH) {
    throw new Error('This custom view is too large to save to the experiment. Simplify the view and try again.');
  }
  return value;
};

// Reads the legacy single-tag definition (if any) and converts each of its
// panels into a CustomView so an experiment authored before multi-view support
// still surfaces its view in the switcher.
const readLegacyViews = async (value: string): Promise<CustomView[]> => {
  try {
    const json = isTextCompressedDeflate(value) ? await textDecompressDeflate(value) : value;
    const definition = parseCustomViewDefinition(JSON.parse(json));
    return definition.panels.map((panel) => ({
      id: `legacy-${panel.id}`,
      name: panel.label || 'Imported view',
      label: panel.label,
      instruction: panel.instruction,
      template: panel.template,
      createdAtMs: 0,
    }));
  } catch {
    return [];
  }
};

/**
 * Reads/writes the experiment-scoped custom views, stored one-tag-per-view under
 * `mlflow.customView.view.v1.<viewId>` experiment tags. Returns the loaded views,
 * a load-state flag, and `persistView` / `deleteView` callbacks (undefined when
 * there's no experiment, which falls back to a session-local registry).
 */
export const useExperimentCustomViewDefinition = (experimentId?: string) => {
  const queryClient = useQueryClient();
  const queryKey = ['experiment-custom-views', experimentId];

  const { data, isLoading } = useQuery<CustomView[]>({
    queryKey,
    enabled: Boolean(experimentId),
    queryFn: async () => {
      const response = await MlflowService.getExperiment({ experiment_id: experimentId });
      const tags: { key: string; value: string }[] = response?.experiment?.tags ?? [];

      const views: CustomView[] = [];
      for (const tag of tags) {
        if (typeof tag.key === 'string' && tag.key.startsWith(CUSTOM_VIEW_PREFIX) && tag.value) {
          const view = await deserializeView(tag.value);
          if (view) {
            views.push(view);
          }
        }
      }

      // Migrate the legacy single-tag view if present and not already saved as a
      // per-view tag.
      const legacy = tags.find((entry) => entry.key === CUSTOM_VIEW_TAG_KEY);
      if (legacy?.value) {
        for (const migrated of await readLegacyViews(legacy.value)) {
          if (!views.some((view) => view.id === migrated.id)) {
            views.push(migrated);
          }
        }
      }

      views.sort((a, b) => a.createdAtMs - b.createdAtMs);
      return views;
    },
  });

  const persistMutation = useMutation({
    mutationFn: async (view: CustomView) => {
      const value = await serializeView(view);
      await MlflowService.setExperimentTag({ experiment_id: experimentId, key: viewTagKey(view.id), value });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await MlflowService.deleteExperimentTag({ experiment_id: experimentId, key: viewTagKey(id) });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const persistView = useCallback(
    async (view: CustomView) => {
      await persistMutation.mutateAsync(view);
    },
    [persistMutation],
  );

  const deleteView = useCallback(
    async (id: string) => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  return {
    views: data ?? [],
    // Nothing to load when there's no experiment; treat as loaded so the
    // session-local fallback engages immediately.
    isLoaded: experimentId ? !isLoading : true,
    persistView: experimentId ? persistView : undefined,
    deleteView: experimentId ? deleteView : undefined,
  };
};
