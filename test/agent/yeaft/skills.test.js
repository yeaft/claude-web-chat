import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSkill, SkillManager } from '../../../agent/yeaft/skills.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-skills-'));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function skill(name, body = '# Instructions') {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseSkill', () => {
  it('accepts leading HTML attribution comments before frontmatter', () => {
    const raw = `<!-- Adapted from example.test (MIT License) -->\n${skill('brainstorming')}`;

    expect(parseSkill(raw, 'SKILL.md')).toMatchObject({
      name: 'brainstorming',
      description: 'brainstorming description',
      content: '# Instructions',
    });
  });

  it('does not accept arbitrary prose before frontmatter', () => {
    expect(parseSkill(`not metadata\n${skill('hidden')}`, 'hidden.md')).toBeNull();
  });
});

describe('SkillManager discovery', () => {
  it('ignores ordinary Markdown documents while loading valid legacy and directory skills', () => {
    const root = tempRoot();
    write(root, 'README.md', '# Skill collection\n');
    write(root, 'personas/README.md', '# Persona guide\n');
    write(root, 'legacy.md', skill('legacy'));
    write(root, 'brainstorming/SKILL.md', `<!-- License notice -->\n${skill('brainstorming')}`);

    const manager = new SkillManager(root);
    const result = manager.load();

    expect(result.errors).toEqual([]);
    expect(manager.list().map(item => item.name).sort()).toEqual(['brainstorming', 'legacy']);
  });

  it('still reports malformed Skill candidates instead of silently ignoring them', () => {
    const root = tempRoot();
    write(root, 'broken/SKILL.md', '# Missing frontmatter\n');
    write(root, 'broken-legacy.md', '---\nname: broken\n');

    const result = new SkillManager(root).load();

    expect(result.errors).toEqual([
      'Failed to parse skill: broken/SKILL.md',
      'Failed to parse skill: broken-legacy.md',
    ]);
  });

  it('applies the same document and attribution rules to secure project Skill roots', () => {
    const workspace = tempRoot();
    const projectSkills = join(workspace, '.yeaft', 'skills');
    write(workspace, '.yeaft/skills/personas/README.md', '# Persona guide\n');
    write(workspace, '.yeaft/skills/brainstorming/SKILL.md', `<!-- License notice -->\n${skill('brainstorming')}`);
    write(workspace, '.yeaft/skills/broken/SKILL.md', '# Missing frontmatter\n');

    const manager = new SkillManager(projectSkills, {
      secureWorkspaceByDir: {
        [projectSkills]: { workspaceRoot: workspace, relativeRoot: '.yeaft/skills' },
      },
    });
    const result = manager.load();

    expect(result.errors).toEqual(['Failed to parse skill: broken/SKILL.md']);
    expect(manager.list().map(item => item.name)).toEqual(['brainstorming']);
  });

  it('loads identical valid skills from layered roots without duplicate parse errors', () => {
    const bundled = tempRoot();
    const user = tempRoot();
    const raw = `<!-- Adapted under MIT -->\n${skill('brainstorming')}`;
    write(bundled, 'brainstorming/SKILL.md', raw);
    write(user, 'brainstorming/SKILL.md', raw);

    const manager = new SkillManager([bundled, user], {
      userDir: user,
      tierByDir: { [bundled]: 'bundled', [user]: 'user' },
    });
    const result = manager.load();

    expect(result).toMatchObject({ loaded: 1, errors: [] });
    expect(manager.get('brainstorming')).toMatchObject({ name: 'brainstorming', _tier: 'user' });
  });
});
