let managedSandboxIdentity = null;

export function setManagedSandboxIdentity(identity) {
  managedSandboxIdentity = identity;
}

export function getManagedSandboxIdentity() {
  return managedSandboxIdentity;
}
