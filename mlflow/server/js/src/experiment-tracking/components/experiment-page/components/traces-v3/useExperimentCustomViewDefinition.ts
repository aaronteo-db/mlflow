import { useCallback } from 'react';

import { useMutation, useQuery, useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import {
  isTextCompressedDeflate,
  textCompressDeflate,
  textDecompressDeflate,
} from '@mlflow/mlflow/src/common/utils/StringUtils';
import {
  CUSTOM_VIEW_TAG_KEY,
  EMPTY_CUSTOM_VIEW_DEFINITION,
  parseCustomViewDefinition,
  type CustomViewDefinition,
} from '@mlflow/mlflow/src/shared/web-shared/model-trace-explorer/custom-view/customViewDefinition';

import { MlflowService } from '../../../../sdk/MlflowService';

// Experiment tag values are capped at 5000 chars by the backend; we deflate-
// compress anything that would exceed it (the same approach as shared view
// state) and reject the rare definition that's still too large afterwards.
const TAG_VALUE_MAX_LENGTH = 5000;

const deserializeDefinition = async (value: string): Promise<CustomViewDefinition> => {
  try {
    const json = isTextCompressedDeflate(value) ? await textDecompressDeflate(value) : value;
    return parseCustomViewDefinition(JSON.parse(json));
  } catch {
    return EMPTY_CUSTOM_VIEW_DEFINITION;
  }
};

const serializeDefinition = async (definition: CustomViewDefinition): Promise<string> => {
  const json = JSON.stringify(definition);
  const value = json.length > TAG_VALUE_MAX_LENGTH ? await textCompressDeflate(json) : json;
  if (value.length > TAG_VALUE_MAX_LENGTH) {
    throw new Error('This custom view is too large to save to the experiment. Remove a panel and try again.');
  }
  return value;
};

/**
 * Reads/writes the experiment-scoped custom-view definition stored under the
 * `mlflow.customView.v1` experiment tag. Returns the loaded definition, a
 * load-state flag, and a `persist` callback (undefined when there's no
 * experiment, which falls back to a session-local definition).
 */
export const useExperimentCustomViewDefinition = (experimentId?: string) => {
  const queryClient = useQueryClient();
  const queryKey = ['experiment-custom-view-definition', experimentId];

  const { data, isLoading } = useQuery<CustomViewDefinition>({
    queryKey,
    enabled: Boolean(experimentId),
    queryFn: async () => {
      const response = await MlflowService.getExperiment({ experiment_id: experimentId });
      const tags: { key: string; value: string }[] = response?.experiment?.tags ?? [];
      const tag = tags.find((entry) => entry.key === CUSTOM_VIEW_TAG_KEY);
      if (!tag?.value) {
        return EMPTY_CUSTOM_VIEW_DEFINITION;
      }
      return deserializeDefinition(tag.value);
    },
  });

  const mutation = useMutation({
    mutationFn: async (definition: CustomViewDefinition) => {
      const value = await serializeDefinition(definition);
      await MlflowService.setExperimentTag({ experiment_id: experimentId, key: CUSTOM_VIEW_TAG_KEY, value });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const persist = useCallback(
    async (definition: CustomViewDefinition) => {
      await mutation.mutateAsync(definition);
    },
    [mutation],
  );

  return {
    initialDefinition: data ?? EMPTY_CUSTOM_VIEW_DEFINITION,
    // Nothing to load when there's no experiment; treat as loaded so the
    // session-local fallback engages immediately.
    isLoaded: experimentId ? !isLoading : true,
    persist: experimentId ? persist : undefined,
  };
};
