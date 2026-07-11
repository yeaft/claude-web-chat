import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkCenterSettings, writeWorkCenterSettings } from '../../../../agent/yeaft/work-center/settings.js';
import {
  defaultWorkCenterSettings,
  normalizeWorkCenterSettings,
  resolveWorkflowSnapshot,
} from '../../../../agent/yeaft/work-center/workflow.js';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'work-center-settings-'));
  dirs.push(dir);
  return dir;
}

function runConcurrentWriters(dir, count) {
  const worker = `
    import { readWorkCenterSettings, writeWorkCenterSettings } from ${JSON.stringify(new URL('../../../../agent/yeaft/work-center/settings.js', import.meta.url).href)};
    const [dir, marker] = process.argv.slice(1);
    const settings = readWorkCenterSettings(dir);
    settings.defaultWorkDir = marker;
    process.send({ ready: true });
    process.on('message', message => {
      if (message !== 'start') return;
      try {
        const saved = writeWorkCenterSettings(dir, settings);
        process.send({ ok: true, revision: saved.revision, marker });
      } catch (error) {
        process.send({ ok: false, error: error.message, marker });
      }
    });
  `;
  return new Promise((resolve, reject) => {
    const children = [];
    const results = [];
    let readyCount = 0;
    const timeout = setTimeout(() => {
      for (const child of children) child.kill();
      reject(new Error('Concurrent Work Center settings writers timed out'));
    }, 15_000);
    const finish = () => {
      if (results.length !== count) return;
      clearTimeout(timeout);
      Promise.all(children.map(child => new Promise(done => {
        if (child.exitCode !== null) done();
        else child.once('exit', done);
        child.disconnect();
      }))).then(() => resolve(results), reject);
    };
    for (let index = 0; index < count; index++) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, dir, `writer-${index}`], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      children.push(child);
      child.once('error', reject);
      child.on('message', result => {
        if (result?.ready) {
          readyCount += 1;
          if (readyCount === count) {
            for (const readyChild of children) readyChild.send('start');
          }
          return;
        }
        results.push(result);
        finish();
      });
    }
  });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('Work Center settings', () => {
  it('returns independent default settings when no file exists', () => {
    const dir = tempDir();
    const first = readWorkCenterSettings(dir);
    first.workflows[0].name = 'mutated';
    expect(readWorkCenterSettings(dir).workflows[0].name).toBe('Software change');
  });

  it('materializes the executable default prompt for every workflow stage', () => {
    const settings = defaultWorkCenterSettings();
    const prompts = Object.fromEntries(settings.workflows[0].stages.map(stage => [stage.type, stage.instruction]));
    expect(prompts.triage).toContain('Do not implement yet');
    expect(prompts.implement).toContain('Implement the smallest correct change');
    expect(prompts.review).toContain('changes_requested');
    expect(prompts.deliver).toContain('repository release policy');

    settings.workflows[0].stages[0].instruction = '  ';
    expect(normalizeWorkCenterSettings(settings).workflows[0].stages[0].instruction)
      .toContain('Do not implement yet');
  });

  it('normalizes and atomically persists workflow policies', () => {
    const dir = tempDir();
    const settings = defaultWorkCenterSettings();
    settings.defaultWorkDir = ' /project ';
    settings.workflows[0].stages[1].assignmentPolicy = {
      mode: 'pool', capability: 'javascript', candidateVpIds: ['linus', 'linus', 'grace'],
      fixedVpId: null, separateFromStageTypes: [],
    };
    const saved = writeWorkCenterSettings(dir, settings);
    expect(saved.defaultWorkDir).toBe('/project');
    expect(saved.revision).toBe(2);
    expect(saved.workflows[0].stages[1].assignmentPolicy.candidateVpIds).toEqual(['linus', 'grace']);
    const file = join(dir, 'work-center', 'settings.json');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/\n$/);
    expect(readWorkCenterSettings(dir)).toEqual(saved);
  });

  it('rejects invalid fixed, pool, duplicate, and review-return policies', () => {
    const base = defaultWorkCenterSettings();
    base.workflows[0].stages[0].assignmentPolicy = { mode: 'fixed' };
    expect(() => normalizeWorkCenterSettings(base)).toThrow(/fixedVpId/);

    const duplicate = defaultWorkCenterSettings();
    duplicate.workflows.push(duplicate.workflows[0]);
    expect(() => normalizeWorkCenterSettings(duplicate)).toThrow(/Duplicate Work Center workflow/);

    const review = defaultWorkCenterSettings();
    review.workflows[0].stages.find(stage => stage.type === 'review').changesRequestedStageId = 'missing';
    expect(() => normalizeWorkCenterSettings(review)).toThrow(/missing stage/);

    const selfReview = defaultWorkCenterSettings();
    selfReview.workflows[0].stages.find(stage => stage.type === 'review').changesRequestedStageId = 'review';
    expect(() => normalizeWorkCenterSettings(selfReview)).toThrow(/earlier editable stage/);

    const futureReview = defaultWorkCenterSettings();
    futureReview.workflows[0].stages.find(stage => stage.type === 'review').changesRequestedStageId = 'deliver';
    expect(() => normalizeWorkCenterSettings(futureReview)).toThrow(/earlier editable stage/);
  });

  it('rejects stale concurrent settings updates', () => {
    const dir = tempDir();
    const first = readWorkCenterSettings(dir);
    const second = readWorkCenterSettings(dir);
    expect(writeWorkCenterSettings(dir, first).revision).toBe(2);
    expect(() => writeWorkCenterSettings(dir, second)).toThrow(/changed elsewhere/);
  });

  it('allows only one process to save the same settings revision', async () => {
    const dir = tempDir();
    const results = await runConcurrentWriters(dir, 12);
    const succeeded = results.filter(result => result.ok);
    const rejected = results.filter(result => !result.ok);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].revision).toBe(2);
    expect(rejected).toHaveLength(11);
    expect(rejected.every(result => /changed elsewhere/.test(result.error))).toBe(true);
    expect(readWorkCenterSettings(dir)).toMatchObject({
      revision: 2,
      defaultWorkDir: succeeded[0].marker,
    });
    expect(readdirSync(join(dir, 'work-center')).some(name => name.includes('.tmp-'))).toBe(false);
  });

  it('reports corrupt settings instead of silently replacing them', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'work-center'), { recursive: true });
    writeFileSync(join(dir, 'work-center', 'settings.json'), '{broken');
    expect(() => readWorkCenterSettings(dir)).toThrow(/Failed to read Work Center settings/);
  });

  it('applies stage overrides to a detached workflow snapshot', () => {
    const settings = defaultWorkCenterSettings();
    const snapshot = resolveWorkflowSnapshot(settings, 'software-change', {
      implement: {
        assignmentPolicy: { mode: 'fixed', fixedVpId: 'grace' },
        modelPolicy: { mode: 'specific', model: 'provider/model', effort: 'high' },
      },
    });
    const implement = snapshot.stages.find(stage => stage.id === 'implement');
    expect(implement.assignmentPolicy).toMatchObject({ mode: 'fixed', fixedVpId: 'grace' });
    expect(implement.modelPolicy).toEqual({ mode: 'specific', model: 'provider/model', effort: 'high' });
    expect(settings.workflows[0].stages.find(stage => stage.id === 'implement').assignmentPolicy.mode).toBe('auto');
  });
});
