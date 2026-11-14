import type { UnknownApiParams } from 'types-mediawiki/api_params';
import { createApi } from '../mediawiki';
import state from '../state';
import { addMainPageReviewToolButtonsToDOM } from '../dom/article_page';
import { createProjection } from './projection';
import { mountWikipediaAnnotation } from './wikipedia-view';
import { buildReviewWikitext } from './export';
import { annotationMessages } from './i18n';
import { showAnnotationLoading } from './loading-view';
import { activationParameter, annotationViewUrl, commentParameter } from './view-url';
import { threadRoots } from './annotation-state';
import type { ReviewIdentity } from './live-storage';
import type { AnnotationComment, CommentDraft, HighlightAnnotation, Projection, WikipediaHeadingAnchor } from './types';

export { activationParameter } from './view-url';
interface Snapshot { annotations: readonly HighlightAnnotation[]; drafts: readonly CommentDraft[] }
interface StoredDraft extends Snapshot {
  schema: 1;
  identity: ReviewIdentity;
  author: string;
  undoClear: Snapshot | null;
  updatedAt: number;
}
interface ReviewedSource { projection: Projection; headings: WikipediaHeadingAnchor[] }
interface ParsedRevision { parse?: { title: string; pageid: number; revid: number; wikitext: string; tocdata?: { sections?: { fromTitle?: string; codepointOffset?: number; hLevel: number; anchor: string }[] } } }
type MutableComment = Omit<AnnotationComment, 'replies'> & { text: string; editedBy?: string; replies: MutableComment[] };
const labels = (text: { hant: string; hans: string }) => state.conv(text);
const draftPrefix = 'reviewtool-wikitext-v1';

export function reviewDraftKey(identity: ReviewIdentity, author: string): string {
  return [draftPrefix, identity.wiki, identity.pageId, identity.revisionId, author].map(value => encodeURIComponent(value)).join('/');
}

function storedDraft(raw: string | null, identity: ReviewIdentity, author: string): StoredDraft | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<StoredDraft>;
  if (value.schema !== 1 || value.author !== author || value.identity?.wiki !== identity.wiki || value.identity.pageId !== identity.pageId || value.identity.revisionId !== identity.revisionId || !Array.isArray(value.annotations) || !Array.isArray(value.drafts)) throw new Error('The browser draft does not match this article revision and user.');
  return value as StoredDraft;
}

function hasWork(content: Snapshot | null | undefined): boolean {
  return Boolean(content?.annotations.some(item => item && !item.deleted) || content?.drafts.some(draft => typeof draft?.text === 'string' && draft.text.trim()));
}
function cloneComment(comment: AnnotationComment): MutableComment {
  return { ...comment, replies: comment.replies.map(cloneComment) };
}
function cloneSnapshot(content: Snapshot): Snapshot {
  return { annotations: content.annotations.map(annotation => {
    const copy = { ...annotation, anchor: { ...annotation.anchor }, threads: threadRoots(annotation).map(cloneComment) };
    delete copy.comment; return copy;
  }), drafts: content.drafts.map(draft => ({ ...draft })) };
}
function mergeComments(previous: readonly AnnotationComment[], current: readonly AnnotationComment[]): MutableComment[] {
  const merged = new Map(previous.map(comment => [comment.id, cloneComment(comment)]));
  for (const comment of current) merged.set(comment.id, { ...comment, replies: mergeComments(merged.get(comment.id)?.replies ?? [], comment.replies) });
  return [...merged.values()];
}
/** Keep post-clear input and independent notes when restoring or merging tabs. */
export function mergeReviewSnapshots(previous: Snapshot, current: Snapshot): Snapshot {
  const annotations = new Map(previous.annotations.map(annotation => [annotation.id, annotation]));
  for (const annotation of current.annotations) annotations.set(annotation.id, { ...annotation, threads: mergeComments(threadRoots(annotations.get(annotation.id) ?? annotation), threadRoots(annotation)) });
  const key = (draft: CommentDraft) => JSON.stringify([draft.annotationId, draft.kind, 'commentId' in draft ? draft.commentId : '']);
  const drafts = new Map(previous.drafts.map(draft => [key(draft), draft]));
  for (const draft of current.drafts) {
    const before = drafts.get(key(draft))?.text ?? '', after = draft.text;
    drafts.set(key(draft), { ...draft, text: before && after && before !== after ? `${before}\n\n${after}` : after || before });
  }
  return { annotations: [...annotations.values()], drafts: [...drafts.values()] };
}

/** Three-way tab reconciliation keeps remote removals and independent local additions. */
export function reconcileReviewSnapshots(base: Snapshot, remote: Snapshot, local: Snapshot): Snapshot {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const before = new Map(base.annotations.map(item => [item.id, item]));
  const incoming = new Map(remote.annotations.map(item => [item.id, item]));
  const current = new Map(local.annotations.map(item => [item.id, item]));
  const annotations: HighlightAnnotation[] = [];
  for (const id of new Set([...incoming.keys(), ...current.keys()])) {
    const original = before.get(id), other = incoming.get(id), own = current.get(id);
    let annotation: HighlightAnnotation | undefined;
    if (same(own, original)) annotation = other;
    else if (same(other, original)) annotation = own;
    else if (!own || !other) annotation = original ? undefined : own ?? other;
    else if (other.deleted || own.deleted) annotation = other.deleted ? other : own;
    else annotation = { ...other, ...own, threads: mergeComments(threadRoots(other), threadRoots(own)) };
    if (annotation) annotations.push(annotation);
  }
  const draftKey = (draft: CommentDraft) => JSON.stringify([draft.annotationId, draft.kind, 'commentId' in draft ? draft.commentId : '']);
  const originalDrafts = new Map(base.drafts.map(draft => [draftKey(draft), draft]));
  const otherDrafts = new Map(remote.drafts.map(draft => [draftKey(draft), draft]));
  const ownDrafts = new Map(local.drafts.map(draft => [draftKey(draft), draft]));
  const liveIds = new Set(annotations.filter(item => !item.deleted).map(item => item.id));
  const drafts: CommentDraft[] = [];
  for (const key of new Set([...otherDrafts.keys(), ...ownDrafts.keys()])) {
    const original = originalDrafts.get(key), other = otherDrafts.get(key), own = ownDrafts.get(key);
    let draft: CommentDraft | undefined;
    if (same(own, original)) draft = other;
    else if (same(other, original)) draft = own;
    else if (!own || !other) draft = own ?? other;
    else {
      const beforeText = other.text, afterText = own.text;
      const text = beforeText === afterText || !beforeText || afterText.includes(beforeText) ? afterText
        : !afterText || beforeText.includes(afterText) ? beforeText : `${beforeText}\n\n${afterText}`;
      draft = { ...own, text };
    }
    if (draft && liveIds.has(draft.annotationId)) drafts.push(draft);
  }
  return { annotations, drafts };
}

/** Overlay unsent text on a copy, so exporting never needs a submit/save step. */
export function reviewExportAnnotations(annotations: readonly HighlightAnnotation[], drafts: readonly CommentDraft[], author: string): HighlightAnnotation[] {
  const result = cloneSnapshot({ annotations, drafts: [] }).annotations.map(annotation => ({ ...annotation, threads: threadRoots(annotation).map(cloneComment) }));
  const find = (comments: MutableComment[], id: string): MutableComment | undefined => {
    for (const comment of comments) { if (comment.id === id) return comment; const child = find(comment.replies, id); if (child) return child; }
    return undefined;
  };
  drafts.forEach((draft, index) => {
    const annotation = result.find(item => item.id === draft.annotationId && !item.deleted);
    if (!annotation) return;
    if (draft.kind === 'edit') {
      const comment = find(annotation.threads, draft.commentId);
      if (comment) { comment.text = draft.text; comment.editedBy = author; }
    } else if (draft.text.trim()) {
      const comment = { id: `local-input-${index}`, text: draft.text, author, createdAt: new Date().toISOString(), replies: [] };
      if (draft.kind === 'reply') find(annotation.threads, draft.commentId)?.replies.push(comment);
      else annotation.threads.push(comment);
    }
  });
  return result;
}

/** An article-only local session. The only API request reads the displayed revision. */
export async function initLiveAnnotation(): Promise<boolean> {
  const revision = mw.config.get('wgRevisionId'), pageId = mw.config.get('wgArticleId');
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view' || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(pageId) || pageId < 1 || mw.config.get('wgDiffOldId') || mw.config.get('wgDiffNewId') || new URL(location.href).searchParams.has('diff')) return false;
  if (document.getElementById('ca-annotate')) return true;
  const identity: ReviewIdentity = { wiki: mw.config.get('wgDBname'), pageId, revisionId: revision };
  const author = mw.config.get('wgUserName') || 'Anonymous';
  const pageName = mw.config.get('wgPageName').replace(/_/g, ' '), key = reviewDraftKey(identity, author);
  const api = createApi();
  let annotations: readonly HighlightAnnotation[] = [], drafts: readonly CommentDraft[] = [], undoClear: Snapshot | null = null;
  let storageSnapshot: string | null = null, storageFailed = false, pendingUpdate = false, applying = false, bulkBusy = false, opening = false;
  let mounted: ReturnType<typeof mountWikipediaAnnotation> | null = null, source: ReviewedSource | null = null;
  let toolbar: HTMLElement | null = null, status: HTMLElement | null = null, exportButton: HTMLButtonElement | null = null, clearButton: HTMLButtonElement | null = null, undoButton: HTMLButtonElement | null = null, syncButton: HTMLButtonElement | null = null;
  let exportDialog: HTMLDialogElement | null = null, stopLoading: (() => void) | null = null;
  let generation = 0, version = 0, exportedVersion = 0, bulkStatus = '';
  let pendingRemote: StoredDraft | null = null, pendingBase: StoredDraft | null = null, localUndoChanged = false;
  const messages = annotationMessages(text => state.conv(text));
  const notifyError = (message: { hant: string; hans: string }, error: unknown) => {
    console.error('[ReviewTool]', error);
    void mw.notify(labels(message), { autoHide: false, tag: 'reviewtool-local-error', type: 'error' });
  };
  function restore(saved: StoredDraft, raw: string | null) {
    annotations = saved.annotations; drafts = saved.drafts;
    undoClear = saved.undoClear && Array.isArray(saved.undoClear.annotations) && Array.isArray(saved.undoClear.drafts) ? saved.undoClear : null;
    storageSnapshot = raw; storageFailed = false; pendingUpdate = false; pendingRemote = null; pendingBase = null; localUndoChanged = false;
  }
  try { const raw = localStorage.getItem(key), saved = storedDraft(raw, identity, author); if (saved && raw) restore(saved, raw); }
  catch (error) { storageFailed = true; notifyError({ hant: '無法讀取本機草稿。新的批註仍可複製或下載為維基文字。', hans: '无法读取本地草稿。新的批注仍可复制或下载为维基文本。' }, error); }
  const initialHasWork = hasWork({ annotations, drafts }) || hasWork(undoClear);
  function capture(): Snapshot { return cloneSnapshot({ annotations: mounted?.view.highlighting?.annotations ?? annotations, drafts: mounted?.view.comments?.drafts ?? drafts }); }
  function updateToolbar() {
    if (!toolbar || !status || !exportButton || !clearButton || !undoButton || !syncButton) return;
    const count = combined({ annotations, drafts }).annotations.filter(item => !item.deleted).length;
    exportButton.disabled = bulkBusy || count === 0;
    clearButton.disabled = bulkBusy || !(annotations.length || drafts.length);
    undoButton.hidden = !undoClear; undoButton.disabled = bulkBusy;
    syncButton.hidden = !pendingUpdate; syncButton.disabled = bulkBusy || opening;
    status.textContent = labels(storageFailed ? { hant: `${count} 項批註；請在離開前複製或下載。`, hans: `${count} 项批注；请在离开前复制或下载。` }
      : pendingUpdate ? { hant: '其他分頁有更新；離開輸入框後載入，或按「載入分頁更新」。', hans: '其他分页有更新；离开输入框后载入，或按「载入分页更新」。' }
      : bulkStatus === 'cleared' ? { hant: '已清除所有評論及標記，可按「撤銷刪除」還原。', hans: '已清除所有评论和标记，可按「撤销删除」还原。' }
      : bulkStatus === 'deleted' ? { hant: '已刪除批註，可按「撤銷刪除」還原。', hans: '已删除批注，可按「撤销删除」还原。' }
      : bulkStatus === 'restored' ? { hant: '已復原評論、標記及輸入內容。', hans: '已恢复评论、标记和输入内容。' }
      : { hant: `${count} 項批註；草稿保留在此瀏覽器。`, hans: `${count} 项批注；草稿保留在此浏览器。` });
  }
  function emptyStoredDraft(): StoredDraft {
    return { schema: 1, identity, author, annotations: [], drafts: [], undoClear: null, updatedAt: 0 };
  }
  function readRemote() {
    const raw = localStorage.getItem(key);
    if (raw !== storageSnapshot) {
      pendingBase ??= storedDraft(storageSnapshot, identity, author) ?? emptyStoredDraft();
      pendingRemote = storedDraft(raw, identity, author) ?? emptyStoredDraft();
    }
    if (pendingRemote && !localUndoChanged) {
      undoClear = pendingRemote.undoClear && Array.isArray(pendingRemote.undoClear.annotations) && Array.isArray(pendingRemote.undoClear.drafts) ? pendingRemote.undoClear : null;
    }
  }
  function combined(content: Snapshot): Snapshot {
    return pendingRemote ? reconcileReviewSnapshots(pendingBase ?? emptyStoredDraft(), pendingRemote, content) : content;
  }
  function save(authoritative = false) {
    if (applying) return;
    try {
      if (authoritative) { pendingRemote = null; pendingBase = null; pendingUpdate = false; }
      else readRemote();
      const content = combined({ annotations, drafts });
      const saved: StoredDraft = { schema: 1, identity, author, ...content, undoClear, updatedAt: Date.now() };
      const raw = JSON.stringify(saved); localStorage.setItem(key, raw);
      storageSnapshot = raw; storageFailed = false; pendingUpdate = pendingRemote !== null;
      // Once committed, this slot is the baseline for the next deletion in any tab.
      if (localUndoChanged && pendingRemote) pendingRemote = { ...pendingRemote, undoClear };
      localUndoChanged = false;
    } catch (error) {
      if (!storageFailed) notifyError({ hant: '無法保留本機草稿。離開頁面前請先複製或下載批註。', hans: '无法保留本地草稿。离开页面前请先复制或下载批注。' }, error);
      storageFailed = true;
    }
    updateToolbar();
  }
  function changed() { bulkStatus = ''; version++; save(); }
  async function readSource(): Promise<ReviewedSource> {
    if (source) return source;
    const variant = mw.config.get('wgUserVariant');
    const value = await new Promise<ParsedRevision>((resolve, reject) => {
      api.get({ action: 'parse', oldid: revision, prop: 'wikitext|tocdata|revid', formatversion: 2, variant: typeof variant === 'string' ? variant : 'zh' } as UnknownApiParams).done(response => resolve(response as ParsedRevision)).fail((code: unknown) => reject(new Error(typeof code === 'string' ? code : 'Unable to read article source.')));
    });
    const parsed = value.parse;
    if (!parsed || parsed.revid !== revision || parsed.pageid !== pageId || typeof parsed.wikitext !== 'string') throw new Error('Source does not match the displayed article revision.');
    const offsets = [0], encoder = new TextEncoder();
    for (const character of parsed.wikitext) offsets.push(offsets[offsets.length - 1] + encoder.encode(character).length);
    const headings: WikipediaHeadingAnchor[] = [];
    for (const section of parsed.tocdata?.sections ?? []) {
      if (section.fromTitle?.replace(/_/g, ' ') !== parsed.title.replace(/_/g, ' ') || !Number.isInteger(section.codepointOffset) || section.codepointOffset === undefined || section.codepointOffset < 0) continue;
      const start = offsets[section.codepointOffset];
      if (start === undefined) throw new Error('A heading lies outside the source revision.');
      headings.push({ unit: 'utf8-byte', start, level: section.hLevel, id: section.anchor });
    }
    source = { projection: createProjection(parsed.wikitext, { wikiBaseUrl: new URL('/wiki/', location.href).href }), headings };
    return source;
  }
  function closeView() {
    generation++; opening = false; stopLoading?.(); stopLoading = null;
    if (mounted) {
      const content = capture(); annotations = content.annotations; drafts = content.drafts;
      mounted.destroy(); mounted = null;
    }
    toolbar?.remove(); toolbar = null; exportDialog?.remove(); exportDialog = null;
  }
  function button(text: string, action: () => void): HTMLButtonElement {
    const result = document.createElement('button'); result.type = 'button'; result.textContent = text; result.addEventListener('click', action); return result;
  }
  function download(text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `reviewtool-${revision}-wikitext.txt`;
    document.body.append(link); try { link.click(); exportedVersion = version; } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function showExport() {
    if (!source || !annotations.some(item => !item.deleted)) return;
    exportDialog?.remove();
    const dialog = document.createElement('dialog'); dialog.className = 'reviewtool-export-dialog'; dialog.setAttribute('aria-labelledby', 'reviewtool-export-title');
    const heading = document.createElement('h2'); heading.id = 'reviewtool-export-title'; heading.textContent = labels({ hant: '匯出批註為維基文字', hans: '导出批注为维基文本' });
    const description = document.createElement('p'); description.textContent = labels({ hant: '輸入的批註已包含在下方維基文字中，可直接複製或下載。', hans: '输入的批注已包含在下方维基文本中，可直接复制或下载。' });
    const textarea = document.createElement('textarea'); textarea.readOnly = true; textarea.spellcheck = false; textarea.setAttribute('aria-label', heading.textContent);
    const content = combined(capture()); textarea.value = buildReviewWikitext(identity, pageName, source.projection, reviewExportAnnotations(content.annotations, content.drafts, author), source.headings);
    const feedback = document.createElement('p'); feedback.className = 'reviewtool-export-status'; feedback.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'reviewtool-export-actions';
    const copy = button(labels({ hant: '複製', hans: '复制' }), () => { void (async () => {
      let copied = false; copy.disabled = true;
      try { await navigator.clipboard.writeText(textarea.value); copied = true; } catch { textarea.focus(); textarea.select(); try { copied = document.execCommand('copy'); } catch { /* Selectable fallback remains available. */ } }
      copy.disabled = false;
      feedback.textContent = labels(copied ? { hant: '已複製維基文字。', hans: '已复制维基文本。' } : { hant: '文字已選取，請按 Ctrl+C 或 Command+C 複製。', hans: '文本已选中，请按 Ctrl+C 或 Command+C 复制。' });
      if (copied) exportedVersion = version;
    })(); });
    const remove = () => { dialog.remove(); if (exportDialog === dialog) exportDialog = null; exportButton?.focus(); };
    actions.append(copy, button(labels({ hant: '下載 .txt', hans: '下载 .txt' }), () => download(textarea.value)), button(messages.close, remove));
    dialog.addEventListener('cancel', event => { event.preventDefault(); remove(); });
    dialog.append(heading, description, textarea, feedback, actions); document.body.append(dialog); exportDialog = dialog;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    textarea.focus(); textarea.select();
  }
  async function replace(content: Snapshot, undo: Snapshot | null) {
    const wasOpen = Boolean(mounted), position = { left: window.scrollX, top: window.scrollY };
    closeView(); annotations = content.annotations; drafts = content.drafts; undoClear = undo; localUndoChanged = true; version++; save(true);
    if (wasOpen) { await openView(); window.scrollTo(position); }
  }
  async function bulk(restoreClear: boolean) {
    if (bulkBusy || (restoreClear && !undoClear)) return;
    bulkBusy = true; updateToolbar();
    try {
      try { readRemote(); } catch { /* Storage failures are reported by save; the local action remains usable. */ }
      const content = combined(capture());
      if (restoreClear && undoClear) { const removedIds = new Set(undoClear.annotations.map(item => item.id));
        await replace(mergeReviewSnapshots(undoClear, { ...content, annotations: content.annotations.filter(item => !item.deleted || !removedIds.has(item.id)) }), null); bulkStatus = 'restored'; }
      else { await replace({ annotations: [], drafts: [] }, content); bulkStatus = 'cleared'; }
    } catch (error) { notifyError({ hant: '無法更新批註畫面。請重新開啟批註模式。', hans: '无法更新批注界面。请重新打开批注模式。' }, error); }
    finally { bulkBusy = false; updateToolbar(); (restoreClear ? clearButton : undoButton)?.focus({ preventScroll: true }); }
  }
  function mountToolbar() {
    if (!mounted) return;
    toolbar = document.createElement('div'); toolbar.className = 'reviewtool-local-toolbar';
    status = document.createElement('span'); status.setAttribute('role', 'status');
    exportButton = button(labels({ hant: '匯出批註為維基文字', hans: '导出批注为维基文本' }), showExport); exportButton.id = 'reviewtool-export-wikitext';
    clearButton = button(labels({ hant: '清除所有評論及標記', hans: '清除所有评论和标记' }), () => { void bulk(false); }); clearButton.id = 'reviewtool-clear-comments';
    undoButton = button(labels({ hant: '撤銷刪除', hans: '撤销删除' }), () => { void bulk(true); }); undoButton.id = 'reviewtool-undo-clear';
    syncButton = button(labels({ hant: '載入分頁更新', hans: '载入分页更新' }), () => { void refresh(true); }); syncButton.id = 'reviewtool-sync-draft';
    const actions = document.createElement('div'); actions.className = 'reviewtool-local-toolbar-actions'; actions.append(clearButton, undoButton, syncButton, exportButton);
    toolbar.append(status, actions); mounted.original.before(toolbar); updateToolbar();
  }
  async function openView() {
    const token = ++generation; opening = true;
    stopLoading = showAnnotationLoading(document, messages.loadingView);
    try {
      const reviewed = await readSource();
      if (token !== generation) return;
      stopLoading?.(); stopLoading = null;
      mounted = mountWikipediaAnnotation(document, reviewed.projection, {
        comments: true, messages, commentAuthor: author, commentUserGroups: [], commentCanWrite: true,
        commentAutosave: true, commentFloating: true,
        commentLinks: false, commentDrafts: drafts, headingAnchors: reviewed.headings,
        onCommentDraftsChange(next) { drafts = next; changed(); },
        highlighting: { initial: annotations, localEditing: true, onChange(next, action) {
          if (action.type === 'delete-highlight') {
            // One persisted slot: each new deletion replaces the preceding Undo.
            undoClear = cloneSnapshot({ annotations: annotations.filter(item => item.id === action.id), drafts: drafts.filter(draft => draft.annotationId === action.id) });
            localUndoChanged = true;
          }
          annotations = next; changed();
          if (action.type === 'delete-highlight') { bulkStatus = 'deleted'; updateToolbar(); }
        } },
      });
      mountToolbar();
    } finally { if (token === generation) { opening = false; stopLoading?.(); stopLoading = null; } }
  }
  function updateUrl() {
    const url = new URL(location.href); url.searchParams.delete(commentParameter);
    if (mounted || opening) url.searchParams.set(activationParameter, '1'); else url.searchParams.delete(activationParameter);
    history.replaceState(history.state, '', url.href);
  }
  async function toggle() {
    if (bulkBusy || applying) return;
    if (mounted || opening) { closeView(); updateUrl(); navigation.update(false); return; }
    const skin = mw.config.get('skin');
    if (skin !== 'vector-2022' && skin !== 'minerva') { location.assign(annotationViewUrl(location.href, revision, skin).href); return; }
    navigation.update(true, true);
    try { await refresh(); await openView(); updateUrl(); }
    catch (error) { closeView(); notifyError({ hant: '無法開啟批註模式。請重新整理頁面後再試。', hans: '无法开启批注模式。请刷新页面后重试。' }, error); }
    finally { navigation.update(Boolean(mounted)); }
  }
  const navigation = addMainPageReviewToolButtonsToDOM(() => { void toggle(); }); navigation.update(false);
  let refreshing: Promise<void> | null = null;
  async function refresh(force = false): Promise<void> {
    if (refreshing !== null) return refreshing;
    if (opening || bulkBusy || applying) return;
    const editing = mounted?.view.comments?.element.contains(document.activeElement) || exportDialog?.contains(document.activeElement);
    refreshing = (async () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw === storageSnapshot && !pendingUpdate) return;
        if (editing && !force) { pendingUpdate = true; return; }
        const saved = storedDraft(raw, identity, author) ?? emptyStoredDraft();
        const wasOpen = Boolean(mounted), position = { left: window.scrollX, top: window.scrollY };
        applying = true; closeView(); restore(saved, raw);
        if (wasOpen) { await openView(); window.scrollTo(position); }
      } catch (error) { pendingUpdate = true; console.warn('[ReviewTool] Could not refresh browser draft.', error); }
      finally { applying = false; updateToolbar(); }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  // Keep old-revision anchors on their source revision, with a direct recovery link.
  try {
    let latest: StoredDraft | null = null;
    const prefix = [draftPrefix, identity.wiki, pageId].map(value => encodeURIComponent(value)).join('/') + '/';
    for (let index = 0; index < localStorage.length; index++) {
      const candidateKey = localStorage.key(index); if (!candidateKey?.startsWith(prefix) || !candidateKey.endsWith('/' + encodeURIComponent(author))) continue;
      try {
        const raw = localStorage.getItem(candidateKey); if (!raw) continue;
        const candidate = JSON.parse(raw) as StoredDraft;
        if (!candidate.identity || candidate.identity.revisionId === revision || !Number.isSafeInteger(candidate.identity.revisionId) || candidate.identity.revisionId < 1 || candidateKey !== reviewDraftKey(candidate.identity, author)) continue;
        const saved = storedDraft(raw, { ...identity, revisionId: candidate.identity.revisionId }, author);
        if (saved && (hasWork(saved) || hasWork(saved.undoClear)) && (!latest || saved.updatedAt > latest.updatedAt)) latest = saved;
      } catch { /* Ignore records belonging to another version or format. */ }
    }
    if (latest && !initialHasWork) {
      const notice = document.createElement('div'); notice.id = 'reviewtool-saved-draft'; notice.className = 'reviewtool-local-toolbar';
      const description = document.createElement('span'); description.textContent = labels({ hant: '此條目有先前版本的批註草稿。', hans: '此条目有先前版本的批注草稿。' });
      const link = document.createElement('a'); link.textContent = labels({ hant: '開啟已儲存的批註', hans: '打开已保存的批注' }); link.href = annotationViewUrl(location.href, latest.identity.revisionId, mw.config.get('skin')).href;
      notice.append(description, link); document.getElementById('mw-content-text')?.before(notice);
    }
  } catch { /* History lookup is optional when browser storage is unavailable. */ }
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void refresh(); });
  document.addEventListener('focusout', () => { window.setTimeout(() => { void refresh(); }, 0); });
  window.addEventListener('beforeunload', event => { if (storageFailed && version > exportedVersion) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { if (storageFailed) { const content = capture(); annotations = content.annotations; drafts = content.drafts; save(); } });
  if (new URL(location.href).searchParams.get(activationParameter) === '1' || initialHasWork) await toggle();
  return true;
}
