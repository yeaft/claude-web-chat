/**
 * Crew — Task 文件管理（系统自动管理）
 * ensureTaskFile, appendTaskRecord, readTaskFile, parseCompletedTasks,
 * updateFeatureIndex, appendChangelog
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { getMessages } from '../crew-i18n.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 自动创建 task 进度文件
 */
export async function ensureTaskFile(session, taskId, taskTitle, assignee, summary) {
  const featuresDir = join(session.sharedDir, 'context', 'features');
  const filePath = join(featuresDir, `${taskId}.md`);

  try {
    await fs.access(filePath);
    // 文件已存在，不覆盖
    return;
  } catch {
    // 文件不存在，创建
  }

  await fs.mkdir(featuresDir, { recursive: true });

  const m = getMessages(session.language || 'zh-CN');
  const now = new Date().toISOString();
  const content = `# ${m.featureLabel}: ${taskTitle}
- task-id: ${taskId}
- ${m.statusPending}
- ${m.assigneeLabel}: ${assignee}
- ${m.createdAtLabel}: ${now}

${m.requirementDesc}
${summary}

${m.workRecord}
`;

  await fs.writeFile(filePath, content);

  // 同步到 session.features
  if (!session.features.has(taskId)) {
    session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
  }

  console.log(`[Crew] Task file created: ${taskId} (${taskTitle})`);

  // 更新 feature 索引
  updateFeatureIndex(session).catch(e => console.warn('[Crew] Failed to update feature index:', e.message));
}

/**
 * 追加工作记录到 task 文件
 */
export async function appendTaskRecord(session, taskId, roleName, summary) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);

  try {
    await fs.access(filePath);
  } catch {
    // 文件不存在，跳过
    return;
  }

  const role = session.roles.get(roleName);
  const label = role ? roleLabel(role) : roleName;
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const record = `\n### ${label} - ${now}\n${summary}\n`;

  await fs.appendFile(filePath, record);
  console.log(`[Crew] Task record appended: ${taskId} by ${roleName}`);
}

/**
 * 读取 task 文件内容（用于注入上下文）
 */
export async function readTaskFile(session, taskId) {
  const filePath = join(session.sharedDir, 'context', 'features', `${taskId}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 从 TASKS block 文本中提取已完成任务的 taskId 集合
 */
export function parseCompletedTasks(text) {
  const ids = new Set();
  const match = text.match(/---TASKS---([\s\S]*?)---END_TASKS---/);
  if (!match) return ids;
  for (const line of match[1].split('\n')) {
    const m = line.match(/^-\s*\[[xX]\]\s*.+#(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * 更新 feature 索引文件 context/features/index.md
 */
export async function updateFeatureIndex(session) {
  const featuresDir = join(session.sharedDir, 'context', 'features');
  await fs.mkdir(featuresDir, { recursive: true });

  const m = getMessages(session.language || 'zh-CN');
  const completed = session._completedTaskIds || new Set();
  const allFeatures = Array.from(session.features.values());

  allFeatures.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const inProgress = allFeatures.filter(f => !completed.has(f.taskId));
  const done = allFeatures.filter(f => completed.has(f.taskId));

  const locale = (session.language === 'en') ? 'en-US' : 'zh-CN';
  const now = new Date().toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
  let content = `${m.featureIndex}\n> ${m.lastUpdated}: ${now}\n`;

  content += `\n${m.inProgressGroup(inProgress.length)}\n`;
  if (inProgress.length > 0) {
    content += `| ${m.colTaskId} | ${m.colTitle} | ${m.colCreatedAt} |\n|---------|------|----------|\n`;
    for (const f of inProgress) {
      const date = f.createdAt ? new Date(f.createdAt).toLocaleDateString(locale) : '-';
      content += `| ${f.taskId} | ${f.taskTitle} | ${date} |\n`;
    }
  }

  content += `\n${m.completedGroup(done.length)}\n`;
  if (done.length > 0) {
    content += `| ${m.colTaskId} | ${m.colTitle} | ${m.colCreatedAt} |\n|---------|------|----------|\n`;
    for (const f of done) {
      const date = f.createdAt ? new Date(f.createdAt).toLocaleDateString(locale) : '-';
      content += `| ${f.taskId} | ${f.taskTitle} | ${date} |\n`;
    }
  }

  await fs.writeFile(join(featuresDir, 'index.md'), content);
  console.log(`[Crew] Feature index updated: ${inProgress.length} in progress, ${done.length} completed`);
}

/**
 * 追加完成汇总到 context/changelog.md
 */
export async function appendChangelog(session, taskId, taskTitle) {
  const contextDir = join(session.sharedDir, 'context');
  await fs.mkdir(contextDir, { recursive: true });
  const changelogPath = join(contextDir, 'changelog.md');

  const m = getMessages(session.language || 'zh-CN');

  // 读取 feature 文件提取最后一条工作记录作为摘要
  const taskContent = await readTaskFile(session, taskId);
  let summaryText = '';
  if (taskContent) {
    const records = taskContent.split(/\n### /);
    if (records.length > 1) {
      const lastRecord = records[records.length - 1];
      const lines = lastRecord.split('\n');
      summaryText = lines.slice(1).join('\n').trim();
    }
  }
  if (!summaryText) {
    summaryText = m.noSummary;
  }

  // 限制摘要长度
  if (summaryText.length > 500) {
    summaryText = summaryText.substring(0, 497) + '...';
  }

  const locale = (session.language === 'en') ? 'en-US' : 'zh-CN';
  const now = new Date().toLocaleString(locale, { timeZone: 'Asia/Shanghai' });
  const entry = `\n## ${taskId}: ${taskTitle}\n- ${m.completedAt}: ${now}\n- ${m.summaryLabel}: ${summaryText}\n`;

  let exists = false;
  try {
    await fs.access(changelogPath);
    exists = true;
  } catch {}

  if (!exists) {
    await fs.writeFile(changelogPath, `${m.changelogTitle}\n${entry}`);
  } else {
    await fs.appendFile(changelogPath, entry);
  }

  console.log(`[Crew] Changelog appended: ${taskId} (${taskTitle})`);
}
