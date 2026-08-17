import { YEAFT_PLUGINS_CAPABILITY } from './yeaft-plugin-capability.js';

// Managed Skill CRUD extends the Plugins protocol. Agents that did not yet
// publish capability metadata retain the legacy relay path during rollout;
// explicit metadata without this token is an intentional refusal.
export const YEAFT_MANAGED_SKILLS_CAPABILITY = 'yeaft_managed_skills';

export function agentSupportsYeaftManagedSkills(agent) {
  if (agent?.capabilityMetadataProvided !== true) return false;
  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  return capabilities.includes(YEAFT_PLUGINS_CAPABILITY)
    && capabilities.includes(YEAFT_MANAGED_SKILLS_CAPABILITY);
}
