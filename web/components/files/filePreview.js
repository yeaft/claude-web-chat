/**
 * filePreview — File preview composable for FilesTab.
 * Manages Markdown preview/rendering, Mermaid diagrams, Office/PDF/Image preview.
 */
import { renderMermaidIn } from '../../utils/markdown.js';
import { isMarkdownFile } from './fileEditor.js';

export function createFilePreview(activeFile, { editorContainer, createEditor, t }) {
  const mdPreviewMode = Vue.ref(true);
  const mdPreviewRef = Vue.ref(null);
  const officePreviewContainer = Vue.ref(null);

  const isActiveMarkdown = Vue.computed(() => {
    const f = activeFile.value;
    return !!(f && isMarkdownFile(f.name));
  });

  const mdRenderedHtml = Vue.computed(() => {
    const f = activeFile.value;
    if (!f || !isMarkdownFile(f.name) || f.content == null) return '';
    try {
      if (typeof marked !== 'undefined') {
        return marked.parse(f.content);
      }
    } catch (e) {
      console.error('Markdown parse error:', e);
    }
    return '<pre>' + (f.content || '') + '</pre>';
  });

  function initMermaid() {
    renderMermaidIn(mdPreviewRef.value);
  }

  async function renderMermaidBlocks() {
    await renderMermaidIn(mdPreviewRef.value);
  }

  function switchToMdEdit() {
    mdPreviewMode.value = false;
    Vue.nextTick(() => {
      const file = activeFile.value;
      if (file && editorContainer.value) createEditor(file);
    });
  }

  let officeRenderGeneration = 0;
  const fileRenderGenerations = new WeakMap();

  const isSameFile = (left, right) => left === right || (
    typeof Vue.toRaw === 'function' && Vue.toRaw(left) === Vue.toRaw(right)
  );

  const renderOfficeLocal = async (file) => {
    const liveContainer = officePreviewContainer.value;
    if (!liveContainer || !file._arrayBuffer) return false;

    const generation = ++officeRenderGeneration;
    fileRenderGenerations.set(file, generation);
    file.previewLoading = true;
    const ownerDocument = liveContainer.ownerDocument || globalThis.document;
    const attemptContainer = ownerDocument?.createElement
      ? ownerDocument.createElement('div')
      : { innerHTML: '' };
    const ext = ('.' + file.name.split('.').pop()).toLowerCase();
    let workbook = null;
    const isLatestFileRender = () => fileRenderGenerations.get(file) === generation;
    const canCommit = () => generation === officeRenderGeneration
      && isLatestFileRender()
      && isSameFile(activeFile.value, file)
      && officePreviewContainer.value === liveContainer;

    try {
      if (ext === '.docx' && window.docx) {
        await window.docx.renderAsync(file._arrayBuffer, attemptContainer, null, {
          className: 'docx-preview-content',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true
        });
      } else if (ext === '.xlsx' || ext === '.xls') {
        workbook = XLSX.read(file._arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName], { editable: false });
        attemptContainer.innerHTML = '<div class="xlsx-sheet-tabs">' +
          workbook.SheetNames.map((n, i) => `<button class="xlsx-sheet-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${n}</button>`).join('') +
          '</div><div class="xlsx-table-wrap">' + html + '</div>';
      } else if (ext === '.pptx' || ext === '.ppt') {
        attemptContainer.innerHTML = '<div class="preview-unsupported">' + (t ? t('files.pptxNotSupported') : 'PowerPoint preview not supported') + '</div>';
      }

      if (!canCommit()) return false;
      if (typeof liveContainer.replaceChildren === 'function' && attemptContainer.childNodes) {
        liveContainer.replaceChildren(...attemptContainer.childNodes);
      } else {
        liveContainer.innerHTML = attemptContainer.innerHTML;
      }
      if (workbook) {
        liveContainer.querySelectorAll('.xlsx-sheet-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const sheetName = workbook.SheetNames[idx];
            const html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName], { editable: false });
            liveContainer.querySelector('.xlsx-table-wrap').innerHTML = html;
            liveContainer.querySelectorAll('.xlsx-sheet-tab').forEach(tab => tab.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      }
      return true;
    } catch (e) {
      if (isLatestFileRender()) file.previewError = e.message;
      return false;
    } finally {
      if (isLatestFileRender()) file.previewLoading = false;
    }
  };

  return {
    mdPreviewMode, mdPreviewRef, officePreviewContainer,
    isActiveMarkdown, mdRenderedHtml,
    initMermaid, renderMermaidBlocks, switchToMdEdit, renderOfficeLocal
  };
}
