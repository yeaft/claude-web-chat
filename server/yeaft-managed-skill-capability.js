import { YEAFT_PLUGINS_CAPABILITY } from './yeaft-plugin-capability.js';

export const YEAFT_MANAGED_SKILLS_CAPABILITY = 'yeaft_managed_skills';
export const YEAFT_MANAGED_SKILLS_UNSUPPORTED_ERROR = 'The selected Agent does not support Skill management; upgrade and restart the Agent';

export function agentSupportsYeaftManagedSkills(agent) {
  if (agent?.capabilityMetadataProvided !== true) return false;
  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  return capabilities.includes(YEAFT_PLUGINS_CAPABILITY)
    && capabilities.includes(YEAFT_MANAGED_SKILLS_CAPABILITY);
}
