import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

let browser, script;
const time = '2026-09-29T00:00:00.000Z';
const identity = { wiki: 'zhwiki', pageId: 1, revisionId: 2 };
const key = 'reviewtool-wikitext-v1/zhwiki/1/2/Example';
const mark = (id = 'h', start = 0, end = 15) => ({ id, color: 'green', author: 'Example', createdAt: time, anchor: { unit: 'utf8-byte', start, end } });
const record = (annotations = [mark()], drafts = [{ annotationId: 'h', kind: 'new', text: '已有评注' }], other = {}) => ({ schema: 1, identity, author: 'Example', annotations, drafts, undoClear: null, updatedAt: 1, ...other });
before(async () => {
  const bundle = await build({ stdin: { contents: "import { initLiveAnnotation } from './src/annotation/live.ts'; import styles from './src/styles.css'; import annotationStyles from './src/annotation/style.css'; const style = document.createElement('style'); style.textContent = styles + annotationStyles; document.head.append(style); window.startView = initLiveAnnotation;", resolveDir: process.cwd() }, bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(existsSync('/Applications/Google Chrome.app') ? { channel: 'chrome' } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(run, { saved = record(), skin = 'vector-2022', width = 1400, pending = false, storageFailure = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<style>.fixture{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:30px;margin:60px}@media(max-width:900px){.fixture{display:block;margin:16px}}</style><div id="p-views"><ul class="vector-menu-content-list"></ul></div><ul id="p-cactions"></ul><h1 id="firstHeading">Test</h1><div class="fixture"><div id="mw-content-text"><div class="mw-parser-output">Original article</div></div><div class="vector-column-end no-font-mode-scale"><div class="vector-sticky-pinned-container"><div id="original-sidebar-control">Tools</div></div></div></div>' }));
    await page.goto('http://localhost/?reviewtool_annotation_view=1');
    await page.evaluate(({ saved, skin, pending, storageFailure, key }) => {
      document.body.classList.add('skin-' + skin);
      if (saved) localStorage.setItem(key, JSON.stringify(saved));
      if (storageFailure) Object.defineProperty(Storage.prototype, 'setItem', { value() { throw new DOMException('Storage full', 'QuotaExceededError'); } });
      const gate = pending ? new Promise(resolve => { window.releaseSource = resolve; }) : Promise.resolve();
      const wrap = promise => ({ done(fn) { promise.then(fn, () => {}); return this; }, fail(fn) { promise.catch(fn); return this; } });
      const config = { wgNamespaceNumber: 0, wgAction: 'view', wgRevisionId: 2, wgArticleId: 1, wgPageName: 'Test', wgDBname: 'zhwiki', wgUserName: 'Example', wgUserGroups: ['user'], skin };
      window.requests = []; window.notifications = [];
      window.mw = {
        loader: { using: async () => () => ({}) }, config: { get: name => config[name] },
        Api: class {
          get(params) { requests.push(params); return wrap(gate.then(() => ({ parse: { pageid: 1, revid: 2, title: 'Test', wikitext: '段落內容。\n\n第二段。' } }))); }
          postWithToken() { throw new Error('Unexpected wiki publication'); }
          abort() {}
        },
        notify: (message, options) => { notifications.push({ message, options }); return Promise.resolve({ close() {} }); },
        util: { addPortletLink: (target, href, text, id) => {
          const li = document.createElement('li'); li.id = id; const a = document.createElement('a'); a.href = href; a.textContent = text; li.append(a); document.getElementById(target)?.append(li); return li;
        } },
      };
    }, { saved, skin, pending, storageFailure, key });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => { window.boot = startView(); });
    if (!pending) await page.evaluate(() => boot);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
const savedState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
async function edit(page) {
  await page.locator('.annotation-document [data-source-run]').first().hover();
  const input = page.locator('.annotation-comments textarea').first();
  await input.waitFor({ state: 'visible' }); return input;
}

test('local entry only reads the displayed revision and keeps right sidebar controls in place', async () => {
  await fixture(async page => {
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal(await page.locator('.vector-column-end .annotation-comments').count(), 0);
    assert.equal(await page.locator('.vector-column-end #original-sidebar-control').count(), 1);
    const requests = await page.evaluate(() => requests);
    assert.equal(requests.length, 1); assert.equal(requests[0].action, 'parse'); assert.equal(requests[0].oldid, 2);
    await page.locator('#ca-annotate a').click();
    assert.equal(await page.locator('.annotation-document').count(), 0);
    assert.equal(await page.locator('.mw-parser-output').isVisible(), true);
    await page.locator('#ca-annotate a').click();
    assert.equal(await page.locator('.annotation-document').count(), 1);
    assert.equal((await page.evaluate(() => requests)).length, 1, 'source is cached within one page session');
  });
});

test('pending loading can be canceled immediately without mounting a late source response', async () => {
  await fixture(async page => {
    await page.getByRole('progressbar').waitFor();
    assert.equal(await page.locator('.mw-parser-output').isVisible(), false);
    await page.locator('#ca-annotate a').click();
    assert.equal(await page.locator('.mw-parser-output').isVisible(), true);
    await page.evaluate(async () => { releaseSource(); await boot; });
    assert.equal(await page.locator('.annotation-document').count(), 0);
  }, { pending: true });
});

test('typing autosaves and exports immediately with no send/save button or JSON output', async () => {
  await fixture(async page => {
    const input = await edit(page); await input.fill('无需发送的本地评注');
    assert.equal(await page.getByRole('button', { name: /^(送出|儲存修改)$/ }).count(), 0);
    assert.equal((await savedState(page)).drafts[0].text, '无需发送的本地评注');
    await page.locator('#reviewtool-export-wikitext').click();
    const value = await page.locator('.reviewtool-export-dialog textarea').inputValue();
    assert.match(value, /无需发送的本地评注/);
    assert.match(value, /Special:PermaLink\/2/);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載 .txt', exact: true }).click();
    assert.equal((await downloadPromise).suggestedFilename(), 'reviewtool-2-wikitext.txt');
    assert.equal((await page.evaluate(() => requests)).length, 1);
  });
});

test('clear content removes the whole annotation and one Undo restores its typed text', async () => {
  await fixture(async page => {
    await (await edit(page)).fill('删除前的输入');
    await page.getByRole('button', { name: '清空內容', exact: true }).click();
    assert.equal(await page.locator('.annotation-comment-thread').count(), 0);
    assert.equal((await savedState(page)).annotations[0].deleted.by, 'Example');
    assert.equal((await savedState(page)).drafts.length, 0);
    assert.equal(await page.locator('#reviewtool-undo-clear').count(), 1);
    await page.locator('#reviewtool-undo-clear').click();
    assert.equal(await (await edit(page)).inputValue(), '删除前的输入');
    assert.equal((await savedState(page)).undoClear, null);
  });
});

test('only the most recent annotation deletion is persisted and undoable', async () => {
  const saved = record([mark(), mark('other', 17, 29)], [{ annotationId: 'h', kind: 'new', text: 'first' }, { annotationId: 'other', kind: 'new', text: 'second' }]);
  await fixture(async page => {
    await edit(page); await page.getByRole('button', { name: '清空內容', exact: true }).first().click();
    await page.locator('.annotation-document p').nth(1).locator('[data-source-run]').first().hover();
    await page.locator('.annotation-comment-thread[data-annotation-id="other"] textarea').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '清空內容', exact: true }).click();
    const stored = await savedState(page);
    assert.deepEqual(stored.undoClear.annotations.map(item => item.id), ['other']);
    assert.equal(await page.locator('#reviewtool-undo-clear').count(), 1);
    await page.locator('#reviewtool-undo-clear').click();
    const restored = await savedState(page);
    assert.equal(restored.annotations.find(item => item.id === 'h').deleted.by, 'Example');
    assert.equal(restored.annotations.find(item => item.id === 'other').deleted, undefined);
    assert.deepEqual(restored.drafts.map(draft => draft.text), ['second']);
  }, { saved });
});

test('clear all and Undo retain newer annotations and drafts', async () => {
  await fixture(async page => {
    await page.locator('#reviewtool-clear-comments').click();
    assert.deepEqual((await savedState(page)).annotations, []);
    // A later tab edit adds fresh content after clear-all.
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([mark('other', 17, 29)], [{ annotationId: 'other', kind: 'new', text: 'new note' }], { undoClear: record() }) });
    await page.waitForFunction(() => document.querySelectorAll('.annotation-comment-thread').length === 1);
    await page.locator('#reviewtool-undo-clear').click();
    const restored = await savedState(page);
    assert.deepEqual(restored.annotations.map(item => item.id).sort(), ['h', 'other']);
    assert.deepEqual(restored.drafts.map(item => item.text).sort(), ['new note', '已有评注']);
  });
});

test('cross-tab changes wait for editor blur and load without overwriting storage', async () => {
  await fixture(async page => {
    const input = await edit(page); await input.focus();
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([mark()], [{ annotationId: 'h', kind: 'new', text: 'other tab text' }]) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    assert.equal(await input.inputValue(), '已有评注');
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelector('.annotation-comments textarea')?.value === 'other tab text');
    assert.equal((await savedState(page)).drafts[0].text, 'other tab text');
  });
});

for (const skin of ['vector-2022', 'minerva']) test(`${skin} uses floating editors without a right sidebar annotation panel`, async () => {
  await fixture(async page => {
    await edit(page);
    assert.equal(await page.locator('.annotation-comments').getAttribute('data-layout'), 'floating');
    assert.equal(await page.locator('.vector-column-end .annotation-comments').count(), 0);
  }, { skin, width: 390 });
});

test('storage failures keep typed text exportable and report a local draft error', async () => {
  await fixture(async page => {
    await (await edit(page)).fill('storage failure note');
    await page.locator('#reviewtool-export-wikitext').click();
    assert.match(await page.locator('.reviewtool-export-dialog textarea').inputValue(), /storage failure note/);
    assert.ok((await page.evaluate(() => notifications)).some(item => /無法保留本機草稿/.test(item.message)));
  }, { storageFailure: true });
});

test('older revision notes offer a recovery link and never apply anchors to the current revision', async () => {
  await fixture(async page => {
    // Reinitialize on the original page with a draft belonging to revision 1.
    await page.locator('#ca-annotate a').click();
    await page.evaluate(({ key, record }) => {
      localStorage.removeItem(key);
      localStorage.setItem(key.replace('/2/', '/1/'), JSON.stringify({ ...record, identity: { ...record.identity, revisionId: 1 } }));
      document.getElementById('ca-annotate').remove();
      document.getElementById('ca-reviewtool-toggle')?.remove();
      history.replaceState(null, '', '/');
    }, { key, record: record() });
    await page.evaluate(() => startView());
    const link = page.locator('#reviewtool-saved-draft a');
    assert.equal(new URL(await link.getAttribute('href')).searchParams.get('oldid'), '1');
    assert.equal(await page.locator('.annotation-document').count(), 0);
  }, { saved: null });
});

test('editing after a remote update preserves both note texts when the editor blurs', async () => {
  await fixture(async page => {
    const input = await edit(page); await input.focus();
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([mark()], [{ annotationId: 'h', kind: 'new', text: 'remote note' }]) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await input.fill('local note');
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelector('.annotation-comments textarea')?.value.includes('remote note'));
    const result = await savedState(page);
    assert.match(result.drafts[0].text, /remote note/);
    assert.match(result.drafts[0].text, /local note/);
  });
});

test('remote deletion stays deleted when an unrelated focused note is edited', async () => {
  const first = record([mark(), mark('other', 17, 29)], [{ annotationId: 'h', kind: 'new', text: 'first' }, { annotationId: 'other', kind: 'new', text: 'second' }]);
  await fixture(async page => {
    const input = await edit(page); await input.focus();
    const removed = { ...mark('other', 17, 29), deleted: { by: 'Example', at: time } };
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([mark(), removed], [{ annotationId: 'h', kind: 'new', text: 'first' }], { undoClear: { annotations: [mark('other', 17, 29)], drafts: [{ annotationId: 'other', kind: 'new', text: 'second' }] } }) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await input.fill('first changed locally');
    assert.equal(await input.evaluate(element => document.activeElement === element), true, 'saving does not replace the focused input');
    const saved = await savedState(page);
    assert.ok(saved.annotations.find(item => item.id === 'other').deleted);
    assert.deepEqual(saved.drafts.map(draft => draft.text), ['first changed locally']);
    assert.deepEqual(saved.undoClear.annotations.map(item => item.id), ['other']);
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelectorAll('.annotation-comment-thread').length === 1);
  }, { saved: first });
});

test('remote clear and its most recent Undo replace stale local notes and Undo', async () => {
  const oldUndo = { annotations: [mark('old', 17, 29)], drafts: [] };
  await fixture(async page => {
    const input = await edit(page); await input.focus();
    const latestUndo = { annotations: [mark()], drafts: [{ annotationId: 'h', kind: 'new', text: 'before remote clear' }] };
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([], [], { undoClear: latestUndo }) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await input.fill('stale focused text');
    const saved = await savedState(page);
    assert.deepEqual(saved.annotations, []);
    assert.deepEqual(saved.drafts, []);
    assert.deepEqual(saved.undoClear, latestUndo);
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelectorAll('.annotation-comment-thread').length === 0);
    await page.locator('#reviewtool-undo-clear').click();
    assert.deepEqual((await savedState(page)).annotations.map(item => item.id), ['h']);
    assert.equal((await savedState(page)).undoClear, null);
  }, { saved: record([mark()], undefined, { undoClear: oldUndo }) });
});

test('clear-all consumes pending remote additions without resurrecting them on save', async () => {
  await fixture(async page => {
    const input = await edit(page); await input.focus();
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record([mark(), mark('other', 17, 29)], [{ annotationId: 'h', kind: 'new', text: '已有评注' }, { annotationId: 'other', kind: 'new', text: 'remote addition' }]) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await page.locator('#reviewtool-clear-comments').click();
    const saved = await savedState(page);
    assert.deepEqual(saved.annotations, []);
    assert.deepEqual(saved.drafts, []);
    assert.deepEqual(saved.undoClear.annotations.map(item => item.id).sort(), ['h', 'other']);
    await page.locator('#reviewtool-undo-clear').click();
    assert.deepEqual((await savedState(page)).annotations.map(item => item.id).sort(), ['h', 'other']);
  });
});

test('removing browser storage in another tab clears notes after editor blur', async () => {
  await fixture(async page => {
    await (await edit(page)).focus();
    await page.evaluate(key => { localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage', { key })); }, key);
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelectorAll('.annotation-comment-thread').length === 0);
    assert.equal(await savedState(page), null, 'refresh does not write the removed record back');
  });
});

test('a later remote deletion replaces an earlier local deletion in the single Undo slot', async () => {
  const initial = record([mark(), mark('other', 17, 29)], [{ annotationId: 'h', kind: 'new', text: 'first' }, { annotationId: 'other', kind: 'new', text: 'second' }]);
  await fixture(async page => {
    await edit(page); await page.getByRole('button', { name: '清空內容', exact: true }).first().click();
    assert.deepEqual((await savedState(page)).undoClear.annotations.map(item => item.id), ['h']);
    await page.locator('.annotation-document p').nth(1).locator('[data-source-run]').first().hover();
    const input = page.locator('.annotation-comment-thread[data-annotation-id="other"] textarea'); await input.waitFor({ state: 'visible' }); await input.focus();
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
    const newerUndo = { annotations: [mark('other', 17, 29)], drafts: [{ annotationId: 'other', kind: 'new', text: 'second' }] };
    const removed = [mark(), mark('other', 17, 29)].map(item => ({ ...item, deleted: { by: 'Example', at: time } }));
    await page.evaluate(({ key, record }) => { localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key, record: record(removed, [], { undoClear: newerUndo }) });
    await page.locator('#reviewtool-sync-draft').waitFor({ state: 'visible' });
    await input.fill('stale after newer deletion');
    assert.deepEqual((await savedState(page)).undoClear, newerUndo);
    await page.locator('#firstHeading').click();
    await page.waitForFunction(() => document.querySelectorAll('.annotation-comment-thread').length === 0);
    await page.locator('#reviewtool-undo-clear').click();
    const saved = await savedState(page);
    assert.ok(saved.annotations.find(item => item.id === 'h').deleted);
    assert.equal(saved.annotations.find(item => item.id === 'other').deleted, undefined);
  }, { saved: initial });
});
