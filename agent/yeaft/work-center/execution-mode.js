export const LEGACY_COORDINATION_MODE = 'legacy';
export const DYNAMIC_COORDINATION_MODE = 'dynamic';
export const DYNAMIC_EXECUTION_SCHEMA_VERSION = 3;

export function isDynamicWorkItem(workItem) {
  return workItem?.coordinationMode === DYNAMIC_COORDINATION_MODE;
}

export function usesMainlineContext(workItem) {
  return Number(workItem?.executionSchemaVersion) >= 2;
}

export function usesLegacyGraph(workItem) {
  return !isDynamicWorkItem(workItem)
    && workItem?.workflowSnapshot?.executionMode === 'graph';
}
