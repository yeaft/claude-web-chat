/**
 * folder-picker-mixin — shared "browse + pick a directory" workflow.
 *
 * Originally extracted so SessionCreateModal and the standalone
 * SessionRestoreModal could share the same folder-picker UX without
 * copying 90 lines of glue. The restore modal was later folded back into
 * SessionCreateModal; WorkCenterPage now also consumes the mixin for its
 * project directory field. The mixin owns:
 *
 *  - Data:   folderPickerOpen / folderPickerPath / folderPickerEntries /
 *            folderPickerLoading / folderPickerSelected / _folderPickerTimer /
 *            _folderPickerRequestId / _folderPickerRequestAgentId
 *  - Methods: openFolderPicker / closeFolderPicker / requestFolderPickerDir /
 *             loadFolderPickerDir / folderPickerNavigateUp /
 *             folderPickerSelectItem / folderPickerEnter / confirmFolderPicker /
 *             handleFolderPickerMessage
 *
 * Components consuming this mixin must provide:
 *  - computed `folderPickerAgentId` — string, currently-targeted agent id.
 *  - computed `defaultWorkDir` — string, workdir to seed picker if none set.
 *  - computed `chat` — chat store (must expose `sendWsMessage`).
 *  - method   `folderPickerInitialDir()` — string, dir to open the picker at
 *                                          (typically `this.workDir || this.defaultWorkDir`).
 *  - method   `folderPickerSetWorkDir(path)` — called when user confirms a path.
 *
 * The wire shape is pinned by folder-picker tests:
 *  - sends `{ type:'list_directory', conversationId:'_workdir_picker', requestId, agentId, dirPath, workDir }`
 *  - listens to `workbench-message` window events; reducer accepts only the
 *    current requestId while the picker is open and still targets the same agent.
 * Do not rename `requestFolderPickerDir` / `handleFolderPickerMessage`.
 *
 * ⚠️  CONSUMPTION HAZARD — DO NOT do this:
 *     export default { mixins: [folderPickerMixin], ...{ data() {...}, methods: {...} } }
 *
 * Some components historically spread their own `data` / `methods` over the
 * mixin object. That works for pure-options merges but DOUBLE-REGISTERS the
 * picker's lifecycle hooks if Vue ever changes its merge strategy — and it
 * silently shadows the picker's own `data()` keys when the consumer also
 * returns an object literal. The supported form is the explicit
 * `mixins: [folderPickerMixin]` array on the component options object. See
 * SessionCreateModal.js for the working example.
 */

export const folderPickerData = () => ({
  folderPickerOpen: false,
  folderPickerPath: '',
  folderPickerEntries: [],
  folderPickerLoading: false,
  folderPickerSelected: '',
  _folderPickerTimer: null,
  _folderPickerRequestId: null,
  _folderPickerRequestAgentId: null,
});

let folderPickerRequestSequence = 0;

function nextFolderPickerRequestId() {
  folderPickerRequestSequence += 1;
  return `folder-picker-${Date.now()}-${folderPickerRequestSequence}`;
}

export const folderPickerMethods = {
  openFolderPicker() {
    const agentId = this.folderPickerAgentId;
    if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
    this.folderPickerOpen = true;
    this.folderPickerSelected = '';
    this.folderPickerLoading = true;
    const initial = typeof this.folderPickerInitialDir === 'function'
      ? (this.folderPickerInitialDir() || '')
      : (this.defaultWorkDir || '');
    this.folderPickerPath = initial;
    this.folderPickerEntries = [];
    this.requestFolderPickerDir(initial);
  },

  invalidateFolderPickerRequest() {
    this._folderPickerRequestId = null;
    this._folderPickerRequestAgentId = null;
    if (this._folderPickerTimer) {
      clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = null;
    }
  },

  closeFolderPicker() {
    this.folderPickerOpen = false;
    this.invalidateFolderPickerRequest();
  },

  requestFolderPickerDir(dirPath) {
    const agentId = this.folderPickerAgentId;
    if (!agentId || !this.chat || typeof this.chat.sendWsMessage !== 'function') return;
    const requestId = nextFolderPickerRequestId();
    this._folderPickerRequestId = requestId;
    this._folderPickerRequestAgentId = agentId;
    this.chat.sendWsMessage({
      type: 'list_directory',
      conversationId: '_workdir_picker',
      requestId,
      agentId,
      dirPath,
      workDir: this.defaultWorkDir || '',
    });
    if (this._folderPickerTimer) clearTimeout(this._folderPickerTimer);
    this._folderPickerTimer = setTimeout(() => {
      if (this.folderPickerLoading && this.folderPickerOpen
          && this._folderPickerRequestId === requestId
          && this.folderPickerAgentId === agentId) {
        this.requestFolderPickerDir(dirPath);
      }
    }, 5000);
  },

  loadFolderPickerDir(dirPath) {
    this.folderPickerLoading = true;
    this.folderPickerSelected = '';
    this.folderPickerEntries = [];
    this.requestFolderPickerDir(dirPath);
  },

  folderPickerNavigateUp() {
    if (!this.folderPickerPath) return;
    const isWin = this.folderPickerPath.includes('\\');
    const sep = isWin ? '\\' : '/';
    const parts = this.folderPickerPath.replace(/[/\\]$/, '').split(/[/\\]/);
    parts.pop();
    if (parts.length === 0) {
      this.folderPickerPath = '';
      this.loadFolderPickerDir('');
    } else if (isWin && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) {
      this.folderPickerPath = parts[0] + '\\';
      this.loadFolderPickerDir(this.folderPickerPath);
    } else {
      const parent = parts.join(sep);
      this.folderPickerPath = parent;
      this.loadFolderPickerDir(parent);
    }
  },

  folderPickerSelectItem(entry) { this.folderPickerSelected = entry.name; },

  folderPickerEnter(entry) {
    const isWin = this.folderPickerPath.includes('\\') || /^[A-Z]:/.test(entry.name);
    const sep = isWin ? '\\' : '/';
    let newPath;
    if (!this.folderPickerPath) {
      newPath = /^[A-Z]:$/.test(entry.name) ? entry.name + '\\' : '/' + entry.name;
    } else {
      newPath = this.folderPickerPath.replace(/[/\\]$/, '') + sep + entry.name;
    }
    this.folderPickerPath = newPath;
    this.loadFolderPickerDir(newPath);
  },

  confirmFolderPicker() {
    let path = this.folderPickerPath;
    if (!path) return;
    if (this.folderPickerSelected) {
      const sep = path.includes('\\') ? '\\' : '/';
      path = path.replace(/[/\\]$/, '') + sep + this.folderPickerSelected;
    }
    if (typeof this.folderPickerSetWorkDir === 'function') {
      this.folderPickerSetWorkDir(path);
    }
    this.closeFolderPicker();
  },

  handleFolderPickerMessage(event) {
    const msg = event.detail;
    if (!msg || msg.type !== 'directory_listing' || msg.conversationId !== '_workdir_picker') return;
    if (!this.folderPickerOpen
        || !this._folderPickerRequestId
        || msg.requestId !== this._folderPickerRequestId
        || this.folderPickerAgentId !== this._folderPickerRequestAgentId) return;
    if (this._folderPickerTimer) {
      clearTimeout(this._folderPickerTimer);
      this._folderPickerTimer = null;
    }
    this._folderPickerRequestId = null;
    this._folderPickerRequestAgentId = null;
    this.folderPickerLoading = false;
    this.folderPickerEntries = (msg.entries || [])
      .filter(e => e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    if (msg.dirPath != null) this.folderPickerPath = msg.dirPath;
  },
};

/**
 * Convenience Options-API mixin object. Components can either:
 *   1. Spread the named exports above into their own data/methods, or
 *   2. Add this object to their `mixins: []`.
 *
 * SessionCreateModal uses option 1 to keep its tightly-co-located workdir
 * picker logic obvious. Future consumers with no other state to mix in
 * may prefer option 2.
 */
export const folderPickerMixin = {
  data() { return folderPickerData(); },
  methods: { ...folderPickerMethods },
  mounted() {
    window.addEventListener('workbench-message', this.handleFolderPickerMessage);
  },
  beforeUnmount() {
    window.removeEventListener('workbench-message', this.handleFolderPickerMessage);
    this.invalidateFolderPickerRequest();
  },
};

export default folderPickerMixin;
