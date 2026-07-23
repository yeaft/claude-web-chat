export const DEFAULT_UPGRADE_REGISTRY = 'https://pkg.yeaft.com/';

/** Build the npm metadata command used by `yeaft-agent upgrade`. */
export function buildUpgradeVersionCommand(packageName) {
  return `npm view ${packageName} version --registry=${DEFAULT_UPGRADE_REGISTRY}`;
}

/** Build the npm install command used by `yeaft-agent upgrade`. */
export function buildUpgradeInstallCommand(packageSpec) {
  return `npm install -g ${packageSpec} --registry=${DEFAULT_UPGRADE_REGISTRY}`;
}
