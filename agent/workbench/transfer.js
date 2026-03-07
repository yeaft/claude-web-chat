import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import ctx from '../context.js';

// 临时文件目录名 (不易冲突)
const TEMP_UPLOAD_DIR = '.claude-tmp-attachments';

export async function handleTransferFiles(msg) {
  const { conversationId, files, prompt, workDir, claudeSessionId } = msg;
  const { startClaudeQuery } = await import('../claude.js');

  let state = ctx.conversations.get(conversationId);
  const effectiveWorkDir = workDir || state?.workDir || ctx.CONFIG.workDir;

  // 创建临时目录
  const uploadDir = join(effectiveWorkDir, TEMP_UPLOAD_DIR);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const savedFiles = [];
  const imageFiles = [];

  for (const file of files) {
    try {
      const timestamp = Date.now();
      const ext = extname(file.name);
      const baseName = basename(file.name, ext);
      const uniqueName = `${baseName}_${timestamp}${ext}`;
      const filePath = join(uploadDir, uniqueName);
      const relativePath = join(TEMP_UPLOAD_DIR, uniqueName);

      const buffer = Buffer.from(file.data, 'base64');
      writeFileSync(filePath, buffer);

      const isImage = file.mimeType.startsWith('image/');
      savedFiles.push({
        name: file.name,
        path: relativePath,
        mimeType: file.mimeType,
        isImage
      });

      if (isImage) {
        imageFiles.push({
          mimeType: file.mimeType,
          data: file.data
        });
      }

      console.log(`Saved file: ${relativePath}`);
    } catch (e) {
      console.error(`Error saving file ${file.name}:`, e.message);
    }
  }

  // 如果没有活跃的查询，启动新的
  if (!state || !state.query || !state.inputStream) {
    const resumeSessionId = claudeSessionId || state?.claudeSessionId || null;
    console.log(`[SDK] Starting Claude for ${conversationId} (files), resume: ${resumeSessionId || 'none'}`);
    state = await startClaudeQuery(conversationId, effectiveWorkDir, resumeSessionId);
  }

  // 构造带附件的消息
  const fileListText = savedFiles.map(f =>
    `- ${f.path} (${f.isImage ? '图片' : f.mimeType})`
  ).join('\n');

  const fullPrompt = `用户上传了以下文件：\n${fileListText}\n\n用户说：${prompt}`;

  // 构造 content 数组
  const content = [];

  for (const img of imageFiles) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data
      }
    });
  }

  content.push({
    type: 'text',
    text: fullPrompt
  });

  // 发送用户消息到输入流
  const userMessage = {
    type: 'user',
    message: { role: 'user', content }
  };

  console.log(`[${conversationId}] Sending with ${savedFiles.length} files, ${imageFiles.length} images`);
  state.turnActive = true;
  state.inputStream.enqueue(userMessage);
}
