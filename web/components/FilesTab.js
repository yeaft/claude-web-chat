import { getFileIconSvg, getFolderIconSvg } from '../utils/fileIcons.js';

export default {
  name: 'FilesTab',
  template: `
    <div class="files-tab file-two-col" ref="rootEl">
      <!-- 左栏: 层级目录树 -->
      <div class="file-col-tree" :class="{ 'drop-active': externalDropActive }" :style="{ flex: '0 0 ' + treePanelWidth + 'px', transition: isTreeResizing ? 'none' : undefined, fontSize: fontSize + 'px' }" @wheel.ctrl.prevent="onWheel"
        @dragover.prevent="onTreeDragOver($event)"
        @dragleave="onTreeDragLeave($event)"
        @drop.prevent="onTreeDrop($event)"
      >
        <!-- VS Code 风格 Header: 路径输入模式 -->
        <div class="file-tree-header" v-if="editingTreePath">
          <input
            ref="treePathInputRef"
            v-model="treePath"
            :placeholder="$t('files.enterPath')"
            @keypress.enter="confirmTreePath"
            @keydown.escape="cancelTreePathEdit"
            @blur="cancelTreePathEdit"
            class="tree-path-input"
          />
        </div>
        <!-- VS Code 风格 Header: 正常模式 -->
        <div class="file-tree-header vscode-header" v-else>
          <div class="vscode-folder-row" @click="toggleRootExpand">
            <span class="tree-arrow root-arrow" v-if="treeRootPath">
              <svg v-if="rootExpanded" viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M3.5 5.5L8 10l4.5-4.5z"/></svg>
              <svg v-else viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z"/></svg>
            </span>
            <span class="vscode-folder-name" :title="treeRootPath || $t('files.notLoaded')">{{ rootFolderName }}</span>
            <div class="vscode-folder-actions" v-if="treeRootPath" @click.stop>
              <button class="vscode-action-btn" @click="showNewFileDialog('file')" :title="$t('files.newFile')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="showNewFileDialog('directory')" :title="$t('files.newFolder')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="loadRootDirectory" :title="$t('common.refresh')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="collapseAll" :title="$t('files.collapseAll')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 18.59L8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z"/></svg>
              </button>
              <button class="vscode-action-btn" @click="openFolderPicker" :title="$t('files.openFolder')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>
              </button>
            </div>
          </div>
        </div>
        <!-- 文件选中操作 -->
        <div class="file-ops-toolbar" v-if="selectedPaths.size > 0">
          <button class="wb-btn-sm file-op-danger" @click="deleteSelected" :title="$t('files.deleteSelected')" :disabled="fileOperating">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            {{ selectedPaths.size }}
          </button>
          <button class="wb-btn-sm" @click="openMoveDialog" :title="$t('files.moveSelected')" :disabled="fileOperating">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12l-4-4h3V10h2v4h3l-4 4z"/></svg>
          </button>
          <button class="wb-btn-sm" @click="clearSelection" :title="$t('files.clearSelection')">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <!-- 操作反馈 -->
        <div v-if="fileOpFeedback" class="file-op-feedback" :class="fileOpFeedback.ok ? 'success' : 'error'">
          {{ fileOpFeedback.message }}
        </div>
        <!-- 文件搜索行 -->
        <div class="file-search-row">
          <input v-model="searchQuery" @input="onSearchInput" placeholder="Search files... (Ctrl+P)" class="file-search-input" />
          <button v-if="searchQuery" class="file-search-clear" @click="clearSearch">&times;</button>
        </div>
        <div class="file-tree-content">
          <!-- 搜索结果模式 -->
          <template v-if="searchQuery && searchResults.length > 0">
            <div
              v-for="r in searchResults" :key="r.fullPath"
              class="tree-item tree-file file-search-result-item"
              @click="onSearchResultClick(r)"
            >
              <span class="tree-icon" v-html="r.type === 'directory' ? getFolderIcon(false) : getFileIconHtml(r.name)"></span>
              <span class="tree-name">{{ r.name }}</span>
              <span class="file-search-result-path">{{ r.path }}</span>
            </div>
          </template>
          <template v-else-if="searchQuery && searchResults.length === 0 && !searchLoading">
            <div class="tree-empty">{{ $t('files.noMatch') }}</div>
          </template>
          <template v-else-if="searchQuery && searchLoading">
            <div class="file-tree-loading">{{ $t('files.searching') }}</div>
          </template>
          <!-- 正常树模式 -->
          <template v-else>
            <div class="file-tree-loading" v-if="treeNodes[treeRootPath]?.loading">{{ $t('files.loadingTree') }}</div>
            <div class="file-tree-list" v-else>
              <div
                v-for="entry in flattenedTree"
                :key="entry.path"
                class="tree-item"
                :class="{
                  'tree-dir': entry.type === 'directory',
                  'tree-file': entry.type === 'file',
                  'tree-expanded': entry.type === 'directory' && treeNodes[entry.path]?.expanded,
                  'tree-selected': selectedPaths.has(entry.path),
                  'drag-over': dragState.dropTarget === entry.path && entry.type === 'directory'
                }"
                :style="{ paddingLeft: (8 + entry.depth * 16) + 'px' }"
                @click="onTreeItemClick(entry, $event)"
                @contextmenu.prevent="showContextMenu($event, entry)"
                draggable="true"
                @dragstart="onDragStart($event, entry)"
                @dragover.prevent="onDragOver($event, entry)"
                @dragleave="onDragLeave($event)"
                @drop.prevent="onDrop($event, entry)"
              >
                <span class="tree-arrow" v-if="entry.type === 'directory'">
                  <svg v-if="treeNodes[entry.path]?.expanded" viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M3.5 5.5L8 10l4.5-4.5z"/></svg>
                  <svg v-else viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z"/></svg>
                </span>
                <span class="tree-arrow tree-arrow-spacer" v-else></span>
                <span class="tree-icon" v-html="entry.type === 'directory' ? getFolderIcon(treeNodes[entry.path]?.expanded) : getFileIconHtml(entry.name)"></span>
                <span class="tree-name">{{ entry.name }}</span>
                <span class="tree-size" v-if="entry.type === 'file' && selectedPaths.size === 0">{{ formatSize(entry.size) }}</span>
                <span class="tree-file-actions" v-if="selectedPaths.size === 0">
                  <button class="tree-action-btn" @click.stop="deleteSingleFile(entry)" :title="$t('common.delete')">
                    <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                  </button>
                </span>
              </div>
              <div class="tree-empty" v-if="flattenedTree.length === 0 && treeRootPath && !treeNodes[treeRootPath]?.loading">
                {{ $t('files.emptyDir') }}
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 拖拽分割线 -->
      <div class="file-tree-splitter" @mousedown="startTreeResize"></div>

      <!-- 右栏: 文件编辑器（带标签页） -->
      <div class="file-col-content" v-if="openFiles.length > 0 || fileLoading" @wheel.ctrl.prevent="onWheel">
        <div class="file-tabs-bar" v-if="openFiles.length > 0">
          <div
            v-for="(file, index) in openFiles" :key="file.path"
            class="file-tab"
            :class="{ active: index === activeFileIndex }"
            :title="file.path"
            @click="switchToTab(index)"
          >
            <span class="file-tab-dirty" v-if="file.isDirty" :title="$t('files.unsaved')">●</span>
            <span class="file-tab-name">{{ file.name }}</span>
            <button class="file-tab-close" @click.stop="closeFileTab(index)" :title="$t('common.close')">&times;</button>
          </div>
          <div class="file-tabs-actions">
            <button class="zoom-btn" @click="zoomOut" :title="$t('git.zoomOut')">−</button>
            <span class="zoom-label">{{ fontSize }}</span>
            <button class="zoom-btn" @click="zoomIn" :title="$t('git.zoomIn')">+</button>
            <button class="file-action-btn" :class="{ active: activeFile?.isDirty }" @click="saveFile" :disabled="!activeFile?.isDirty || fileSaving" :title="$t('common.save') + ' (Ctrl+S)'">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            </button>
          </div>
        </div>
        <div v-if="fileLoading && (activeFileIndex < 0 || !activeFile)" class="git-loading" style="padding:16px">
          <span class="spinner-mini"></span> {{ $t('files.loadingFile') }}<span v-if="debugStatus" style="margin-left:8px;font-size:10px;color:var(--text-muted)">{{ debugStatus }}</span>
        </div>
        <template v-else-if="activeFile">
          <div v-if="debugStatus" style="padding:4px 8px;font-size:11px;color:var(--text-muted);background:var(--bg-sidebar);border-bottom:1px solid var(--border-color)">{{ debugStatus }}</div>
          <!-- 文本文件: CodeMirror 编辑器 -->
          <template v-if="!activeFile.fileType || activeFile.fileType === 'text'">
          <!-- 搜索/替换栏 -->
          <div class="find-replace-bar" v-if="findBarVisible">
            <div class="find-row">
              <input
                ref="findInputRef"
                class="find-input"
                v-model="findQuery"
                :placeholder="$t('files.searchPlaceholder')"
                @input="onFindInput"
                @keydown.enter.exact.prevent="findNext"
                @keydown.enter.shift.prevent="findPrev"
                @keydown.escape.prevent="closeFindBar"
              />
              <span class="find-count" v-if="findQuery">{{ findMatchIndex >= 0 ? (findMatchIndex + 1) : 0 }}/{{ findMatchCount }}</span>
              <button class="find-btn" @click="findPrev" :title="$t('files.findPrev')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
              </button>
              <button class="find-btn" @click="findNext" :title="$t('files.findNext')">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
              </button>
              <label class="find-option" :title="$t('files.caseSensitive')">
                <input type="checkbox" v-model="findCaseSensitive" @change="onFindInput" /> Aa
              </label>
              <label class="find-option" :title="$t('files.regex')">
                <input type="checkbox" v-model="findUseRegex" @change="onFindInput" /> .*
              </label>
              <button class="find-btn" @click="toggleReplaceBar" :title="$t('files.replace') + ' (Ctrl+R)'">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M11 6c1.38 0 2.63.56 3.54 1.46L12 10h6V4l-2.05 2.05A6.976 6.976 0 0011 4c-3.53 0-6.43 2.61-6.92 6H6.1A5.002 5.002 0 0111 6zm5.64 9.14A6.98 6.98 0 0011 20c-3.53 0-6.43-2.61-6.92-6h2.02A5.002 5.002 0 0011 18c1.38 0 2.63-.56 3.54-1.46L12 14h6v6l-2.05-2.05c-.27.3-.56.57-.88.82l.57.57z"/></svg>
              </button>
              <button class="find-btn" @click="closeFindBar" :title="$t('common.close') + ' (Esc)'">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <div class="find-row" v-if="replaceBarVisible">
              <input
                ref="replaceInputRef"
                class="find-input"
                v-model="replaceQuery"
                :placeholder="$t('files.replacePlaceholder')"
                @keydown.enter.prevent="replaceOne"
                @keydown.escape.prevent="closeFindBar"
              />
              <button class="find-btn find-btn-text" @click="replaceOne" :title="$t('files.replaceCurrent')">{{ $t('files.replace') }}</button>
              <button class="find-btn find-btn-text" @click="replaceAll" :title="$t('files.replaceAllTitle')">{{ $t('files.replaceAll') }}</button>
            </div>
          </div>
          <div ref="editorContainer" class="file-editor-container"></div>
          </template>
          <!-- Office 文件预览 -->
          <div v-else-if="activeFile.fileType === 'office'" class="file-preview-container">
            <div v-if="activeFile.previewLoading" class="preview-loading">
              <span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}
            </div>
            <iframe v-else-if="activeFile.previewUrl" :src="activeFile.previewUrl" class="file-preview-iframe" allowfullscreen></iframe>
            <div v-else-if="activeFile.localPreviewReady" ref="officePreviewContainer" class="office-local-preview"></div>
            <div v-else-if="activeFile.previewError" class="preview-error">{{ activeFile.previewError }}</div>
          </div>
          <!-- PDF 预览 -->
          <div v-else-if="activeFile.fileType === 'pdf'" class="file-preview-container">
            <div v-if="!activeFile.blobUrl" class="preview-loading"><span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}</div>
            <iframe v-else :src="activeFile.blobUrl" class="file-preview-iframe"></iframe>
          </div>
          <!-- 图片预览 -->
          <div v-else-if="activeFile.fileType === 'image'" class="file-preview-container">
            <div v-if="!activeFile.blobUrl" class="preview-loading"><span class="spinner-mini"></span> {{ $t('files.loadingPreview') }}</div>
            <img v-else :src="activeFile.blobUrl" class="file-preview-image" />
          </div>
        </template>
      </div>
      <div class="file-col-placeholder" v-if="openFiles.length === 0 && !fileLoading">
        <div class="placeholder-text">{{ $t('files.clickToView') }}</div>
      </div>

      <!-- 文件夹选择器对话框 -->
      <div class="folder-picker-overlay" v-if="folderPickerOpen" @click.self="folderPickerOpen = false">
        <div class="folder-picker-dialog">
          <div class="folder-picker-header">
            <span>{{ $t('files.selectFolder') }}</span>
            <button class="wb-btn-sm" @click="folderPickerOpen = false">&times;</button>
          </div>
          <div class="folder-picker-path">
            <button class="wb-btn-sm" @click="folderPickerNavigateUp" :disabled="!folderPickerPath" :title="$t('modal.folderPicker.parentDir')">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            </button>
            <span class="folder-picker-current">{{ folderPickerPath || $t('common.drives') }}</span>
          </div>
          <div class="folder-picker-list">
            <div class="git-loading" v-if="folderPickerLoading" style="padding:12px"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
            <template v-else>
              <div
                v-for="entry in folderPickerEntries"
                :key="entry.name"
                class="tree-item tree-dir folder-picker-item"
                :class="{ 'folder-picker-selected': folderPickerSelected === entry.name }"
                @click="folderPickerSelectItem(entry)"
                @dblclick="folderPickerEnter(entry)"
              >
                <span class="tree-icon" v-html="getFolderIcon(false)"></span>
                <span class="tree-name">{{ entry.name }}</span>
              </div>
              <div class="tree-empty" v-if="folderPickerEntries.length === 0">{{ $t('common.noSubdirectories') }}</div>
            </template>
          </div>
          <div class="folder-picker-footer">
            <button class="wb-btn" @click="confirmFolderPicker" :disabled="!folderPickerPath">{{ $t('common.open') }}</button>
          </div>
        </div>
      </div>

      <!-- Quick Open 对话框 (Ctrl+P) -->
      <div class="quick-open-overlay" v-if="quickOpenVisible" @click.self="closeQuickOpen">
        <div class="quick-open-dialog">
          <input
            ref="quickOpenInput"
            v-model="quickOpenQuery"
            @input="onQuickOpenInput"
            @keydown.down.prevent="quickOpenSelectNext"
            @keydown.up.prevent="quickOpenSelectPrev"
            @keydown.enter.prevent="quickOpenConfirm"
            @keydown.escape.prevent="closeQuickOpen"
            class="quick-open-input"
            placeholder="Search files by name..."
          />
          <div class="quick-open-list">
            <div
              v-for="(r, i) in quickOpenResults" :key="r.fullPath"
              class="quick-open-item"
              :class="{ selected: i === quickOpenSelectedIndex }"
              @click="quickOpenOpenFile(r)"
              @mouseenter="quickOpenSelectedIndex = i"
            >
              <span class="tree-icon" v-html="r.type === 'directory' ? getFolderIcon(false) : getFileIconHtml(r.name)"></span>
              <span class="quick-open-name">{{ r.name }}</span>
              <span class="quick-open-path">{{ r.path }}</span>
            </div>
            <div class="tree-empty" v-if="quickOpenQuery && quickOpenResults.length === 0 && !quickOpenLoading">{{ $t('files.noMatch') }}</div>
            <div class="file-tree-loading" v-if="quickOpenLoading">{{ $t('files.searching') }}</div>
          </div>
        </div>
      </div>

      <!-- Go to Line 对话框 (Ctrl+G) -->
      <div class="quick-open-overlay" v-if="goToLineVisible" @click.self="closeGoToLine">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="goToLineInput"
            v-model="goToLineValue"
            @keydown.enter.prevent="goToLineConfirm"
            @keydown.escape.prevent="closeGoToLine"
            class="quick-open-input"
            placeholder="Go to line number..."
            type="number"
            min="1"
          />
        </div>
      </div>

      <!-- 新建文件/文件夹对话框 -->
      <div class="quick-open-overlay" v-if="newFileDialogVisible" @click.self="newFileDialogVisible = false">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="newFileInput"
            v-model="newFileName"
            @keydown.enter.prevent="confirmNewFile"
            @keydown.escape.prevent="newFileDialogVisible = false"
            class="quick-open-input"
            :placeholder="newFileType === 'directory' ? $t('files.enterFolderName') : $t('files.enterFileName')"
          />
        </div>
      </div>

      <!-- 移动文件对话框 -->
      <div class="quick-open-overlay" v-if="moveDialogVisible" @click.self="moveDialogVisible = false">
        <div class="quick-open-dialog">
          <input
            ref="moveDestInput"
            v-model="moveDestination"
            @keydown.enter.prevent="confirmMove"
            @keydown.escape.prevent="moveDialogVisible = false"
            class="quick-open-input"
            :placeholder="$t('files.moveTarget')"
          />
          <div class="quick-open-list" style="padding: 8px 12px; color: var(--text-muted); font-size: 11px;">
            {{ $t('files.moveItems', { count: selectedPaths.size }) }}
          </div>
        </div>
      </div>

      <!-- 重命名对话框 -->
      <div class="quick-open-overlay" v-if="renameDialogVisible" @click.self="renameDialogVisible = false">
        <div class="quick-open-dialog goto-line-dialog">
          <input
            ref="renameInput"
            v-model="renameNewName"
            @keydown.enter.prevent="confirmRename"
            @keydown.escape.prevent="renameDialogVisible = false"
            class="quick-open-input"
            :placeholder="$t('files.enterNewName')"
          />
        </div>
      </div>

      <!-- 右键上下文菜单 -->
      <div v-if="contextMenu.visible" class="ctx-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @click.stop>
        <div class="ctx-menu-item" @click="ctxRename">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          {{ $t('files.rename') }}
        </div>
        <div class="ctx-menu-item" @click="ctxCopy">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          {{ $t('files.copyHere') }}
        </div>
        <div class="ctx-menu-item" @click="ctxMoveTo">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12l-4-4h3V10h2v4h3l-4 4z"/></svg>
          {{ $t('files.moveTo') }}
        </div>
        <div class="ctx-menu-separator"></div>
        <div class="ctx-menu-item ctx-menu-danger" @click="ctxDelete">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          {{ $t('common.delete') }}
        </div>
        <template v-if="contextMenu.entry?.type === 'file'">
          <div class="ctx-menu-separator"></div>
          <div class="ctx-menu-item" @click="ctxDownload">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            {{ $t('files.download') }}
          </div>
        </template>
      </div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const t = Vue.inject('t');

    // --- 层级树状态 ---
    const treePath = Vue.ref('');
    const treeRootPath = Vue.ref('');
    const treeNodes = Vue.reactive({}); // dirPath -> { entries: [{name,type,path,size}], expanded, loaded, loading }

    // --- VS Code 风格 header 状态 ---
    const editingTreePath = Vue.ref(false);
    const treePathInputRef = Vue.ref(null);

    const rootFolderName = Vue.computed(() => {
      if (!treeRootPath.value) return 'EXPLORER';
      const parts = treeRootPath.value.replace(/[\\/]+$/, '').split(/[\\/]/);
      return (parts[parts.length - 1] || treeRootPath.value).toUpperCase();
    });

    const rootExpanded = Vue.computed(() => {
      if (!treeRootPath.value) return false;
      return !!treeNodes[treeRootPath.value]?.expanded;
    });

    const toggleRootExpand = () => {
      if (!treeRootPath.value) return;
      const node = treeNodes[treeRootPath.value];
      if (node) {
        node.expanded = !node.expanded;
      }
    };

    const collapseAll = () => {
      for (const key of Object.keys(treeNodes)) {
        if (treeNodes[key]) {
          treeNodes[key].expanded = false;
        }
      }
    };

    const startTreePathEdit = () => {
      editingTreePath.value = true;
      Vue.nextTick(() => treePathInputRef.value?.focus());
    };

    const confirmTreePath = () => {
      editingTreePath.value = false;
      loadRootDirectory();
    };

    const cancelTreePathEdit = () => {
      editingTreePath.value = false;
    };

    // --- 可调宽度 ---
    const treePanelWidth = Vue.ref(parseInt(localStorage.getItem('filePanelWidth')) || 220);
    const isTreeResizing = Vue.ref(false);

    // --- Per-conversation file tabs persistence ---
    const fileTabsMap = Vue.reactive({});

    // --- File tabs state ---
    const openFiles = Vue.ref([]); // [{ path, name, content, originalContent, isDirty, cmInstance, fileType, blobUrl, previewUrl, ... }]
    const activeFileIndex = Vue.ref(-1);
    const fileLoading = Vue.ref(false);
    const fileSaving = Vue.ref(false);
    const editorContainer = Vue.ref(null);
    const officePreviewContainer = Vue.ref(null);
    const rootEl = Vue.ref(null);

    // --- File type detection ---
    const OFFICE_EXT = new Set(['.docx', '.xlsx', '.xls', '.pptx', '.ppt']);
    const PDF_EXT = new Set(['.pdf']);
    const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

    function getFileType(name) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) return 'text';
      const ext = name.substring(dot).toLowerCase();
      if (OFFICE_EXT.has(ext)) return 'office';
      if (PDF_EXT.has(ext)) return 'pdf';
      if (IMAGE_EXT.has(ext)) return 'image';
      return 'text';
    }

    // --- Office local rendering ---
    const renderOfficeLocal = (file) => {
      const container = officePreviewContainer.value;
      if (!container || !file._arrayBuffer) return;
      container.innerHTML = '';
      const ext = ('.' + file.name.split('.').pop()).toLowerCase();

      if (ext === '.docx' && window.docx) {
        window.docx.renderAsync(file._arrayBuffer, container, null, {
          className: 'docx-preview-content',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true
        }).catch(e => { file.previewError = e.message; });
      } else if (ext === '.xlsx' || ext === '.xls') {
        try {
          const wb = XLSX.read(file._arrayBuffer, { type: 'array' });
          const sheetName = wb.SheetNames[0];
          const html = XLSX.utils.sheet_to_html(wb.Sheets[sheetName], { editable: false });
          container.innerHTML = '<div class="xlsx-sheet-tabs">' +
            wb.SheetNames.map((n, i) => `<button class="xlsx-sheet-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${n}</button>`).join('') +
            '</div><div class="xlsx-table-wrap">' + html + '</div>';
          // Sheet tab switching
          container.querySelectorAll('.xlsx-sheet-tab').forEach(btn => {
            btn.addEventListener('click', () => {
              const idx = parseInt(btn.dataset.idx);
              const sn = wb.SheetNames[idx];
              const h = XLSX.utils.sheet_to_html(wb.Sheets[sn], { editable: false });
              container.querySelector('.xlsx-table-wrap').innerHTML = h;
              container.querySelectorAll('.xlsx-sheet-tab').forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
            });
          });
        } catch (e) { file.previewError = e.message; }
      } else if (ext === '.pptx' || ext === '.ppt') {
        container.innerHTML = '<div class="preview-unsupported">' + t('files.pptxNotSupported') + '</div>';
      }
    };

    // --- Per-session undo history ---
    const undoHistoryMap = Vue.reactive({}); // convId -> { filePath -> cmHistory }

    // --- Debug status (visible fallback when console doesn't work) ---
    const debugStatus = Vue.ref('');

    // --- Find/Replace state ---
    const findBarVisible = Vue.ref(false);
    const replaceBarVisible = Vue.ref(false);
    const findQuery = Vue.ref('');
    const replaceQuery = Vue.ref('');
    const findCaseSensitive = Vue.ref(false);
    const findUseRegex = Vue.ref(false);
    const findMatchCount = Vue.ref(0);
    const findMatchIndex = Vue.ref(-1);
    const findInputRef = Vue.ref(null);
    const replaceInputRef = Vue.ref(null);
    let findMarkers = []; // CodeMirror TextMarker instances
    let findMatches = []; // [{from: {line, ch}, to: {line, ch}}]

    // --- Font size zoom ---
    const fontSize = Vue.ref(parseInt(localStorage.getItem('filesFontSize')) || 15);
    const setFontSize = (size) => {
      fontSize.value = Math.max(8, Math.min(24, size));
      localStorage.setItem('filesFontSize', fontSize.value.toString());
      // Update CodeMirror font size if active
      const file = activeFile.value;
      if (file?.cmInstance) {
        file.cmInstance.getWrapperElement().style.fontSize = fontSize.value + 'px';
        file.cmInstance.refresh();
      }
    };
    const zoomIn = () => setFontSize(fontSize.value + 1);
    const zoomOut = () => setFontSize(fontSize.value - 1);
    const onWheel = (e) => {
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };

    // --- 文件夹选择器状态 ---
    const folderPickerOpen = Vue.ref(false);
    const folderPickerPath = Vue.ref('');
    const folderPickerEntries = Vue.ref([]);
    const folderPickerLoading = Vue.ref(false);
    const folderPickerSelected = Vue.ref('');

    // --- 文件搜索状态 ---
    const searchQuery = Vue.ref('');
    const searchResults = Vue.ref([]);
    const searchLoading = Vue.ref(false);
    let searchDebounceTimer = null;

    // --- Quick Open (Ctrl+P) ---
    const quickOpenVisible = Vue.ref(false);
    const quickOpenQuery = Vue.ref('');
    const quickOpenResults = Vue.ref([]);
    const quickOpenSelectedIndex = Vue.ref(0);
    const quickOpenLoading = Vue.ref(false);
    const quickOpenInput = Vue.ref(null);
    let quickOpenDebounceTimer = null;

    // --- Go to Line (Ctrl+G) ---
    const goToLineVisible = Vue.ref(false);
    const goToLineValue = Vue.ref('');
    const goToLineInput = Vue.ref(null);

    // --- File operations ---
    const selectedPaths = Vue.reactive(new Set());
    const lastClickedIndex = Vue.ref(-1);
    const fileOperating = Vue.ref(false);
    const fileOpFeedback = Vue.ref(null);
    let fileOpFeedbackTimer = null;
    let fileOpTimer = null;
    const newFileDialogVisible = Vue.ref(false);
    const newFileName = Vue.ref('');
    const newFileType = Vue.ref('file');
    const newFileInput = Vue.ref(null);
    const moveDialogVisible = Vue.ref(false);
    const moveDestination = Vue.ref('');
    const moveDestInput = Vue.ref(null);

    // --- 右键菜单 & 重命名 ---
    const contextMenu = Vue.reactive({ visible: false, x: 0, y: 0, entry: null });
    const renameDialogVisible = Vue.ref(false);
    const renameNewName = Vue.ref('');
    const renameInput = Vue.ref(null);
    let pendingDownload = null;

    // --- 拖拽 ---
    const dragState = Vue.reactive({ dragging: null, dropTarget: null });
    const externalDropActive = Vue.ref(false);

    // ===========================
    // Flattened tree computed
    // ===========================
    const flattenedTree = Vue.computed(() => {
      const result = [];
      const walk = (dirPath, depth) => {
        const node = treeNodes[dirPath];
        if (!node || !node.entries) return;
        for (const entry of node.entries) {
          result.push({ ...entry, depth });
          if (entry.type === 'directory' && treeNodes[entry.path]?.expanded) {
            walk(entry.path, depth + 1);
          }
        }
      };
      if (treeRootPath.value && treeNodes[treeRootPath.value]?.expanded) {
        walk(treeRootPath.value, 0);
      }
      return result;
    });

    const activeFile = Vue.computed(() => {
      if (activeFileIndex.value >= 0 && activeFileIndex.value < openFiles.value.length) {
        return openFiles.value[activeFileIndex.value];
      }
      return null;
    });

    // ===========================
    // Utility functions
    // ===========================
    const getFileIconHtml = (name) => getFileIconSvg(name);
    const getFolderIcon = (isOpen) => getFolderIconSvg(isOpen);

    const getFileIcon = (path) => {
      // Legacy fallback — no longer used in template but kept for compatibility
      return '';
    };

    const formatSize = (bytes) => {
      if (bytes == null) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const getEffectiveWorkDir = () => {
      return store.currentWorkDir || store.currentAgentWorkDir || '';
    };

    // Normalize path separators to forward slashes for consistent key matching
    const normalizePath = (p) => p ? p.replace(/\\/g, '/') : '';

    const getModeForFile = (filename) => {
      const ext = filename.split('.').pop()?.toLowerCase();
      const modeMap = {
        'js': 'javascript', 'mjs': 'javascript', 'jsx': 'javascript',
        'ts': { name: 'javascript', typescript: true },
        'tsx': { name: 'javascript', typescript: true },
        'json': { name: 'javascript', json: true },
        'py': 'python',
        'html': 'htmlmixed', 'htm': 'htmlmixed', 'vue': 'htmlmixed',
        'xml': 'xml', 'svg': 'xml',
        'css': 'css', 'scss': 'css', 'less': 'css',
        'sh': 'shell', 'bash': 'shell', 'zsh': 'shell',
        'c': 'text/x-csrc', 'h': 'text/x-csrc',
        'cpp': 'text/x-c++src', 'hpp': 'text/x-c++src',
        'cs': 'text/x-csharp',
        'java': 'text/x-java',
        'md': 'markdown', 'markdown': 'markdown',
      };
      return modeMap[ext] || 'text/plain';
    };

    const placeholderPath = Vue.computed(() => {
      const dir = getEffectiveWorkDir();
      return dir ? t('files.workDir', { dir }) : t('files.enterDirPath');
    });

    // ===========================
    // Tree operations
    // ===========================
    const loadTreeDirectory = (dirPath) => {
      const nDir = normalizePath(dirPath);
      if (!treeNodes[nDir]) {
        treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: true };
      } else {
        treeNodes[nDir].loading = true;
      }
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        dirPath: dirPath,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const loadRootDirectory = () => {
      const dir = treePath.value.trim();
      if (!dir) return;
      const nDir = normalizePath(dir);
      treeRootPath.value = nDir;
      // Clear old nodes for a fresh root
      Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
      treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: true };
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        dirPath: dir,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const toggleDirectory = (dirPath) => {
      const nDir = normalizePath(dirPath);
      const node = treeNodes[nDir];
      if (node) {
        if (node.loaded) {
          node.expanded = !node.expanded;
        } else {
          node.expanded = true;
          loadTreeDirectory(dirPath);
        }
      } else {
        treeNodes[nDir] = { entries: [], expanded: true, loaded: false, loading: false };
        loadTreeDirectory(dirPath);
      }
    };

    const onTreeItemClick = (entry, event) => {
      const tree = flattenedTree.value;
      const clickedIndex = tree.findIndex(e => e.path === entry.path);

      if (event && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        // Shift+Click: range select from last clicked to current
        if (event.shiftKey && lastClickedIndex.value >= 0 && clickedIndex >= 0) {
          const start = Math.min(lastClickedIndex.value, clickedIndex);
          const end = Math.max(lastClickedIndex.value, clickedIndex);
          // If Ctrl is not also held, clear existing selection first
          if (!event.ctrlKey && !event.metaKey) {
            selectedPaths.clear();
          }
          for (let i = start; i <= end; i++) {
            selectedPaths.add(tree[i].path);
          }
        } else {
          // Ctrl+Click or first Shift+Click (no anchor yet): toggle single item
          if (selectedPaths.has(entry.path)) {
            selectedPaths.delete(entry.path);
          } else {
            selectedPaths.add(entry.path);
          }
        }
        lastClickedIndex.value = clickedIndex;
        return;
      }

      // Normal click: clear selection and perform default action
      if (selectedPaths.size > 0) {
        selectedPaths.clear();
        lastClickedIndex.value = -1;
      }

      if (entry.type === 'directory') {
        toggleDirectory(entry.path);
      } else {
        openFileInTab(entry.path, entry.name);
      }
      lastClickedIndex.value = clickedIndex;
    };

    // ===========================
    // Resizable tree panel
    // ===========================
    const startTreeResize = (e) => {
      e.preventDefault();
      isTreeResizing.value = true;
      const startX = e.clientX;
      const startWidth = treePanelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const container = e.target.closest('.file-two-col');
      const maxWidth = container ? container.offsetWidth * 0.5 : 400;

      const onMouseMove = (ev) => {
        const delta = ev.clientX - startX;
        treePanelWidth.value = Math.max(120, Math.min(maxWidth, startWidth + delta));
      };

      const onMouseUp = () => {
        isTreeResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('filePanelWidth', treePanelWidth.value.toString());
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    // ===========================
    // Find / Replace logic
    // ===========================
    const clearFindMarkers = () => {
      for (const m of findMarkers) {
        try { m.clear(); } catch (e) {}
      }
      findMarkers = [];
      findMatches = [];
      findMatchCount.value = 0;
      findMatchIndex.value = -1;
      clearScrollbarAnnotations();
    };

    // Scrollbar match annotations
    const clearScrollbarAnnotations = () => {
      const cm = activeFile.value?.cmInstance;
      if (!cm) return;
      const wrapper = cm.getWrapperElement();
      const existing = wrapper.querySelector('.cm-find-scrollbar-annotations');
      if (existing) existing.remove();
    };

    const updateScrollbarAnnotations = () => {
      const cm = activeFile.value?.cmInstance;
      if (!cm || findMatches.length === 0) return;
      clearScrollbarAnnotations();

      const wrapper = cm.getWrapperElement();
      const scrollbar = wrapper.querySelector('.CodeMirror-vscrollbar');
      if (!scrollbar) return;

      const totalLines = cm.lineCount();
      if (totalLines === 0) return;

      const container = document.createElement('div');
      container.className = 'cm-find-scrollbar-annotations';

      for (const m of findMatches) {
        const pct = (m.from.line / totalLines) * 100;
        const tick = document.createElement('div');
        tick.className = 'cm-find-scrollbar-tick';
        tick.style.top = pct + '%';
        container.appendChild(tick);
      }

      wrapper.appendChild(container);
    };

    const performFind = () => {
      clearFindMarkers();
      const cm = activeFile.value?.cmInstance;
      if (!cm || !findQuery.value) return;

      const query = findQuery.value;
      // Require at least 3 characters to avoid excessive matches and lag
      if (query.length < 3) return;

      const text = cm.getValue();
      const caseSensitive = findCaseSensitive.value;
      const useRegex = findUseRegex.value;
      const matches = [];

      try {
        if (useRegex) {
          const flags = caseSensitive ? 'g' : 'gi';
          const re = new RegExp(query, flags);
          let m;
          while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            const from = cm.posFromIndex(m.index);
            const to = cm.posFromIndex(m.index + m[0].length);
            matches.push({ from, to });
            if (matches.length > 10000) break;
          }
        } else {
          const searchText = caseSensitive ? query : query.toLowerCase();
          const sourceText = caseSensitive ? text : text.toLowerCase();
          let idx = 0;
          while ((idx = sourceText.indexOf(searchText, idx)) !== -1) {
            const from = cm.posFromIndex(idx);
            const to = cm.posFromIndex(idx + query.length);
            matches.push({ from, to });
            idx += query.length;
            if (matches.length > 10000) break;
          }
        }
      } catch (e) {
        // Invalid regex - ignore
        return;
      }

      findMatches = matches;
      findMatchCount.value = matches.length;

      // Mark all matches
      for (const m of matches) {
        findMarkers.push(cm.markText(m.from, m.to, { className: 'cm-find-highlight' }));
      }

      // Jump to nearest match from cursor
      if (matches.length > 0) {
        const cursor = cm.getCursor();
        let nearest = 0;
        for (let i = 0; i < matches.length; i++) {
          const cmp = CodeMirror.cmpPos(matches[i].from, cursor);
          if (cmp >= 0) { nearest = i; break; }
          if (i === matches.length - 1) nearest = 0;
        }
        findMatchIndex.value = nearest;
        highlightCurrentMatch(nearest);
      }

      // Update scrollbar match annotations
      updateScrollbarAnnotations();
    };

    const highlightCurrentMatch = (index) => {
      const cm = activeFile.value?.cmInstance;
      if (!cm || !findMatches[index]) return;
      // Remove previous current-match highlight
      for (let i = 0; i < findMarkers.length; i++) {
        if (!findMarkers[i]) continue;
        const pos = findMarkers[i].find();
        if (pos) {
          findMarkers[i].clear();
          findMarkers[i] = cm.markText(pos.from, pos.to, { className: 'cm-find-highlight' });
        }
      }
      // Highlight current match distinctly
      const m = findMatches[index];
      if (findMarkers[index]) {
        const curPos = findMarkers[index].find();
        if (curPos) {
          findMarkers[index].clear();
          findMarkers[index] = cm.markText(curPos.from, curPos.to, { className: 'cm-find-highlight cm-find-current' });
        }
      }
      // Use setTimeout to ensure DOM is updated before scrolling
      setTimeout(() => {
        cm.scrollIntoView({ from: m.from, to: m.to }, 100);
      }, 0);
    };

    const findNext = () => {
      if (findMatches.length === 0) return;
      const next = (findMatchIndex.value + 1) % findMatches.length;
      findMatchIndex.value = next;
      highlightCurrentMatch(next);
    };

    const findPrev = () => {
      if (findMatches.length === 0) return;
      const prev = (findMatchIndex.value - 1 + findMatches.length) % findMatches.length;
      findMatchIndex.value = prev;
      highlightCurrentMatch(prev);
    };

    const onFindInput = () => {
      performFind();
    };

    const openFindBar = (showReplace = false) => {
      findBarVisible.value = true;
      replaceBarVisible.value = showReplace;
      // Pre-fill with selection
      const cm = activeFile.value?.cmInstance;
      if (cm) {
        const sel = cm.getSelection();
        if (sel) findQuery.value = sel;
      }
      Vue.nextTick(() => {
        findInputRef.value?.focus();
        findInputRef.value?.select();
        if (findQuery.value) performFind();
      });
    };

    const closeFindBar = () => {
      clearFindMarkers();
      findBarVisible.value = false;
      replaceBarVisible.value = false;
      // Refocus editor
      const cm = activeFile.value?.cmInstance;
      if (cm) cm.focus();
    };

    const toggleReplaceBar = () => {
      replaceBarVisible.value = !replaceBarVisible.value;
      if (replaceBarVisible.value) {
        Vue.nextTick(() => replaceInputRef.value?.focus());
      }
    };

    const replaceOne = () => {
      const cm = activeFile.value?.cmInstance;
      if (!cm || findMatches.length === 0 || findMatchIndex.value < 0) return;
      const m = findMatches[findMatchIndex.value];
      cm.replaceRange(replaceQuery.value, m.from, m.to);
      // Re-search after replace
      performFind();
    };

    const replaceAll = () => {
      const cm = activeFile.value?.cmInstance;
      if (!cm || findMatches.length === 0) return;
      // Replace from end to start to preserve positions
      cm.operation(() => {
        for (let i = findMatches.length - 1; i >= 0; i--) {
          cm.replaceRange(replaceQuery.value, findMatches[i].from, findMatches[i].to);
        }
      });
      performFind();
    };

    // ===========================
    // CodeMirror editor
    // ===========================
    const createEditor = (fileObj, retryCount = 0) => {
      if (!editorContainer.value) {
        if (retryCount < 20) {
          setTimeout(() => createEditor(fileObj, retryCount + 1), 100);
        }
        return;
      }
      if (!fileObj) return;

      editorContainer.value.innerHTML = '';

      if (typeof CodeMirror === 'undefined') {
        // Fallback: plain textarea if CodeMirror somehow not loaded
        const ta = document.createElement('textarea');
        ta.value = fileObj.content || '';
        ta.style.cssText = 'width:100%;height:100%;border:none;outline:none;resize:none;padding:12px;font-family:monospace;font-size:12px;background:var(--bg-main);color:var(--text-main);white-space:pre;tab-size:4;';
        ta.spellcheck = false;
        ta.addEventListener('input', () => {
          fileObj.content = ta.value;
          fileObj.isDirty = (ta.value !== fileObj.originalContent);
        });
        ta.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
        });
        editorContainer.value.appendChild(ta);
        debugStatus.value = '';
        return;
      }

      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const theme = isDark ? 'material-darker' : 'default';
      try {
        const cm = CodeMirror(editorContainer.value, {
          value: fileObj.content || '',
          mode: getModeForFile(fileObj.name),
          theme: theme,
          lineNumbers: true,
          tabSize: 4,
          indentWithTabs: false,
          lineWrapping: false,
          readOnly: false,
          extraKeys: {
            'Ctrl-S': () => saveFile(),
            'Cmd-S': () => saveFile(),
            'Ctrl-P': () => openQuickOpen(),
            'Cmd-P': () => openQuickOpen(),
            'Ctrl-G': () => openGoToLine(),
            'Cmd-G': () => openGoToLine(),
            'Ctrl-F': () => openFindBar(false),
            'Cmd-F': () => openFindBar(false),
            'Ctrl-R': () => openFindBar(true),
            'Cmd-R': () => openFindBar(true),
            'Ctrl-H': () => openFindBar(true),
            'Cmd-H': () => openFindBar(true),
          }
        });

        cm.on('change', () => {
          const current = cm.getValue();
          fileObj.content = current;
          fileObj.isDirty = (current !== fileObj.originalContent);
        });

        fileObj.cmInstance = cm;

        // Apply current font size
        cm.getWrapperElement().style.fontSize = fontSize.value + 'px';

        // Restore undo history if available
        const convId = store.currentConversation;
        if (convId && undoHistoryMap[convId]?.[fileObj.path]) {
          cm.setHistory(undoHistoryMap[convId][fileObj.path]);
        }

        Vue.nextTick(() => {
          cm.refresh();
          setTimeout(() => cm.refresh(), 200);
        });

        debugStatus.value = '';
      } catch (err) {
        debugStatus.value = `Editor error: ${err.message}`;
        console.error('[FilesTab] createEditor:', err);
      }
    };

    const destroyEditor = () => {
      // Clear find markers before destroying editor to prevent stale marker references
      clearFindMarkers();
      // 正确销毁 CodeMirror 实例
      const file = activeFile.value;
      if (file?.cmInstance) {
        file.cmInstance.toTextArea && file.cmInstance.toTextArea();
        file.cmInstance = null;
      }
      if (editorContainer.value) {
        editorContainer.value.innerHTML = '';
      }
    };

    // ===========================
    // Undo history persistence
    // ===========================
    const saveCurrentUndoHistory = () => {
      const convId = store.currentConversation;
      if (!convId) return;
      const file = activeFile.value;
      if (file?.cmInstance) {
        if (!undoHistoryMap[convId]) undoHistoryMap[convId] = {};
        undoHistoryMap[convId][file.path] = file.cmInstance.getHistory();
      }
    };

    const saveAllUndoHistory = (convId) => {
      if (!convId) return;
      const file = activeFile.value;
      if (file?.cmInstance) {
        if (!undoHistoryMap[convId]) undoHistoryMap[convId] = {};
        undoHistoryMap[convId][file.path] = file.cmInstance.getHistory();
      }
    };

    // ===========================
    // File tabs management
    // ===========================
    const saveTabsState = (convId) => {
      if (!convId) return;
      saveAllUndoHistory(convId);
      if (openFiles.value.length > 0) {
        fileTabsMap[convId] = {
          files: openFiles.value.map(f => ({
            path: f.path, name: f.name, content: f.content,
            originalContent: f.originalContent, isDirty: f.isDirty,
            fileType: f.fileType
          })),
          activeIndex: activeFileIndex.value
        };
      } else {
        delete fileTabsMap[convId];
      }
      // ★ 同步 file tab 路径到 server（debounced）
      syncFileTabsToServer();
    };

    // Debounced sync to server
    let _syncTabsTimer = null;
    const syncFileTabsToServer = () => {
      if (_syncTabsTimer) clearTimeout(_syncTabsTimer);
      _syncTabsTimer = setTimeout(() => {
        store.sendWsMessage({
          type: 'update_file_tabs',
          openFiles: openFiles.value.map(f => ({ path: f.path })),
          activeIndex: activeFileIndex.value
        });
      }, 500);
    };

    const restoreTabsState = (convId) => {
      destroyEditor();
      if (!convId || !fileTabsMap[convId]) {
        openFiles.value = [];
        activeFileIndex.value = -1;
        return;
      }
      const saved = fileTabsMap[convId];
      openFiles.value = saved.files.map(f => ({
        ...f,
        isDirty: f.isDirty || false,
        originalContent: f.originalContent || f.content,
        cmInstance: null,
        fileType: f.fileType || getFileType(f.name || ''),
        blobUrl: null,
        previewUrl: null,
        previewLoading: false,
        localPreviewReady: false,
        previewError: null
      }));
      activeFileIndex.value = saved.activeIndex;

      Vue.nextTick(() => {
        const file = activeFile.value;
        if (file && (!file.fileType || file.fileType === 'text') && editorContainer.value) {
          createEditor(file);
        }
      });
    };

    const openFileInTab = (fullPath, name) => {
      const nPath = normalizePath(fullPath);
      const existingIndex = openFiles.value.findIndex(f => f.path === nPath);
      if (existingIndex >= 0) {
        if (activeFileIndex.value !== existingIndex) {
          clearFindMarkers();
          saveCurrentUndoHistory();
          activeFileIndex.value = existingIndex;
          Vue.nextTick(() => {
            const file = openFiles.value[existingIndex];
            if (file && file.content != null && (!file.fileType || file.fileType === 'text')) createEditor(file);
          });
        }
        saveTabsState(store.currentConversation);
        return;
      }

      saveCurrentUndoHistory();
      const displayName = name || nPath.split(/[/\\]/).pop();
      const fileType = getFileType(displayName);
      const newFile = {
        path: nPath,
        name: displayName,
        content: null,
        originalContent: null,
        isDirty: false,
        cmInstance: null,
        fileType,
        blobUrl: null,
        previewUrl: null,
        previewLoading: fileType !== 'text',
        localPreviewReady: false,
        previewError: null
      };
      openFiles.value.push(newFile);
      activeFileIndex.value = openFiles.value.length - 1;
      fileLoading.value = true;
      if (fileType === 'text') destroyEditor();
      saveTabsState(store.currentConversation);

      debugStatus.value = `Loading: ${fullPath}`;
      store.sendWsMessage({
        type: 'read_file',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        filePath: fullPath,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const switchToTab = (index) => {
      if (index === activeFileIndex.value) return;
      clearFindMarkers();
      saveCurrentUndoHistory();
      activeFileIndex.value = index;
      saveTabsState(store.currentConversation);

      Vue.nextTick(() => {
        const file = openFiles.value[index];
        if (!file) return;
        if (!file.fileType || file.fileType === 'text') {
          if (file.content != null && editorContainer.value) {
            createEditor(file);
            if (findBarVisible.value && findQuery.value) {
              Vue.nextTick(() => performFind());
            }
          }
        } else if (file.fileType === 'office' && file.localPreviewReady) {
          Vue.nextTick(() => renderOfficeLocal(file));
        }
      });
    };

    const closeFileTab = (index) => {
      const file = openFiles.value[index];
      if (file?.isDirty) {
        if (!confirm(t('files.unsavedConfirm', { name: file.name }))) return;
      }

      // Clean up undo history for this file
      const convId = store.currentConversation;
      if (convId && undoHistoryMap[convId]) {
        delete undoHistoryMap[convId][file.path];
      }

      // Clean up blob URL
      if (file.blobUrl) {
        URL.revokeObjectURL(file.blobUrl);
      }

      const wasActive = (index === activeFileIndex.value);
      openFiles.value.splice(index, 1);

      if (openFiles.value.length === 0) {
        activeFileIndex.value = -1;
        destroyEditor();
      } else if (activeFileIndex.value >= openFiles.value.length) {
        activeFileIndex.value = openFiles.value.length - 1;
      } else if (activeFileIndex.value > index) {
        activeFileIndex.value--;
      } else if (wasActive && activeFileIndex.value >= openFiles.value.length) {
        activeFileIndex.value = openFiles.value.length - 1;
      }

      saveTabsState(store.currentConversation);

      if (openFiles.value.length > 0 && wasActive) {
        Vue.nextTick(() => {
          const newActive = openFiles.value[activeFileIndex.value];
          if (newActive && (!newActive.fileType || newActive.fileType === 'text') && newActive.content != null && editorContainer.value) {
            createEditor(newActive);
          }
        });
      }
    };

    // ===========================
    // Save file
    // ===========================
    const saveFile = () => {
      const file = activeFile.value;
      if (!file || !file.isDirty) return;
      fileSaving.value = true;

      store.sendWsMessage({
        type: 'write_file',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        filePath: file.path,
        content: file.content,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    // ===========================
    // Folder picker
    // ===========================
    const openFolderPicker = () => {
      folderPickerOpen.value = true;
      folderPickerSelected.value = '';
      folderPickerLoading.value = true;
      // Default to current workDir or tree root, not drive root
      const defaultDir = treePath.value || getEffectiveWorkDir() || '';
      folderPickerPath.value = defaultDir;
      folderPickerEntries.value = [];
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: '_folder_picker',
        agentId: store.currentAgent,
        dirPath: defaultDir,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const loadFolderPickerDir = (dirPath) => {
      folderPickerLoading.value = true;
      folderPickerSelected.value = '';
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: '_folder_picker',
        agentId: store.currentAgent,
        dirPath: dirPath,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const folderPickerNavigateUp = () => {
      if (!folderPickerPath.value) return;
      const isWin = folderPickerPath.value.includes('\\');
      const sep = isWin ? '\\' : '/';
      const parts = folderPickerPath.value.replace(/[/\\]$/, '').split(/[/\\]/);
      parts.pop();
      if (parts.length === 0) {
        folderPickerPath.value = '';
        loadFolderPickerDir('');
      } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
        folderPickerPath.value = parts[0] + '\\';
        loadFolderPickerDir(parts[0] + '\\');
      } else {
        const parent = parts.join(sep);
        folderPickerPath.value = parent;
        loadFolderPickerDir(parent);
      }
    };

    const folderPickerSelectItem = (entry) => {
      folderPickerSelected.value = entry.name;
      const sep = folderPickerPath.value.includes('\\') || /^[A-Z]:/.test(folderPickerPath.value) ? '\\' : '/';
      // Don't update folderPickerPath on single click - just mark selection
    };

    const folderPickerEnter = (entry) => {
      const sep = folderPickerPath.value.includes('\\') || /^[A-Z]:/.test(entry.name) ? '\\' : '/';
      let newPath;
      if (!folderPickerPath.value) {
        // At drive level
        newPath = entry.name + (entry.name.endsWith('\\') ? '' : '\\');
      } else {
        newPath = folderPickerPath.value.replace(/[/\\]$/, '') + sep + entry.name;
      }
      folderPickerPath.value = newPath;
      loadFolderPickerDir(newPath);
    };

    const confirmFolderPicker = () => {
      let path = folderPickerPath.value;
      if (!path) return;
      // If a subfolder is selected, include it in the path
      if (folderPickerSelected.value) {
        const sep = path.includes('\\') ? '\\' : '/';
        path = path.replace(/[/\\]$/, '') + sep + folderPickerSelected.value;
      }
      treePath.value = path;
      folderPickerOpen.value = false;
      const nPath = normalizePath(path);
      treeRootPath.value = nPath;
      Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
      treeNodes[nPath] = { entries: [], expanded: true, loaded: false, loading: true };
      store.sendWsMessage({
        type: 'list_directory',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        dirPath: path,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    // ===========================
    // File Search
    // ===========================
    const sendFileSearch = (query, isQuickOpen = false) => {
      if (!store.currentAgent || !query.trim()) return;
      store.sendWsMessage({
        type: 'file_search',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        query: query.trim(),
        dirPath: treePath.value || getEffectiveWorkDir() || '',
        _clientId: store.clientId
      });
    };

    const onSearchInput = () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      if (!searchQuery.value.trim()) {
        searchResults.value = [];
        searchLoading.value = false;
        return;
      }
      searchLoading.value = true;
      searchDebounceTimer = setTimeout(() => {
        sendFileSearch(searchQuery.value);
      }, 300);
    };

    const clearSearch = () => {
      searchQuery.value = '';
      searchResults.value = [];
      searchLoading.value = false;
    };

    const onSearchResultClick = (r) => {
      if (r.type === 'directory') {
        // Navigate tree to this directory
        const nDir = normalizePath(r.fullPath);
        treeRootPath.value = nDir;
        treePath.value = r.fullPath;
        Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
        loadTreeDirectory(r.fullPath);
        clearSearch();
      } else {
        openFileInTab(r.fullPath, r.name);
        clearSearch();
      }
    };

    // ===========================
    // Quick Open (Ctrl+P)
    // ===========================
    const openQuickOpen = () => {
      quickOpenVisible.value = true;
      quickOpenQuery.value = '';
      quickOpenResults.value = [];
      quickOpenSelectedIndex.value = 0;
      quickOpenLoading.value = false;
      Vue.nextTick(() => quickOpenInput.value?.focus());
    };

    const closeQuickOpen = () => {
      quickOpenVisible.value = false;
      quickOpenQuery.value = '';
      quickOpenResults.value = [];
    };

    const onQuickOpenInput = () => {
      if (quickOpenDebounceTimer) clearTimeout(quickOpenDebounceTimer);
      if (!quickOpenQuery.value.trim()) {
        quickOpenResults.value = [];
        quickOpenLoading.value = false;
        return;
      }
      quickOpenLoading.value = true;
      quickOpenSelectedIndex.value = 0;
      quickOpenDebounceTimer = setTimeout(() => {
        sendFileSearch(quickOpenQuery.value, true);
      }, 200);
    };

    const quickOpenSelectNext = () => {
      if (quickOpenResults.value.length > 0) {
        quickOpenSelectedIndex.value = (quickOpenSelectedIndex.value + 1) % quickOpenResults.value.length;
      }
    };

    const quickOpenSelectPrev = () => {
      if (quickOpenResults.value.length > 0) {
        quickOpenSelectedIndex.value = (quickOpenSelectedIndex.value - 1 + quickOpenResults.value.length) % quickOpenResults.value.length;
      }
    };

    const quickOpenConfirm = () => {
      const sel = quickOpenResults.value[quickOpenSelectedIndex.value];
      if (sel) quickOpenOpenFile(sel);
    };

    const quickOpenOpenFile = (r) => {
      if (r.type !== 'directory') {
        openFileInTab(r.fullPath, r.name);
      }
      closeQuickOpen();
    };

    // ===========================
    // Go to Line (Ctrl+G)
    // ===========================
    const openGoToLine = () => {
      goToLineVisible.value = true;
      goToLineValue.value = '';
      Vue.nextTick(() => goToLineInput.value?.focus());
    };

    const closeGoToLine = () => {
      goToLineVisible.value = false;
      goToLineValue.value = '';
    };

    const goToLineConfirm = () => {
      const line = parseInt(goToLineValue.value);
      if (isNaN(line) || line < 1) return;
      const file = activeFile.value;
      if (file?.cmInstance) {
        const cm = file.cmInstance;
        const targetLine = Math.min(line - 1, cm.lineCount() - 1);
        cm.setCursor({ line: targetLine, ch: 0 });
        cm.scrollIntoView({ line: targetLine, ch: 0 }, 100);
        cm.focus();
      }
      closeGoToLine();
    };

    // ===========================
    // File operations
    // ===========================
    const showFileOpFeedback = (ok, message) => {
      if (fileOpFeedbackTimer) clearTimeout(fileOpFeedbackTimer);
      fileOpFeedback.value = { ok, message };
      fileOpFeedbackTimer = setTimeout(() => { fileOpFeedback.value = null; }, 4000);
    };

    const toggleSelection = (path) => {
      if (selectedPaths.has(path)) {
        selectedPaths.delete(path);
      } else {
        selectedPaths.add(path);
      }
    };

    const clearSelection = () => {
      selectedPaths.clear();
      lastClickedIndex.value = -1;
    };

    const showNewFileDialog = (type) => {
      newFileType.value = type;
      newFileName.value = '';
      newFileDialogVisible.value = true;
      Vue.nextTick(() => newFileInput.value?.focus());
    };

    const confirmNewFile = () => {
      const name = newFileName.value.trim();
      if (!name) return;
      newFileDialogVisible.value = false;

      const basePath = treePath.value || getEffectiveWorkDir();
      if (!basePath) return;

      const sep = basePath.includes('\\') ? '\\' : '/';
      const filePath = basePath.replace(/[/\\]$/, '') + sep + name;

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'create_file',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        filePath,
        isDirectory: newFileType.value === 'directory',
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const deleteSingleFile = (entry) => {
      const name = entry.path.split('/').pop();
      if (!confirm(t('files.deleteConfirm', { name }) + (entry.type === 'directory' ? t('files.deleteDirHint') : ''))) return;

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'delete_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [entry.path],
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const deleteSelected = () => {
      const count = selectedPaths.size;
      if (count === 0) return;
      if (!confirm(t('files.deleteSelectedConfirm', { count }))) return;

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'delete_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [...selectedPaths],
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const openMoveDialog = () => {
      moveDestination.value = treePath.value || getEffectiveWorkDir() || '';
      moveDialogVisible.value = true;
      Vue.nextTick(() => moveDestInput.value?.focus());
    };

    const confirmMove = () => {
      const dest = moveDestination.value.trim();
      if (!dest || selectedPaths.size === 0) return;
      moveDialogVisible.value = false;

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'move_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [...selectedPaths],
        destination: dest,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    // ===========================
    // Context menu
    // ===========================
    const showContextMenu = (event, entry) => {
      const menuW = 180, menuH = 240;
      let x = event.clientX, y = event.clientY;
      if (x + menuW > window.innerWidth) x = window.innerWidth - menuW;
      if (y + menuH > window.innerHeight) y = window.innerHeight - menuH;
      contextMenu.entry = entry;
      contextMenu.x = x;
      contextMenu.y = y;
      contextMenu.visible = true;
    };

    const hideContextMenu = () => { contextMenu.visible = false; };

    const ctxRename = () => {
      const entry = contextMenu.entry;
      hideContextMenu();
      if (!entry) return;
      renameNewName.value = entry.name;
      renameDialogVisible.value = true;
      Vue.nextTick(() => {
        const input = renameInput.value;
        if (input) {
          input.focus();
          // Select name without extension for files
          if (entry.type === 'file') {
            const dotIdx = entry.name.lastIndexOf('.');
            if (dotIdx > 0) {
              input.setSelectionRange(0, dotIdx);
            } else {
              input.select();
            }
          } else {
            input.select();
          }
        }
      });
    };

    const confirmRename = () => {
      const entry = contextMenu.entry;
      const name = renameNewName.value.trim();
      if (!name || !entry || name === entry.name) {
        renameDialogVisible.value = false;
        return;
      }
      renameDialogVisible.value = false;

      // Get parent directory of the entry
      const parts = entry.path.replace(/\/$/, '').split('/');
      parts.pop();
      const parentDir = parts.join('/') || '/';

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'move_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [entry.path],
        destination: parentDir,
        newName: name,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const ctxCopy = () => {
      const entry = contextMenu.entry;
      hideContextMenu();
      if (!entry) return;

      const parts = entry.path.replace(/\/$/, '').split('/');
      parts.pop();
      const parentDir = parts.join('/') || '/';

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'copy_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [entry.path],
        destination: parentDir,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    const ctxMoveTo = () => {
      const entry = contextMenu.entry;
      hideContextMenu();
      if (!entry) return;
      selectedPaths.clear();
      selectedPaths.add(entry.path);
      openMoveDialog();
    };

    const ctxDelete = () => {
      const entry = contextMenu.entry;
      hideContextMenu();
      if (!entry) return;
      deleteSingleFile(entry);
    };

    const ctxDownload = () => {
      const entry = contextMenu.entry;
      hideContextMenu();
      if (!entry || entry.type !== 'file') return;
      pendingDownload = entry.path;
      store.sendWsMessage({
        type: 'read_file',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        filePath: entry.path,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    // ===========================
    // Drag & Drop (tree internal)
    // ===========================
    const onDragStart = (event, entry) => {
      dragState.dragging = entry;
      event.dataTransfer.setData('text/plain', entry.path);
      event.dataTransfer.effectAllowed = 'move';
    };

    const onDragOver = (event, entry) => {
      if (!dragState.dragging && event.dataTransfer.types.includes('Files')) {
        // External file drag
        if (entry.type === 'directory') {
          event.dataTransfer.dropEffect = 'copy';
          dragState.dropTarget = entry.path;
        }
        return;
      }
      if (!dragState.dragging || entry.type !== 'directory') return;
      // Don't allow drop on self or child
      if (entry.path === dragState.dragging.path) return;
      if (entry.path.startsWith(dragState.dragging.path + '/')) return;
      event.dataTransfer.dropEffect = 'move';
      dragState.dropTarget = entry.path;
    };

    const onDragLeave = (event) => {
      // Only clear if leaving to an element outside the current target
      const related = event.relatedTarget;
      if (related && event.currentTarget.contains(related)) return;
      dragState.dropTarget = null;
    };

    const onDrop = (event, entry) => {
      dragState.dropTarget = null;

      // External file drop onto a directory
      if (!dragState.dragging && event.dataTransfer.files.length > 0 && entry.type === 'directory') {
        handleExternalFileDrop(event.dataTransfer.files, entry.path);
        return;
      }

      if (!dragState.dragging || entry.type !== 'directory') {
        dragState.dragging = null;
        return;
      }
      if (entry.path === dragState.dragging.path) {
        dragState.dragging = null;
        return;
      }

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Operation timed out');
        }
      }, 15000);

      store.sendWsMessage({
        type: 'move_files',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        paths: [dragState.dragging.path],
        destination: entry.path,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });

      dragState.dragging = null;
    };

    // ===========================
    // External file drop (upload)
    // ===========================
    const onTreeDragOver = (event) => {
      // Only respond to external file drags
      if (dragState.dragging) return;
      if (event.dataTransfer.types.includes('Files')) {
        event.dataTransfer.dropEffect = 'copy';
        externalDropActive.value = true;
      }
    };

    const onTreeDragLeave = (event) => {
      const related = event.relatedTarget;
      if (related && event.currentTarget.contains(related)) return;
      externalDropActive.value = false;
    };

    const onTreeDrop = (event) => {
      externalDropActive.value = false;
      if (dragState.dragging) return; // Internal drag handled by tree items
      if (event.dataTransfer.files.length > 0) {
        // Drop on the tree root area — upload to treeRootPath
        const targetDir = treePath.value || treeRootPath.value || getEffectiveWorkDir();
        handleExternalFileDrop(event.dataTransfer.files, targetDir);
      }
    };

    const handleExternalFileDrop = async (fileList, targetDir) => {
      if (!targetDir) return;

      const files = [];
      const readPromises = [];

      for (const file of fileList) {
        readPromises.push(
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = btoa(
                new Uint8Array(reader.result).reduce((data, byte) => data + String.fromCharCode(byte), '')
              );
              files.push({ name: file.name, data: base64 });
              resolve();
            };
            reader.onerror = () => resolve(); // Skip failed reads
            reader.readAsArrayBuffer(file);
          })
        );
      }

      await Promise.all(readPromises);
      if (files.length === 0) return;

      fileOperating.value = true;
      if (fileOpTimer) clearTimeout(fileOpTimer);
      fileOpTimer = setTimeout(() => {
        if (fileOperating.value) {
          fileOperating.value = false;
          showFileOpFeedback(false, 'Upload timed out');
        }
      }, 30000); // Longer timeout for uploads

      store.sendWsMessage({
        type: 'upload_to_dir',
        conversationId: store.currentConversation || '_explorer',
        agentId: store.currentAgent,
        files,
        dirPath: targetDir,
        workDir: getEffectiveWorkDir(),
        _clientId: store.clientId
      });
    };

    // ===========================
    // Handle messages from server
    // ===========================
    const handleWorkbenchMessage = (event) => {
      const msg = event.detail;
      if (!msg) return;

      switch (msg.type) {
        case 'directory_listing': {
          // Route to folder picker if applicable
          if (msg.conversationId === '_folder_picker') {
            folderPickerLoading.value = false;
            folderPickerEntries.value = (msg.entries || [])
              .filter(e => e.type === 'directory')
              .sort((a, b) => a.name.localeCompare(b.name));
            if (msg.dirPath != null) folderPickerPath.value = msg.dirPath;
            return;
          }

          const nDirPath = normalizePath(msg.dirPath);
          if (msg.error) {
            if (treeNodes[nDirPath]) {
              treeNodes[nDirPath].loading = false;
            }
            return;
          }
          const entries = (msg.entries || []).sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
          });
          const basePath = nDirPath.replace(/\/$/, '');
          const enriched = entries.map(e => ({
            ...e,
            path: basePath + '/' + e.name
          }));

          if (!treeNodes[nDirPath]) {
            treeNodes[nDirPath] = { entries: enriched, expanded: true, loaded: true, loading: false };
          } else {
            treeNodes[nDirPath].entries = enriched;
            treeNodes[nDirPath].loaded = true;
            treeNodes[nDirPath].loading = false;
          }

          // Update treePath display if this is the root
          if (nDirPath === treeRootPath.value) {
            treePath.value = msg.dirPath;
          }
          break;
        }
        case 'file_content': {
          fileLoading.value = false;
          if (msg.error) {
            debugStatus.value = `Error: ${msg.error}`;
            pendingDownload = null;
            // Reset preview loading state for the file tab
            const errFilePath = normalizePath(msg.filePath);
            const errTab = openFiles.value.find(f => f.path === errFilePath);
            if (errTab) {
              errTab.previewLoading = false;
              errTab.previewError = msg.error;
            }
            return;
          }
          const nFilePath = normalizePath(msg.filePath);

          // Handle pending download
          if (pendingDownload && normalizePath(pendingDownload) === nFilePath) {
            pendingDownload = null;
            try {
              if (msg.binary) {
                // Binary: download via preview endpoint
                const dlUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
                const a = document.createElement('a');
                a.href = dlUrl;
                a.download = nFilePath.split('/').pop() || 'download';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              } else {
                const blob = new Blob([msg.content || ''], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = nFilePath.split('/').pop() || 'download';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }
            } catch (e) {
              console.error('Download failed:', e);
            }
            return;
          }

          const tabIndex = openFiles.value.findIndex(f => f.path === nFilePath);
          if (tabIndex >= 0) {
            const file = openFiles.value[tabIndex];

            // Binary file (Office / PDF / Image)
            if (msg.binary) {
              file.previewLoading = false;
              const previewBaseUrl = `${location.protocol}//${location.host}/api/preview/${msg.fileId}?token=${msg.previewToken}`;
              const ft = file.fileType || getFileType(file.name);
              file.fileType = ft;

              if (ft === 'pdf' || ft === 'image') {
                // Fetch binary and create local blob URL
                fetch(previewBaseUrl)
                  .then(r => r.blob())
                  .then(blob => {
                    file.blobUrl = URL.createObjectURL(blob);
                  })
                  .catch(e => { file.previewError = e.message; });
              } else if (ft === 'office') {
                const mode = localStorage.getItem('officePreviewMode') || 'local';
                if (mode === 'online') {
                  // Office Online iframe
                  file.previewUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewBaseUrl);
                } else {
                  // Local rendering
                  fetch(previewBaseUrl)
                    .then(r => r.arrayBuffer())
                    .then(buf => {
                      file._arrayBuffer = buf;
                      file.localPreviewReady = true;
                      if (tabIndex === activeFileIndex.value) {
                        Vue.nextTick(() => renderOfficeLocal(file));
                      }
                    })
                    .catch(e => { file.previewError = e.message; });
                }
              }
              saveTabsState(store.currentConversation);
              return;
            }

            // Text file
            file.content = msg.content || '';
            file.originalContent = msg.content || '';
            file.isDirty = false;
            saveTabsState(store.currentConversation);
            if (tabIndex === activeFileIndex.value) {
              Vue.nextTick(() => {
                setTimeout(() => {
                  createEditor(file);
                }, 100);
              });
            }
          }
          break;
        }
        case 'file_saved': {
          fileSaving.value = false;
          if (msg.error) {
            console.error('File save failed:', msg.error);
            return;
          }
          const nSavedPath = normalizePath(msg.filePath);
          const savedFile = openFiles.value.find(f => f.path === nSavedPath);
          if (savedFile) {
            savedFile.originalContent = savedFile.content;
            savedFile.isDirty = false;
            saveTabsState(store.currentConversation);
          }
          break;
        }
        case 'file_search_result': {
          const results = msg.results || [];
          if (quickOpenVisible.value) {
            // Only accept results matching current query to avoid stale results
            if (msg.query && msg.query.trim() === quickOpenQuery.value.trim()) {
              quickOpenResults.value = results;
              quickOpenLoading.value = false;
              quickOpenSelectedIndex.value = 0;
            }
          } else {
            // Only accept results matching current query to avoid stale results
            if (msg.query && msg.query.trim() === searchQuery.value.trim()) {
              searchResults.value = results;
              searchLoading.value = false;
            }
          }
          break;
        }
        case 'file_op_result': {
          fileOperating.value = false;
          if (fileOpTimer) { clearTimeout(fileOpTimer); fileOpTimer = null; }
          showFileOpFeedback(msg.success, msg.success ? msg.message : (msg.error || 'Operation failed'));
          if (msg.success) {
            // Refresh tree
            if (treeRootPath.value) loadTreeDirectory(treeRootPath.value);
            // Clear selection after successful delete/move
            if (msg.operation === 'delete' || msg.operation === 'move') {
              selectedPaths.clear();
              lastClickedIndex.value = -1;
            }
          }
          break;
        }
        case 'file_tabs_restored': {
          // ★ Server 返回保存的文件 tabs — 打开这些文件
          if (msg.openFiles?.length > 0 && openFiles.value.length === 0) {
            const pendingRestoreIndex = msg.activeIndex || 0;
            let loadedCount = 0;
            const totalFiles = msg.openFiles.length;

            for (const file of msg.openFiles) {
              const nPath = normalizePath(file.path);
              const name = nPath.split('/').pop();
              const fileType = getFileType(name);
              openFiles.value.push({
                path: nPath,
                name,
                content: null,
                originalContent: null,
                isDirty: false,
                cmInstance: null,
                fileType,
                blobUrl: null,
                previewUrl: null,
                previewLoading: fileType !== 'text',
                localPreviewReady: false,
                previewError: null
              });
              // 请求文件内容
              store.sendWsMessage({
                type: 'read_file',
                conversationId: store.currentConversation || '_explorer',
                agentId: store.currentAgent,
                filePath: file.path
              });
            }

            // 设置 active index
            if (pendingRestoreIndex >= 0 && pendingRestoreIndex < totalFiles) {
              activeFileIndex.value = pendingRestoreIndex;
            } else {
              activeFileIndex.value = 0;
            }
          }
          break;
        }
      }
    };

    const handleOpenFile = (event) => {
      const { filePath: path } = event.detail;
      const nPath = normalizePath(path);
      const name = nPath.split('/').pop();
      openFileInTab(nPath, name);
    };

    // 清理已删除会话的缓存资源
    const handleConversationDeleted = (event) => {
      const { conversationId } = event.detail;
      if (conversationId) {
        delete fileTabsMap[conversationId];
        delete undoHistoryMap[conversationId];
      }
    };

    // ===========================
    // Init
    // ===========================
    const initFileBrowser = () => {
      const dir = getEffectiveWorkDir();
      if (dir) {
        const nDir = normalizePath(dir);
        treePath.value = dir;
        treeRootPath.value = nDir;
        Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
        loadTreeDirectory(dir);
      }
    };

    const refresh = () => {
      if (treeRootPath.value) {
        loadTreeDirectory(treeRootPath.value);
      }
    };

    // ===========================
    // Watchers
    // ===========================

    // Watch agent changes
    Vue.watch(() => store.currentAgent, () => {
      saveTabsState(store.currentConversation);
      destroyEditor();
      Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
      openFiles.value = [];
      activeFileIndex.value = -1;
      fileLoading.value = false;
      if (store.currentAgent) {
        Vue.nextTick(() => initFileBrowser());
      }
    });

    // Watch conversation changes
    let previousConversation = store.currentConversation;
    Vue.watch(() => store.currentConversation, (newConv) => {
      saveTabsState(previousConversation);
      previousConversation = newConv;
      restoreTabsState(newConv);

      const dir = getEffectiveWorkDir();
      const nDir = normalizePath(dir);
      if (dir && nDir !== treeRootPath.value) {
        treePath.value = dir;
        treeRootPath.value = nDir;
        Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
        loadTreeDirectory(dir);
      }
    });

    // Watch theme changes — update CodeMirror theme
    Vue.watch(() => store.theme, (newTheme) => {
      const cmTheme = newTheme === 'dark' ? 'material-darker' : 'default';
      const file = activeFile.value;
      if (file?.cmInstance) {
        file.cmInstance.setOption('theme', cmTheme);
      }
    });

    // Watch workDir changes — auto-load tree if not yet loaded
    Vue.watch(() => getEffectiveWorkDir(), (dir) => {
      if (dir && !treeRootPath.value) {
        const nDir = normalizePath(dir);
        treePath.value = dir;
        treeRootPath.value = nDir;
        Object.keys(treeNodes).forEach(k => delete treeNodes[k]);
        loadTreeDirectory(dir);
      }
    });

    // Watch activeFile content — auto-create editor when content arrives
    // Note: file_content handler also calls createEditor, but the check for cmInstance prevents double creation
    Vue.watch(
      () => activeFile.value?.content,
      (newContent, oldContent) => {
        const file = activeFile.value;
        if (file && newContent != null && oldContent == null && !file.cmInstance && (!file.fileType || file.fileType === 'text')) {
          Vue.nextTick(() => {
            setTimeout(() => {
              if (!file.cmInstance) {
                createEditor(file);
              }
            }, 150);
          });
        }
      }
    );

    // ===========================
    // Global keyboard shortcuts
    // ===========================
    const handleGlobalKeydown = (e) => {
      // Only handle shortcuts when Files tab is visible
      const isVisible = rootEl.value && rootEl.value.offsetParent !== null;
      if (!isVisible && !quickOpenVisible.value && !goToLineVisible.value && !findBarVisible.value) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        if (quickOpenVisible.value) {
          closeQuickOpen();
        } else {
          openQuickOpen();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        if (goToLineVisible.value) {
          closeGoToLine();
        } else {
          openGoToLine();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (activeFile.value) {
          e.preventDefault();
          openFindBar(false);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'h')) {
        if (activeFile.value) {
          e.preventDefault();
          openFindBar(true);
        }
      } else if (e.key === 'Escape') {
        if (findBarVisible.value) closeFindBar();
        if (selectedPaths.size > 0) clearSelection();
        if (quickOpenVisible.value) closeQuickOpen();
        if (goToLineVisible.value) closeGoToLine();
      }
    };

    const handleDocumentClick = () => { hideContextMenu(); };

    Vue.onMounted(() => {
      window.addEventListener('workbench-message', handleWorkbenchMessage);
      window.addEventListener('open-file-in-explorer', handleOpenFile);
      window.addEventListener('conversation-deleted', handleConversationDeleted);
      window.addEventListener('keydown', handleGlobalKeydown);
      document.addEventListener('click', handleDocumentClick);
      if (store.currentAgent) {
        initFileBrowser();
        // ★ 请求恢复文件 tabs
        store.sendWsMessage({ type: 'restore_file_tabs' });
      }
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('workbench-message', handleWorkbenchMessage);
      window.removeEventListener('open-file-in-explorer', handleOpenFile);
      window.removeEventListener('conversation-deleted', handleConversationDeleted);
      window.removeEventListener('keydown', handleGlobalKeydown);
      document.removeEventListener('click', handleDocumentClick);
      destroyEditor();
      if (fileOpFeedbackTimer) clearTimeout(fileOpFeedbackTimer);
      if (fileOpTimer) clearTimeout(fileOpTimer);
    });

    return {
      store, debugStatus, rootEl,
      fontSize, zoomIn, zoomOut, onWheel,
      treePath, treeRootPath, treeNodes, flattenedTree,
      editingTreePath, treePathInputRef, rootFolderName, rootExpanded,
      toggleRootExpand, collapseAll, startTreePathEdit, confirmTreePath, cancelTreePathEdit,
      treePanelWidth, isTreeResizing, startTreeResize,
      openFiles, activeFileIndex, activeFile, fileLoading, fileSaving,
      editorContainer, officePreviewContainer,
      folderPickerOpen, folderPickerPath, folderPickerEntries, folderPickerLoading, folderPickerSelected,
      searchQuery, searchResults, searchLoading, onSearchInput, clearSearch, onSearchResultClick,
      quickOpenVisible, quickOpenQuery, quickOpenResults, quickOpenSelectedIndex, quickOpenLoading, quickOpenInput,
      openQuickOpen, closeQuickOpen, onQuickOpenInput,
      quickOpenSelectNext, quickOpenSelectPrev, quickOpenConfirm, quickOpenOpenFile,
      goToLineVisible, goToLineValue, goToLineInput, openGoToLine, closeGoToLine, goToLineConfirm,
      // Find/Replace
      findBarVisible, replaceBarVisible, findQuery, replaceQuery,
      findCaseSensitive, findUseRegex, findMatchCount, findMatchIndex,
      findInputRef, replaceInputRef,
      onFindInput, findNext, findPrev, openFindBar, closeFindBar, toggleReplaceBar, replaceOne, replaceAll,
      // File operations
      selectedPaths, fileOperating, fileOpFeedback,
      newFileDialogVisible, newFileName, newFileType, newFileInput,
      moveDialogVisible, moveDestination, moveDestInput,
      toggleSelection, clearSelection,
      showNewFileDialog, confirmNewFile,
      deleteSingleFile, deleteSelected,
      openMoveDialog, confirmMove,
      // Context menu
      contextMenu, showContextMenu, hideContextMenu,
      ctxRename, ctxCopy, ctxMoveTo, ctxDelete, ctxDownload,
      renameDialogVisible, renameNewName, renameInput, confirmRename,
      // Drag & drop
      dragState, externalDropActive,
      onDragStart, onDragOver, onDragLeave, onDrop,
      onTreeDragOver, onTreeDragLeave, onTreeDrop,
      loadRootDirectory, onTreeItemClick, openFileInTab,
      switchToTab, closeFileTab, saveFile,
      openFolderPicker, folderPickerNavigateUp, folderPickerSelectItem, folderPickerEnter, confirmFolderPicker,
      getFileIcon, getFileIconHtml, getFolderIcon, formatSize, refresh, placeholderPath,
    };
  }
};
