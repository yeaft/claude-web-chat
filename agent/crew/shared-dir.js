/**
 * Crew — 共享目录和 CLAUDE.md 管理
 * initSharedDir, initRoleDir, writeSharedClaudeMd, writeRoleClaudeMd, updateSharedClaudeMd
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMessages } from '../crew-i18n.js';

/** Format role label: "icon displayName" or just "displayName" if no icon */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 初始化共享目录
 */
export async function initSharedDir(sharedDir, roles, projectDir, language = 'zh-CN') {
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(join(sharedDir, 'context'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'sessions'), { recursive: true });
  await fs.mkdir(join(sharedDir, 'roles'), { recursive: true });

  // 初始化每个角色的目录
  for (const role of roles) {
    await initRoleDir(sharedDir, role, language, roles);
  }

  // 生成 .crew/CLAUDE.md（共享级）
  await writeSharedClaudeMd(sharedDir, roles, projectDir, language);
}

/**
 * 初始化角色目录: .crew/roles/{roleName}/CLAUDE.md
 */
export async function initRoleDir(sharedDir, role, language = 'zh-CN', allRoles = []) {
  const roleDir = join(sharedDir, 'roles', role.name);
  await fs.mkdir(roleDir, { recursive: true });

  // 角色 CLAUDE.md（仅首次创建，后续角色自己维护记忆内容）
  const claudeMdPath = join(roleDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    // 已存在，不覆盖（保留角色自己写入的记忆）
  } catch {
    await writeRoleClaudeMd(sharedDir, role, language, allRoles);
  }
}

/**
 * 写入 .crew/CLAUDE.md — 共享级（所有角色自动继承）
 */
export async function writeSharedClaudeMd(sharedDir, roles, projectDir, language = 'zh-CN') {
  const m = getMessages(language);

  const claudeMd = `${m.projectGoal}

${m.projectCodePath}
${projectDir}
${m.useAbsolutePath}

${m.teamMembersTitle}
${roles.length > 0 ? roles.map(r => `- ${roleLabel(r)}(${r.name}): ${r.description}${r.isDecisionMaker ? ` (${m.decisionMakerTag})` : ''}`).join('\n') : m.noMembers}

${m.workConventions}
${m.workConventionsContent}

${m.stuckRules}
${m.stuckRulesContent}

${m.worktreeRules}
${m.worktreeRulesContent}

${m.featureRecordShared}

${m.sharedMemoryTitle}
${m.sharedMemoryDefault}
`;

  await fs.writeFile(join(sharedDir, 'CLAUDE.md'), claudeMd);
}

/**
 * Replace generic role names in ROUTE examples with actual instance names.
 *
 * Given a role with groupIndex=2 and the full role list containing
 * dev-1, dev-2, rev-1, rev-2, test-1, test-2, the function rewrites:
 *   "to: reviewer"  → "to: rev-2"
 *   "to: developer" → "to: dev-2"
 *   "to: tester"    → "to: test-2"
 *
 * For roles without a groupIndex (pm, designer, etc.), or when no matching
 * instance exists, the generic name is left untouched.
 *
 * @param {string} text - claudeMd content with generic ROUTE targets
 * @param {object} role - the role being written (must have roleType, groupIndex)
 * @param {Array}  allRoles - full expanded role list
 * @returns {string} text with generic names replaced by instance names
 */
export function resolveRouteTargets(text, role, allRoles) {
  if (!allRoles || allRoles.length === 0 || !role.groupIndex) return text;

  // Build a lookup: generic roleType → instance name at this groupIndex
  // e.g. { developer: 'dev-2', reviewer: 'rev-2', tester: 'test-2' }
  const instanceMap = {};
  for (const r of allRoles) {
    if (r.groupIndex === role.groupIndex && r.roleType && r.name !== r.roleType) {
      instanceMap[r.roleType] = r.name;
    }
  }

  if (Object.keys(instanceMap).length === 0) return text;

  // Replace "to: <genericName>" inside ROUTE blocks
  // Use a careful regex that only touches the `to:` field value
  return text.replace(/(to:\s*)(developer|reviewer|tester)\b/gi, (match, prefix, genericName) => {
    const resolved = instanceMap[genericName.toLowerCase()];
    return resolved ? `${prefix}${resolved}` : match;
  });
}

/**
 * 写入 .crew/roles/{roleName}/CLAUDE.md — 角色级
 * @param {string} sharedDir
 * @param {object} role
 * @param {string} language
 * @param {Array}  [allRoles] - full expanded role list for ROUTE target resolution
 */
export async function writeRoleClaudeMd(sharedDir, role, language = 'zh-CN', allRoles = []) {
  const roleDir = join(sharedDir, 'roles', role.name);
  const m = getMessages(language);

  // Resolve generic ROUTE targets to actual instance names
  const resolvedClaudeMd = resolveRouteTargets(role.claudeMd || role.description, role, allRoles);

  let claudeMd = `${m.roleTitle(roleLabel(role))}
${resolvedClaudeMd}
`;

  // 有独立 worktree 的角色，覆盖代码工作目录
  if (role.workDir) {
    claudeMd += `
${m.codeWorkDir}
${role.workDir}
${m.codeWorkDirNote}
`;
  }

  claudeMd += `
${m.personalMemory}
${m.personalMemoryDefault}
`;

  await fs.writeFile(join(roleDir, 'CLAUDE.md'), claudeMd);
}

/**
 * 角色变动时更新 .crew/CLAUDE.md
 */
export async function updateSharedClaudeMd(session) {
  const roles = Array.from(session.roles.values());
  await writeSharedClaudeMd(session.sharedDir, roles, session.projectDir, session.language || 'zh-CN');
}
