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
    await initRoleDir(sharedDir, role, language);
  }

  // 生成 .crew/CLAUDE.md（共享级）
  await writeSharedClaudeMd(sharedDir, roles, projectDir, language);
}

/**
 * 初始化角色目录: .crew/roles/{roleName}/CLAUDE.md
 */
export async function initRoleDir(sharedDir, role, language = 'zh-CN') {
  const roleDir = join(sharedDir, 'roles', role.name);
  await fs.mkdir(roleDir, { recursive: true });

  // 角色 CLAUDE.md（仅首次创建，后续角色自己维护记忆内容）
  const claudeMdPath = join(roleDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
    // 已存在，不覆盖（保留角色自己写入的记忆）
  } catch {
    await writeRoleClaudeMd(sharedDir, role, language);
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
 * 写入 .crew/roles/{roleName}/CLAUDE.md — 角色级
 */
export async function writeRoleClaudeMd(sharedDir, role, language = 'zh-CN') {
  const roleDir = join(sharedDir, 'roles', role.name);
  const m = getMessages(language);

  let claudeMd = `${m.roleTitle(roleLabel(role))}
${role.claudeMd || role.description}
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
