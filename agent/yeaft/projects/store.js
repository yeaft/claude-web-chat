import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeAtomic } from '../storage/atomic.js';

const PROJECTS_FILE = 'projects.json';
const PROJECTS_VERSION = 1;

export class ProjectStoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProjectStoreError';
    this.code = code;
  }
}

function projectsPath(yeaftDir) {
  return join(yeaftDir, PROJECTS_FILE);
}

function normalizeSessionIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeProject(row, index = 0) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) return null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return null;
  return {
    id: row.id,
    name,
    instruction: typeof row.instruction === 'string' ? row.instruction.trim() : '',
    sessionIds: normalizeSessionIds(row.sessionIds),
    sortOrder: Number.isFinite(row.sortOrder) ? row.sortOrder : index,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}

export function loadProjects(yeaftDir) {
  if (!yeaftDir || !existsSync(projectsPath(yeaftDir))) return [];
  try {
    const parsed = JSON.parse(readFileSync(projectsPath(yeaftDir), 'utf8'));
    const rows = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return rows.map(normalizeProject).filter(Boolean).sort((a, b) => a.sortOrder - b.sortOrder);
  } catch {
    const path = projectsPath(yeaftDir);
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* keep the unreadable file if quarantine fails */ }
    return [];
  }
}

function saveProjects(yeaftDir, projects) {
  if (!yeaftDir) throw new ProjectStoreError('missing_root', 'Yeaft directory is required');
  mkdirSync(yeaftDir, { recursive: true });
  const now = new Date().toISOString();
  const normalized = projects.map(normalizeProject).filter(Boolean).map((project, index) => ({
    ...project,
    sortOrder: index,
    updatedAt: project.updatedAt || now,
  }));
  writeAtomic(projectsPath(yeaftDir), `${JSON.stringify({
    version: PROJECTS_VERSION,
    updatedAt: now,
    projects: normalized,
  }, null, 2)}\n`);
  return normalized;
}

function requireName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new ProjectStoreError('invalid_name', 'Project name is required');
  return name.slice(0, 120);
}

function requireProject(projects, projectId) {
  const project = projects.find(row => row.id === projectId);
  if (!project) throw new ProjectStoreError('not_found', 'Project not found');
  return project;
}

export function createProject(yeaftDir, name) {
  const projects = loadProjects(yeaftDir);
  const now = new Date().toISOString();
  const project = {
    id: `project-${randomUUID().slice(0, 8)}`,
    name: requireName(name),
    instruction: '',
    sessionIds: [],
    sortOrder: projects.length,
    createdAt: now,
    updatedAt: now,
  };
  saveProjects(yeaftDir, [...projects, project]);
  return project;
}

export function renameProject(yeaftDir, projectId, name) {
  const projects = loadProjects(yeaftDir);
  const project = requireProject(projects, projectId);
  project.name = requireName(name);
  project.updatedAt = new Date().toISOString();
  saveProjects(yeaftDir, projects);
  return project;
}

export function updateProjectInstruction(yeaftDir, projectId, instruction) {
  if (typeof instruction !== 'string') {
    throw new ProjectStoreError('invalid_instruction', 'Project instruction must be a string');
  }
  const nextInstruction = instruction.trim();
  if (nextInstruction.length > 20_000) {
    throw new ProjectStoreError('instruction_too_long', 'Project instruction must not exceed 20000 characters');
  }
  const projects = loadProjects(yeaftDir);
  const project = requireProject(projects, projectId);
  project.instruction = nextInstruction;
  project.updatedAt = new Date().toISOString();
  saveProjects(yeaftDir, projects);
  return project;
}

export function deleteProject(yeaftDir, projectId) {
  const projects = loadProjects(yeaftDir);
  requireProject(projects, projectId);
  saveProjects(yeaftDir, projects.filter(row => row.id !== projectId));
  return { projectId };
}

export function reorderProjects(yeaftDir, projectIds) {
  const projects = loadProjects(yeaftDir);
  const ids = Array.isArray(projectIds)
    ? projectIds.map(value => typeof value === 'string' ? value.trim() : '')
    : [];
  const currentIds = new Set(projects.map(project => project.id));
  if (ids.length !== projects.length
      || ids.some(id => !id || !currentIds.has(id))
      || new Set(ids).size !== ids.length) {
    throw new ProjectStoreError('invalid_project_order', 'Complete Project order is required');
  }
  const projectsById = new Map(projects.map(project => [project.id, project]));
  return saveProjects(yeaftDir, ids.map(id => projectsById.get(id)));
}

export function moveSessionToProject(yeaftDir, sessionId, projectId = null) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) throw new ProjectStoreError('invalid_session_id', 'Session id is required');
  const projects = loadProjects(yeaftDir);
  const target = projectId ? requireProject(projects, projectId) : null;
  for (const project of projects) {
    project.sessionIds = project.sessionIds.filter(value => value !== id);
  }
  if (target) target.sessionIds.push(id);
  saveProjects(yeaftDir, projects);
  return { sessionId: id, projectId: target?.id || null };
}

export function removeSessionFromProjects(yeaftDir, sessionId) {
  const projects = loadProjects(yeaftDir);
  let changed = false;
  for (const project of projects) {
    const next = project.sessionIds.filter(id => id !== sessionId);
    if (next.length !== project.sessionIds.length) changed = true;
    project.sessionIds = next;
  }
  if (changed) saveProjects(yeaftDir, projects);
  return changed;
}

export function findProjectForSession(yeaftDir, sessionId) {
  return loadProjects(yeaftDir).find(project => project.sessionIds.includes(sessionId)) || null;
}

export function sharedSessionIdsForProject(yeaftDir, sessionId) {
  const project = findProjectForSession(yeaftDir, sessionId);
  return project ? project.sessionIds.filter(id => id !== sessionId) : [];
}
