import { CustomViewDefinitionProvider } from '@mlflow/mlflow/src/shared/web-shared/model-trace-explorer/custom-view/CustomViewDefinitionContext';

import { useExperimentCustomViewDefinition } from './useExperimentCustomViewDefinition';

// Experiment-scoped provider for the trace-explorer Custom View. Mounted in the
// traces table (above the trace drawer) so the views survive drawer close and
// trace cycling, and are shared across every trace in the experiment.
export const ExperimentCustomViewProvider = ({
  experimentId,
  children,
}: {
  experimentId?: string;
  children: React.ReactNode;
}) => {
  const { views, isLoaded, persistView, deleteView } = useExperimentCustomViewDefinition(experimentId);
  return (
    <CustomViewDefinitionProvider
      views={views}
      isLoaded={isLoaded}
      onPersistView={persistView}
      onDeleteView={deleteView}
    >
      {children}
    </CustomViewDefinitionProvider>
  );
};
