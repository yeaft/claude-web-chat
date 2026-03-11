/**
 * RolePlay — .roleplay/ directory and CLAUDE.md management.
 *
 * Analogous to agent/crew/shared-dir.js but for the single-process
 * RolePlay collaboration mode.
 *
 * Directory structure:
 *   .roleplay/
 *   ├── CLAUDE.md              (shared instructions, inherited by all sessions)
 *   ├── session.json           (session index)
 *   ├── roles/                 (one subdirectory per session)
 *   │   └── {session-name}/
 *   │       └── CLAUDE.md      (Claude Code cwd points here)
 *   └── context/
 *       ├── kanban.md
 *       └── features/
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getRolePlayMessages } from './roleplay-i18n.js';

// ─── Team type → default role set mapping ───────────────────────────
// Each entry is a list of role names (keys into roleTemplates in i18n).
const TEAM_ROLES = {
  dev:     ['pm', 'dev', 'reviewer', 'tester'],
  writing: ['editor', 'writer', 'proofreader'],
  trading: ['analyst', 'strategist', 'risk-manager'],
  video:   ['director', 'writer', 'producer'],
  custom:  ['pm', 'dev', 'reviewer', 'tester'], // default same as dev
};

// ─── Session name constraints ───────────────────────────────────────
const SESSION_NAME_RE = /^[a-z0-9-]+$/;
const MAX_SESSION_NAME_LEN = 64;

/**
 * Generate a session directory name.
 *
 * Format: `{teamType}-{customName|"team"}-{YYYYMMDD}[-{seq}]`
 *
 * If a session with the same name already exists under .roleplay/roles/,
 * a sequence number is appended (e.g. `-2`, `-3`).
 *
 * @param {string} projectDir - absolute path to project root
 * @param {string} teamType - dev | writing | trading | video | custom
 * @param {string} [customName] - user-provided name (optional)
 * @returns {string} unique session name
 */
export function generateSessionName(projectDir, teamType, customName) {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  const namePart = sanitizeNamePart(customName) || 'team';
  const base = `${teamType}-${namePart}-${datePart}`;

  // Check for duplicates under .roleplay/roles/
  const rolesDir = join(projectDir, '.roleplay', 'roles');
  const existing = new Set();
  if (existsSync(rolesDir)) {
    try {
      for (const d of readdirSync(rolesDir, { withFileTypes: true })) {
        if (d.isDirectory()) existing.add(d.name);
      }
    } catch {
      // permission error — treat as empty
    }
  }

  if (!existing.has(base)) return base;

  // Append sequence number
  for (let seq = 2; seq <= 999; seq++) {
    const candidate = `${base}-${seq}`;
    if (!existing.has(candidate)) return candidate;
  }

  // Extremely unlikely: fall back to timestamp suffix
  return `${base}-${Date.now()}`;
}

/**
 * Sanitize user-provided name part:
 *  - lowercase
 *  - replace non-alphanumeric with hyphens
 *  - collapse consecutive hyphens
 *  - trim leading/trailing hyphens
 *  - enforce max length
 *
 * Returns empty string if input is empty/invalid.
 */
function sanitizeNamePart(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length > 30) s = s.substring(0, 30).replace(/-$/, '');
  return SESSION_NAME_RE.test(s) ? s : '';
}

// ─── Directory initialization ───────────────────────────────────────

/**
 * Ensure .roleplay/ directory structure exists.
 * Creates the top-level dirs if absent, writes shared CLAUDE.md
 * only on first creation (preserves user edits after that).
 *
 * @param {string} projectDir - absolute path to project root
 * @param {string} [language='zh-CN']
 */
export async function initRolePlayDir(projectDir, language = 'zh-CN') {
  const rpDir = join(projectDir, '.roleplay');

  await fs.mkdir(rpDir, { recursive: true });
  await fs.mkdir(join(rpDir, 'roles'), { recursive: true });
  await fs.mkdir(join(rpDir, 'context'), { recursive: true });
  await fs.mkdir(join(rpDir, 'context', 'features'), { recursive: true });

  // Write shared CLAUDE.md only if it doesn't exist
  const sharedMdPath = join(rpDir, 'CLAUDE.md');
  try {
    await fs.access(sharedMdPath);
    // Already exists — don't overwrite (user may have edited it)
  } catch {
    await writeRolePlaySharedClaudeMd(projectDir, language);
  }
}

/**
 * Write (or overwrite) .roleplay/CLAUDE.md — the shared-level instructions
 * inherited by all sessions via Claude Code's CLAUDE.md lookup chain.
 *
 * @param {string} projectDir
 * @param {string} [language='zh-CN']
 */
export async function writeRolePlaySharedClaudeMd(projectDir, language = 'zh-CN') {
  const m = getRolePlayMessages(language);
  const rpDir = join(projectDir, '.roleplay');

  const content = `${m.sharedTitle}

${m.projectPath}
${projectDir}
${m.useAbsolutePath}

${m.workMode}
${m.workModeContent}

${m.workConventions}
${m.workConventionsContent}

${m.crewRelation}
${m.crewRelationContent}

${m.sharedMemory}
${m.sharedMemoryDefault}
`;

  await fs.writeFile(join(rpDir, 'CLAUDE.md'), content);
}

// ─── Session CLAUDE.md generation ───────────────────────────────────

/**
 * Write .roleplay/roles/{sessionName}/CLAUDE.md — session-level config.
 *
 * This file is the core configuration that Claude Code reads automatically
 * (cwd is set to this directory). It contains:
 *  - Session metadata (name, teamType, language)
 *  - Full role list with descriptions (generated from teamType or custom roles)
 *  - ROUTE protocol reference
 *  - Workflow for this team type
 *  - Project path reference
 *  - Session memory section
 *
 * @param {string} projectDir - project root
 * @param {string} sessionName - session directory name
 * @param {object} config - { teamType, language, roles?, projectDir? }
 *   - config.roles: optional custom role array from RolePlay config.
 *     If provided and non-empty, these are used instead of default team roles.
 *     Each role: { name, displayName, icon?, description?, claudeMd? }
 */
export async function writeSessionClaudeMd(projectDir, sessionName, config) {
  const { teamType = 'dev', language = 'zh-CN', roles: customRoles } = config;
  const m = getRolePlayMessages(language);

  const sessionDir = join(projectDir, '.roleplay', 'roles', sessionName);
  await fs.mkdir(sessionDir, { recursive: true });

  // Build role list section
  const roleSection = buildRoleSection(teamType, language, customRoles);

  // Build workflow section
  const workflowMap = {
    dev: m.devWorkflow,
    writing: m.writingWorkflow,
    trading: m.tradingWorkflow,
    video: m.videoWorkflow,
  };
  const workflow = workflowMap[teamType] || m.genericWorkflow;

  const content = `${m.sessionTitle(sessionName)}

${m.teamTypeLabel}
${teamType}

${m.languageLabel}
${language}

${m.roleListTitle}

${roleSection}

${m.routeProtocol}

${m.workflowTitle}

${workflow}

${m.projectPathTitle}
${projectDir}
${m.useAbsolutePath}

${m.sessionMemory}
${m.sessionMemoryDefault}
`;

  await fs.writeFile(join(sessionDir, 'CLAUDE.md'), content);
}

/**
 * Build the role list section for a session CLAUDE.md.
 *
 * Strategy:
 *  1. If custom roles are provided (from RolePlay config), use them directly.
 *     For each custom role, look up a matching roleTemplate for extra detail,
 *     but prefer the custom role's claudeMd/description if provided.
 *  2. Otherwise, use the default role set for the teamType from TEAM_ROLES.
 */
function buildRoleSection(teamType, language, customRoles) {
  const m = getRolePlayMessages(language);
  const templates = m.roleTemplates;

  if (customRoles && customRoles.length > 0) {
    return customRoles.map(r => {
      const tmpl = templates[r.name];
      // Prefer custom claudeMd, then custom description, then template
      const body = r.claudeMd || r.description || (tmpl ? tmpl.content : '');
      const heading = tmpl
        ? tmpl.heading
        : `## ${r.icon || ''} ${r.displayName || r.name} (${r.name})`.replace(/\s{2,}/g, ' ');
      return `${heading}\n${body}`;
    }).join('\n\n');
  }

  // Default: use TEAM_ROLES mapping
  const roleNames = TEAM_ROLES[teamType] || TEAM_ROLES.dev;
  return roleNames.map(name => {
    const tmpl = templates[name];
    if (!tmpl) return `## ${name}\n(No template available)`;
    return `${tmpl.heading}\n${tmpl.content}`;
  }).join('\n\n');
}

/**
 * Get the default role list for a team type.
 * Used by session creation to populate session.json roles snapshot.
 *
 * @param {string} teamType
 * @param {string} language
 * @returns {Array<{name: string, displayName: string, icon: string}>}
 */
export function getDefaultRoles(teamType, language = 'zh-CN') {
  const m = getRolePlayMessages(language);
  const templates = m.roleTemplates;
  const roleNames = TEAM_ROLES[teamType] || TEAM_ROLES.dev;

  return roleNames.map(name => {
    const tmpl = templates[name];
    if (!tmpl) return { name, displayName: name, icon: '' };

    // Extract icon and displayName from heading: "## 📋 PM-乔布斯 (pm)"
    const headingMatch = tmpl.heading.match(/^##\s*(\S+)\s+(.+?)\s*\(([\w-]+)\)\s*$/);
    if (headingMatch) {
      return {
        name: headingMatch[3],
        displayName: headingMatch[2],
        icon: headingMatch[1],
      };
    }
    return { name, displayName: name, icon: '' };
  });
}

/**
 * Get the session directory path.
 * @param {string} projectDir
 * @param {string} sessionName
 * @returns {string} absolute path to .roleplay/roles/{sessionName}/
 */
export function getSessionDir(projectDir, sessionName) {
  return join(projectDir, '.roleplay', 'roles', sessionName);
}
