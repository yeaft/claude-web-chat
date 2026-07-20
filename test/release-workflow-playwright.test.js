import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);

function workflowFiles() {
  return readdirSync(workflowsDir)
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
}

function workflowJobs(source) {
  const lines = source.split('\n');
  const jobs = [];
  let current = null;
  let insideJobs = false;

  for (const line of lines) {
    if (line === 'jobs:') {
      insideJobs = true;
      continue;
    }
    if (!insideJobs) continue;

    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      current = { name: jobMatch[1], source: '' };
      jobs.push(current);
      continue;
    }
    if (/^[^\s#]/.test(line)) break;
    if (current) current.source += `${line}\n`;
  }

  return jobs;
}

describe('GitHub workflow browser test prerequisites', () => {
  it('installs the locked Playwright Chromium inside every job that runs npm test', () => {
    const testJobs = [];

    for (const file of workflowFiles()) {
      const source = readFileSync(new URL(file, workflowsDir), 'utf8');
      for (const job of workflowJobs(source)) {
        const testIndex = job.source.indexOf('run: npm test');
        if (testIndex === -1) continue;

        const dependencyIndex = job.source.indexOf('run: npm ci');
        const browserIndex = job.source.indexOf(
          'run: npx playwright install --with-deps chromium',
        );
        testJobs.push(`${file}:${job.name}`);

        expect(dependencyIndex, `${file}:${job.name} must install dependencies`).toBeGreaterThan(-1);
        expect(browserIndex, `${file}:${job.name} must install Chromium after npm ci`).toBeGreaterThan(
          dependencyIndex,
        );
        expect(testIndex, `${file}:${job.name} must run tests after installing Chromium`).toBeGreaterThan(
          browserIndex,
        );
      }
    }

    expect(testJobs).toEqual([
      'ci.yml:test',
      'dev-release.yml:test',
      'release.yml:test',
    ]);
  });
});
