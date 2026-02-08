class Plugin {
  constructor(workspace) {
    this.workspace = workspace;

    this.blockType = 'secure_token_for_codegen';
    this.toolboxCategoryName = 'Token';
    this.toolboxCategoryColor = '#c0392b';
    this.shareScreenshotNotice =
      'セキュリティ保護のため、このプロジェクトの共有画像は撮影できません。';

    this.toolboxCategoryElement = null;
    this.originalSerializationSave = null;
    this.originalCanvasToDataURL = null;

    this.boundOnShowCodeClick = null;
    this.boundOnSplitCodeClick = null;
    this.boundOnDocumentCaptureClick = null;
    this.boundOnWorkspaceChange = null;

    this.codeOutputObserver = null;
    this.codePreviewObserver = null;
    this.splitListObserver = null;

    this.tokenUtilityBarEl = null;
    this.tokenStatusTextEl = null;
    this.tokenFocusBtnEl = null;
    this.tokenClearBtnEl = null;
    this.boundOnTokenFocusClick = null;
    this.boundOnTokenClearClick = null;

    this.shareUiEnforceTimer = null;
    this.workspaceChangeDebounceTimer = null;
  }

  async onload() {
    if (typeof Blockly === 'undefined') {
      console.warn('Secure Token Plugin: Blockly is not available.');
      return;
    }

    this.registerTokenBlock();
    this.addToolboxCategory();
    this.patchWorkspaceSerialization();
    this.patchShareScreenshotCapture();
    this.installCodeReplacementHooks();
    this.startUiObservers();
    this.createTokenUtilityBar();

    // Initial sync for already-rendered UI.
    this.applyTokenToVisibleCode();
    this.enforceShareThumbnailNotice();
    this.updateTokenUtilityBar();

    console.log('Secure Token Block Plugin loaded.');
  }

  async onunload() {
    this.stopUiObservers();
    this.removeCodeReplacementHooks();
    this.restoreShareScreenshotCapture();
    this.restoreWorkspaceSerialization();
    this.removeToolboxCategory();
    this.unregisterTokenBlock();
    this.removeTokenUtilityBar();

    if (this.shareUiEnforceTimer) {
      clearInterval(this.shareUiEnforceTimer);
      this.shareUiEnforceTimer = null;
    }

    if (this.workspaceChangeDebounceTimer) {
      clearTimeout(this.workspaceChangeDebounceTimer);
      this.workspaceChangeDebounceTimer = null;
    }

    console.log('Secure Token Block Plugin unloaded.');
  }

  registerTokenBlock() {
    if (!Blockly?.Blocks) return;

    const blockType = this.blockType;

    Blockly.Blocks[blockType] = {
      init: function () {
        const digitsOnlyValidator = (value) => String(value ?? '').replace(/[^0-9]/g, '');
        this.appendDummyInput()
          .appendField('BotToken')
          .appendField(new Blockly.FieldTextInput('', digitsOnlyValidator), 'TOKEN');
        this.setColour(6);
        this.setTooltip(
          '生成コードの TOKEN をこの値に置き換えます。数字のみ入力できます。値は共有データ・localStorage に保存されません。',
        );
      },
    };

    const generatorFn = () => '';

    if (Blockly.Python?.forBlock) {
      Blockly.Python.forBlock[blockType] = generatorFn;
    }

    // Backward compatibility with legacy generator registration style.
    if (Blockly.Python) {
      Blockly.Python[blockType] = generatorFn;
    }
  }

  unregisterTokenBlock() {
    if (typeof Blockly === 'undefined') return;

    if (Blockly.Blocks && Blockly.Blocks[this.blockType]) {
      delete Blockly.Blocks[this.blockType];
    }

    if (Blockly.Python?.forBlock && Blockly.Python.forBlock[this.blockType]) {
      delete Blockly.Python.forBlock[this.blockType];
    }

    if (Blockly.Python && Blockly.Python[this.blockType]) {
      delete Blockly.Python[this.blockType];
    }
  }

  addToolboxCategory() {
    const toolbox = document.getElementById('toolbox');
    if (!toolbox) return;

    let category = toolbox.querySelector(`category[name="${this.toolboxCategoryName}"]`);

    if (!category) {
      category = document.createElement('category');
      category.setAttribute('name', this.toolboxCategoryName);
      category.setAttribute('data-icon', '🔐');
      category.setAttribute('colour', this.toolboxCategoryColor);
      toolbox.appendChild(category);
    }

    if (!category.querySelector(`block[type="${this.blockType}"]`)) {
      const block = document.createElement('block');
      block.setAttribute('type', this.blockType);
      category.appendChild(block);
    }

    this.toolboxCategoryElement = category;

    if (this.workspace?.updateToolbox) {
      this.workspace.updateToolbox(toolbox);
    }
  }

  removeToolboxCategory() {
    const toolbox = document.getElementById('toolbox');
    if (!toolbox) return;

    const category =
      this.toolboxCategoryElement ||
      toolbox.querySelector(`category[name="${this.toolboxCategoryName}"]`);

    if (category) {
      category.remove();
      this.toolboxCategoryElement = null;

      if (this.workspace?.updateToolbox) {
        this.workspace.updateToolbox(toolbox);
      }
    }
  }

  patchWorkspaceSerialization() {
    const serializer = Blockly?.serialization?.workspaces;
    if (!serializer || typeof serializer.save !== 'function') {
      return;
    }

    if (this.originalSerializationSave) {
      return;
    }

    this.originalSerializationSave = serializer.save.bind(serializer);

    const plugin = this;
    serializer.save = function (...args) {
      const raw = plugin.originalSerializationSave(...args);
      return plugin.sanitizeSerializedWorkspace(raw);
    };
  }

  restoreWorkspaceSerialization() {
    const serializer = Blockly?.serialization?.workspaces;
    if (!serializer || !this.originalSerializationSave) {
      return;
    }

    serializer.save = this.originalSerializationSave;
    this.originalSerializationSave = null;
  }

  sanitizeSerializedWorkspace(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeSerializedWorkspace(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const cloned = {};
    const isSecureTokenBlock = value.type === this.blockType;

    for (const [key, innerValue] of Object.entries(value)) {
      if (isSecureTokenBlock && key === 'fields' && innerValue && typeof innerValue === 'object') {
        const fields = {};
        for (const [fieldKey, fieldValue] of Object.entries(innerValue)) {
          fields[fieldKey] = fieldKey === 'TOKEN' ? '' : this.sanitizeSerializedWorkspace(fieldValue);
        }
        if (!Object.prototype.hasOwnProperty.call(fields, 'TOKEN')) {
          fields.TOKEN = '';
        }
        cloned[key] = fields;
        continue;
      }

      cloned[key] = this.sanitizeSerializedWorkspace(innerValue);
    }

    if (isSecureTokenBlock) {
      if (!cloned.fields || typeof cloned.fields !== 'object') {
        cloned.fields = { TOKEN: '' };
      } else {
        cloned.fields.TOKEN = '';
      }
    }

    return cloned;
  }

  patchShareScreenshotCapture() {
    if (typeof HTMLCanvasElement === 'undefined') {
      return;
    }

    if (this.originalCanvasToDataURL) {
      return;
    }

    this.originalCanvasToDataURL = HTMLCanvasElement.prototype.toDataURL;

    const plugin = this;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      if (plugin.isShareModalOpen()) {
        // Force thumbnail generation failure while share modal is open.
        return '';
      }
      return plugin.originalCanvasToDataURL.apply(this, args);
    };

    this.shareUiEnforceTimer = setInterval(() => {
      plugin.enforceShareThumbnailNotice();
    }, 200);
  }

  restoreShareScreenshotCapture() {
    if (!this.originalCanvasToDataURL || typeof HTMLCanvasElement === 'undefined') {
      return;
    }

    HTMLCanvasElement.prototype.toDataURL = this.originalCanvasToDataURL;
    this.originalCanvasToDataURL = null;
  }

  isShareModalOpen() {
    const modal = document.getElementById('shareModal');
    return !!modal && !modal.classList.contains('hidden');
  }

  enforceShareThumbnailNotice() {
    if (!this.isShareModalOpen()) {
      return;
    }

    const wrapperEl = document.getElementById('shareThumbnailWrapper');
    const imageEl = document.getElementById('shareThumbnailImage');
    const messageEl = document.getElementById('shareThumbnailMessage');
    const copyBtn = document.getElementById('shareThumbnailCopyBtn');

    if (imageEl) {
      imageEl.classList.add('hidden');
      imageEl.removeAttribute('src');
    }

    if (wrapperEl) {
      wrapperEl.classList.add('opacity-70');
    }

    if (messageEl) {
      messageEl.classList.remove('hidden');
      messageEl.textContent = this.shareScreenshotNotice;
    }

    if (copyBtn) {
      copyBtn.disabled = true;
      copyBtn.setAttribute('title', this.shareScreenshotNotice);
    }
  }

  installCodeReplacementHooks() {
    const showCodeBtn = document.getElementById('showCodeBtn');
    const splitCodeBtn = document.getElementById('splitCodeBtn');

    this.boundOnShowCodeClick = () => {
      setTimeout(() => {
        this.applyTokenToVisibleCode();
      }, 0);
    };

    this.boundOnSplitCodeClick = () => {
      setTimeout(() => {
        this.applyTokenToVisibleCode();
      }, 0);
    };

    this.boundOnDocumentCaptureClick = (event) => {
      this.handleSplitActionCapture(event);
    };

    this.boundOnWorkspaceChange = () => {
      if (this.workspaceChangeDebounceTimer) {
        clearTimeout(this.workspaceChangeDebounceTimer);
      }
      this.workspaceChangeDebounceTimer = setTimeout(() => {
        this.applyTokenToVisibleCode();
        this.updateTokenUtilityBar();
      }, 0);
    };

    if (showCodeBtn) {
      showCodeBtn.addEventListener('click', this.boundOnShowCodeClick);
    }

    if (splitCodeBtn) {
      splitCodeBtn.addEventListener('click', this.boundOnSplitCodeClick);
    }

    document.addEventListener('click', this.boundOnDocumentCaptureClick, true);

    if (this.workspace?.addChangeListener) {
      this.workspace.addChangeListener(this.boundOnWorkspaceChange);
    }
  }

  removeCodeReplacementHooks() {
    const showCodeBtn = document.getElementById('showCodeBtn');
    const splitCodeBtn = document.getElementById('splitCodeBtn');

    if (showCodeBtn && this.boundOnShowCodeClick) {
      showCodeBtn.removeEventListener('click', this.boundOnShowCodeClick);
    }

    if (splitCodeBtn && this.boundOnSplitCodeClick) {
      splitCodeBtn.removeEventListener('click', this.boundOnSplitCodeClick);
    }

    if (this.boundOnDocumentCaptureClick) {
      document.removeEventListener('click', this.boundOnDocumentCaptureClick, true);
    }

    if (this.workspace?.removeChangeListener && this.boundOnWorkspaceChange) {
      this.workspace.removeChangeListener(this.boundOnWorkspaceChange);
    }

    this.boundOnShowCodeClick = null;
    this.boundOnSplitCodeClick = null;
    this.boundOnDocumentCaptureClick = null;
    this.boundOnWorkspaceChange = null;
  }

  startUiObservers() {
    const codeOutput = document.getElementById('codeOutput');
    const codePreview = document.getElementById('codePreviewContent');
    const splitFileList = document.getElementById('splitFileList');

    if (codeOutput) {
      this.codeOutputObserver = new MutationObserver(() => this.applyTokenToVisibleCode());
      this.codeOutputObserver.observe(codeOutput, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }

    if (codePreview) {
      this.codePreviewObserver = new MutationObserver(() => this.applyTokenToVisibleCode());
      this.codePreviewObserver.observe(codePreview, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }

    if (splitFileList) {
      this.splitListObserver = new MutationObserver(() => this.applyTokenToVisibleCode());
      this.splitListObserver.observe(splitFileList, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
  }

  stopUiObservers() {
    if (this.codeOutputObserver) {
      this.codeOutputObserver.disconnect();
      this.codeOutputObserver = null;
    }

    if (this.codePreviewObserver) {
      this.codePreviewObserver.disconnect();
      this.codePreviewObserver = null;
    }

    if (this.splitListObserver) {
      this.splitListObserver.disconnect();
      this.splitListObserver = null;
    }
  }

  createTokenUtilityBar() {
    if (this.tokenUtilityBarEl) return;

    const host = document.getElementById('headerActions') || document.body;
    const bar = document.createElement('div');
    bar.id = 'secureTokenUtilityBar';

    if (host.id === 'headerActions') {
      bar.className =
        'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-xs font-semibold';
    } else {
      bar.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:#111827;color:#f9fafb;font-size:12px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);';
    }

    const status = document.createElement('span');
    status.textContent = 'Token: 未設定';
    status.style.whiteSpace = 'nowrap';

    const focusBtn = document.createElement('button');
    focusBtn.type = 'button';
    focusBtn.textContent = '移動';
    focusBtn.className = 'px-2 py-1 rounded border border-slate-300 bg-white text-slate-700 text-xs';
    focusBtn.title = 'Tokenブロックへ移動';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '全消去';
    clearBtn.className = 'px-2 py-1 rounded border border-rose-300 bg-rose-50 text-rose-700 text-xs';
    clearBtn.title = 'すべてのTokenブロック入力値を消去';

    this.boundOnTokenFocusClick = () => this.focusTokenBlock();
    this.boundOnTokenClearClick = () => this.clearTokenValues();
    focusBtn.addEventListener('click', this.boundOnTokenFocusClick);
    clearBtn.addEventListener('click', this.boundOnTokenClearClick);

    bar.appendChild(status);
    bar.appendChild(focusBtn);
    bar.appendChild(clearBtn);
    host.appendChild(bar);

    this.tokenUtilityBarEl = bar;
    this.tokenStatusTextEl = status;
    this.tokenFocusBtnEl = focusBtn;
    this.tokenClearBtnEl = clearBtn;
  }

  removeTokenUtilityBar() {
    if (this.tokenFocusBtnEl && this.boundOnTokenFocusClick) {
      this.tokenFocusBtnEl.removeEventListener('click', this.boundOnTokenFocusClick);
    }
    if (this.tokenClearBtnEl && this.boundOnTokenClearClick) {
      this.tokenClearBtnEl.removeEventListener('click', this.boundOnTokenClearClick);
    }
    if (this.tokenUtilityBarEl) {
      this.tokenUtilityBarEl.remove();
    }

    this.tokenUtilityBarEl = null;
    this.tokenStatusTextEl = null;
    this.tokenFocusBtnEl = null;
    this.tokenClearBtnEl = null;
    this.boundOnTokenFocusClick = null;
    this.boundOnTokenClearClick = null;
  }

  getTokenBlocks() {
    if (!this.workspace?.getAllBlocks) {
      return [];
    }
    return (this.workspace.getAllBlocks(false) || []).filter((block) => block?.type === this.blockType);
  }

  getFirstTokenBlock() {
    const blocks = this.getTokenBlocks();
    return blocks.length ? blocks[0] : null;
  }

  focusTokenBlock() {
    const block = this.getFirstTokenBlock();
    if (!block) return;

    try {
      if (typeof this.workspace?.centerOnBlock === 'function') {
        this.workspace.centerOnBlock(block.id || block);
      }
      block.select?.();
      block.bringToFront?.();
    } catch (error) {
      console.warn('Failed to focus token block', error);
    }
  }

  clearTokenValues() {
    const blocks = this.getTokenBlocks();
    blocks.forEach((block) => {
      try {
        block.setFieldValue('', 'TOKEN');
      } catch (error) {
        console.warn('Failed to clear token value', error);
      }
    });
    this.applyTokenToVisibleCode();
    this.updateTokenUtilityBar();
  }

  updateTokenUtilityBar() {
    if (!this.tokenStatusTextEl) return;

    const blocks = this.getTokenBlocks();
    const token = this.getTokenValue();

    if (!blocks.length) {
      this.tokenStatusTextEl.textContent = 'Token: 未配置';
    } else if (!token) {
      this.tokenStatusTextEl.textContent = `Token: 未入力 (${blocks.length}個)`;
    } else {
      this.tokenStatusTextEl.textContent = `Token: 設定済み (${token.length}桁)`;
    }

    if (this.tokenFocusBtnEl) {
      this.tokenFocusBtnEl.disabled = blocks.length === 0;
      this.tokenFocusBtnEl.style.opacity = blocks.length === 0 ? '0.5' : '1';
      this.tokenFocusBtnEl.style.cursor = blocks.length === 0 ? 'not-allowed' : 'pointer';
    }

    if (this.tokenClearBtnEl) {
      this.tokenClearBtnEl.disabled = !token;
      this.tokenClearBtnEl.style.opacity = !token ? '0.5' : '1';
      this.tokenClearBtnEl.style.cursor = !token ? 'not-allowed' : 'pointer';
    }
  }

  getTokenValue() {
    const blocks = this.getTokenBlocks();
    for (const block of blocks) {
      const token = String(block.getFieldValue('TOKEN') || '').trim();
      if (token) {
        return token;
      }
    }

    return '';
  }

  replaceTokenInGeneratedCode(source) {
    if (typeof source !== 'string' || !source) {
      return source;
    }

    const token = this.getTokenValue();
    if (!token) {
      return source;
    }

    const escapedSingle = token.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedDouble = token.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return source
      .replace(/bot\.run\("TOKEN"\)/g, `bot.run("${escapedDouble}")`)
      .replace(/bot\.run\('TOKEN'\)/g, `bot.run('${escapedSingle}')`);
  }

  applyTokenToVisibleCode() {
    const codeOutput = document.getElementById('codeOutput');
    const codePreview = document.getElementById('codePreviewContent');

    if (codeOutput?.textContent) {
      const replaced = this.replaceTokenInGeneratedCode(codeOutput.textContent);
      if (replaced !== codeOutput.textContent) {
        codeOutput.textContent = replaced;
      }
    }

    if (codePreview?.textContent) {
      const replaced = this.replaceTokenInGeneratedCode(codePreview.textContent);
      if (replaced !== codePreview.textContent) {
        codePreview.textContent = replaced;
      }
    }

    const splitButtons = document.querySelectorAll('.splitCopyBtn[data-path]');
    splitButtons.forEach((btn) => {
      const card = btn.closest('.rounded-xl');
      const pre = card?.querySelector('pre');
      if (!pre?.textContent) {
        return;
      }
      const replaced = this.replaceTokenInGeneratedCode(pre.textContent);
      if (replaced !== pre.textContent) {
        pre.textContent = replaced;
      }
    });
  }

  handleSplitActionCapture(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const token = this.getTokenValue();
    if (!token) {
      return;
    }

    const copyBtn = target.closest('.splitCopyBtn[data-path]');
    if (copyBtn) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.handleSplitCopy(copyBtn);
      return;
    }

    const downloadBtn = target.closest('.splitDownloadBtn[data-path]');
    if (downloadBtn) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.handleSplitDownload(downloadBtn);
      return;
    }

    const downloadAllBtn = target.closest('#splitDownloadAllBtn');
    if (downloadAllBtn) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.handleSplitDownloadAll();
    }
  }

  findSplitFileContentByPath(path) {
    if (!path) {
      return '';
    }

    const buttons = document.querySelectorAll('.splitCopyBtn[data-path]');
    for (const btn of buttons) {
      if (btn.getAttribute('data-path') !== path) {
        continue;
      }
      const card = btn.closest('.rounded-xl');
      const pre = card?.querySelector('pre');
      if (!pre) {
        return '';
      }
      return this.replaceTokenInGeneratedCode(pre.textContent || '');
    }

    return '';
  }

  handleSplitCopy(copyBtn) {
    const path = copyBtn.getAttribute('data-path') || '';
    const text = this.findSplitFileContentByPath(path);
    if (!text || !navigator.clipboard?.writeText) {
      return;
    }

    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = copyBtn.innerHTML;
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.innerHTML = original;
          if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
            lucide.createIcons();
          }
        }, 1200);
      })
      .catch(() => {});
  }

  handleSplitDownload(downloadBtn) {
    const path = downloadBtn.getAttribute('data-path') || '';
    const text = this.findSplitFileContentByPath(path);
    if (!path || !text) {
      return;
    }

    const safeName = path.replace(/\//g, '__');
    this.downloadTextFile(safeName, text);
  }

  handleSplitDownloadAll() {
    const buttons = document.querySelectorAll('.splitCopyBtn[data-path]');
    buttons.forEach((btn) => {
      const path = btn.getAttribute('data-path') || '';
      const text = this.findSplitFileContentByPath(path);
      if (!path || !text) {
        return;
      }
      const safeName = path.replace(/\//g, '__');
      this.downloadTextFile(safeName, text);
    });
  }

  downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
}
