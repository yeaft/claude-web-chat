/**
 * Crew Context Loader — detect and parse .crew/ directory structure.
 *
 * Reads .crew/CLAUDE.md, session.json, per-role CLAUDE.md files,
 * kanban, and feature files. Used by the frontend to detect whether
 * a project has a Crew setup and display role metadata.
 */

import { join } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';
import ctx from '../context.js';

const MAX_CLAUDE_MD_LEN = 8192;

/**
 * Read a file, returning null on any error.
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileOrNull(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Deduplicate Crew roles by roleType.
 * Crew may have dev-1, dev-2, dev-3 — collapse to a single "dev" entry.
 * Attaches per-role CLAUDE.md content.
 */
function deduplicateRoles(sessionRoles, roleClaudes) {
  const byType = new Map();
  const merged = [];

  for (const r of sessionRoles) {
    const type = r.roleType || r.name;
    const claudeMd = roleClaudes[r.name] || '';

    if (byType.has(type)) continue;
    byType.set(type, true);

    const name = type;
    let displayName = r.displayName || name;
    displayName = displayName.replace(/-\d+$/, '');

    merged.push({
      name,
      displayName,
      icon: r.icon || '',
      description: r.description || '',
      claudeMd: claudeMd.substring(0, MAX_CLAUDE_MD_LEN),
      roleType: type,
      isDecisionMaker: !!r.isDecisionMaker,
    });
  }

  return merged;
}

/**
 * Load .crew context from a project directory.
 * Returns null if .crew/ doesn't exist.
 */
export function loadCrewContext(projectDir) {
  const crewDir = join(projectDir, '.crew');
  if (!existsSync(crewDir)) return null;

  // 1. Shared CLAUDE.md
  const sharedClaudeMd = readFileOrNull(join(crewDir, 'CLAUDE.md')) || '';

  // 2. session.json → roles, teamType, language, features
  let sessionRoles = [];
  let teamType = 'dev';
  let language = 'zh-CN';
  let sessionFeatures = [];
  const sessionPath = join(crewDir, 'session.json');
  const sessionJson = readFileOrNull(sessionPath);
  if (sessionJson) {
    try {
      const session = JSON.parse(sessionJson);
      if (Array.isArray(session.roles)) sessionRoles = session.roles;
      if (session.teamType) teamType = session.teamType;
      if (session.language) language = session.language;
      if (Array.isArray(session.features)) sessionFeatures = session.features;
    } catch {
      // Invalid JSON — ignore
    }
  }

  // 3. Per-role CLAUDE.md from .crew/roles/*/CLAUDE.md
  const roleClaudes = {};
  const rolesDir = join(crewDir, 'roles');
  if (existsSync(rolesDir)) {
    try {
      const roleDirs = readdirSync(rolesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const dirName of roleDirs) {
        const md = readFileOrNull(join(rolesDir, dirName, 'CLAUDE.md'));
        if (md) roleClaudes[dirName] = md;
      }
    } catch {
      // Permission error or similar — ignore
    }
  }

  // 4. Merge roles: deduplicate by roleType, attach claudeMd
  const roles = deduplicateRoles(sessionRoles, roleClaudes);

  // 5. Kanban
  const kanban = readFileOrNull(join(crewDir, 'context', 'kanban.md')) || '';

  // 6. Feature files from context/features/*.md
  const features = [];
  const featuresDir = join(crewDir, 'context', 'features');
  if (existsSync(featuresDir)) {
    try {
      const files = readdirSync(featuresDir)
        .filter(f => f.endsWith('.md') && f !== 'index.md')
        .sort();
      for (const f of files) {
        const content = readFileOrNull(join(featuresDir, f));
        if (content) {
          features.push({ name: f.replace('.md', ''), content });
        }
      }
    } catch {
      // ignore
    }
  }

  return { sharedClaudeMd, roles, kanban, features, teamType, language, sessionFeatures };
}

/**
 * Handle check_crew_context message — check if a project has .crew/ setup
 * and return role metadata for the frontend.
 */
export function handleCheckCrewContext(msg) {
  const { projectDir, requestId } = msg;
  if (!projectDir) {
    ctx.sendToServer({ type: 'crew_context_result', requestId, found: false });
    return;
  }
  const crewContext = loadCrewContext(projectDir);
  if (!crewContext) {
    ctx.sendToServer({ type: 'crew_context_result', requestId, found: false });
    return;
  }
  // Return a safe subset for the frontend (no full claudeMd content, just metadata)
  ctx.sendToServer({
    type: 'crew_context_result',
    requestId,
    found: true,
    roles: crewContext.roles.map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      roleType: r.roleType,
      isDecisionMaker: r.isDecisionMaker,
      hasClaudeMd: !!(r.claudeMd && r.claudeMd.length > 0),
    })),
    teamType: crewContext.teamType,
    language: crewContext.language,
    featureCount: crewContext.features.length,
  });
}
