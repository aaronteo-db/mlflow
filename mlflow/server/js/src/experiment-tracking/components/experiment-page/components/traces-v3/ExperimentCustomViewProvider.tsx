import { CustomViewDefinitionProvider } from '@mlflow/mlflow/src/shared/web-shared/model-trace-explorer/custom-view/CustomViewDefinitionContext';

import { useExperimentCustomViewDefinition } from './useExperimentCustomViewDefinition';

// Experiment-scoped provider for the trace-explorer Custom View. Mounted in the
// traces table (above the trace drawer) so the definition survives drawer close
// and trace cycling, and is shared across every trace in the experiment.
export const ExperimentCustomViewProvider = ({
  experimentId,
  children,
}: {
  experimentId?: string;
  children: React.ReactNode;
}) => {
  const { initialDefinition, isLoaded, persist } = useExperimentCustomViewDefinition(experimentId);
  return (
    <CustomViewDefinitionProvider initialDefinition={initialDefinition} isLoaded={isLoaded} onPersist={persist}>
      {children}
    </CustomViewDefinitionProvider>
  );
};
