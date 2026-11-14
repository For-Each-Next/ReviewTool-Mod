import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './launch.mjs';
let api;
before(async () => {
  const file = path.join(root, `.cache/export-test-${process.pid}.mjs`);
  await build({ stdin: { contents: "export * from './src/annotation/export'; export * from './src/annotation/projection';", resolveDir: root }, outfile: file, bundle: true, platform: 'node', format: 'esm' });
  api = await import(pathToFileURL(file));
});
const identity = { wiki: 'zhwiki', pageId: 139, revisionId: 94447348 };
const time = '2026-09-26T00:00:00.000Z';
const comment = (id, replies = []) => ({ id, text: 'Comment ' + id, author: 'Example', createdAt: time, replies });
const anchor = (source, quote) => ({ unit: 'utf8-byte', start: Buffer.byteLength(source.slice(0, source.indexOf(quote))), end: Buffer.byteLength(source.slice(0, source.indexOf(quote) + quote.length)) });

test('exports every root and reply, including resolved/deleted discussions, with independent attribution and source anchors', () => {
  const source = '前言。\n== 第一節 ==\n[[頁面|文字]]。\n=== 子節 ===\n細節😀。\n== 另一節 ==\n末尾。';
  const removal = { by: 'Example', at: time, reason: 'Done' };
  const input = [
    { id: 'bare', color: 'blue', anchor: anchor(source, '前言'), threads: [] },
    { id: 'h', author: 'Someone', createdAt: time, color: 'yellow', anchor: anchor(source, '[[頁面|文字]]'), threads: [
      comment('one', [comment('reply', [comment('grandchild')])]),
      { ...comment('two'), resolved: removal, editedAt: time, editedBy: 'Moderator' },
    ] },
    { id: 'deleted', author: 'Example', color: 'red', anchor: anchor(source, '細節😀'), deleted: removal, threads: [comment('hidden')] },
    { id: 'last', color: 'green', anchor: anchor(source, '末尾'), threads: [comment('last')] },
  ];
  const original = structuredClone(input);
  const result = api.buildAnnotationExport(identity, '孫中山', api.createProjection(source), input);
  const entries = result.groups.flatMap(group => group.annotations);
  assert.equal(entries.length, 6); assert.equal(result.highlights.length, 4);
  assert.deepEqual(result.groups.map(group => group.sectionPath), ['第一節', '第一節 / 子節', '另一節']);
  assert.deepEqual(entries.map(c => [c.id, c.rootId, c.parentId]), [
    ['one', 'one', null], ['reply', 'one', 'one'], ['grandchild', 'one', 'reply'], ['two', 'two', null], ['hidden', 'hidden', null], ['last', 'last', null],
  ]);
  assert.equal(entries[0].sentenceText, '文字');
  assert.equal(entries[0].createdBy, 'Example'); assert.equal(entries[0].createdAt, Date.parse(time));
  assert.equal(entries[3].editedBy, 'Moderator'); assert.deepEqual(entries[3].closure, removal);
  assert.equal(entries[3].closed, true); assert.equal(entries[0].resolved, false);
  assert.equal(result.highlights[1].author, 'Someone');
  assert.equal(result.highlights[1].sourceText, '[[頁面|文字]]');
  assert.equal(result.highlights[2].sourceText, '細節😀'); assert.deepEqual(result.highlights[2].deleted, removal);
  assert.equal(result.highlights[0].createdAt, undefined);
  assert.deepEqual(result.document, { ...identity, offsetUnit: 'utf8-byte' });
  assert.deepEqual(input, original, 'export does not mutate shared state');
  assert.equal('threads' in result.highlights[1], false, 'comments are represented once, with parent/root IDs');
});

test('bare highlights and empty documents can be exported without inventing comments', () => {
  const projection = api.createProjection('plain');
  assert.deepEqual(api.buildAnnotationExport(identity, 'Page', projection, []).groups, []);
  const result = api.buildAnnotationExport(identity, 'Page', projection, [{ id: 'bare', color: 'blue', anchor: anchor('plain', 'plain') }]);
  assert.equal(result.highlights.length, 1); assert.deepEqual(result.groups, []);
});

test('wikitext sorts quotations into permanent section links and preserves nested discussion lists', () => {
  const source = '引言😀。\n== 第一節 ==\n[[頁面|文字]]。\n=== 子節 ===\n細節。';
  const heading = (title, level) => ({ unit: 'utf8-byte', start: Buffer.byteLength(source.slice(0, source.indexOf('='.repeat(level) + ' ' + title))), level, id: title });
  const annotations = [
    { id: 'child', color: 'blue', anchor: anchor(source, '細節'), threads: [{ ...comment('child'), text: '第一點\n* 第二點\n** 深一層', replies: [{ ...comment('reply'), text: '回覆' }] }] },
    { id: 'first', color: 'yellow', anchor: anchor(source, '[[頁面|文字]]'), threads: [{ ...comment('first'), text: '保留[[連結]]與{{模板|參數}}。' }] },
    { id: 'intro', color: 'green', anchor: anchor(source, '引言😀'), threads: [] },
  ];
  const original = structuredClone(annotations);
  const result = api.buildReviewWikitext(identity, '測試頁面', api.createProjection(source), annotations, [heading('第一節', 2), heading('子節', 3)]);
  assert.equal(result, [
    '=== For Each ... Next的意见 @ 測試頁面 ===', '',
    '以下内容使用[[WP:REVTOOL]]生成<!-- 预期条目变化比较大，没有启用[[Special:PrefixIndex/Wikipedia:ReviewTool/data/|联机行内凸显]]功能😂 -->。--~~~~', '',
    "'''[[Special:PermaLink/94447348|序言]]'''",
    '# {{rvw|引言😀}} —— ', '--~~~~', '',
    "'''[[Special:PermaLink/94447348#第一節|第一節]]'''",
    '# {{rvw|文字}} —— 保留[[連結]]與{{模板|參數}}。', '--~~~~', '',
    "'''[[Special:PermaLink/94447348#子節|第一節 / 子節]]'''",
    '# {{rvw|細節}} —— ', '#* 第一點', '#* 第二點', '#** 深一層', '#** 回覆', '--~~~~',
  ].join('\n'));
  assert.deepEqual(annotations, original, 'formatting must not reorder or change stored annotations');
});

test('wikitext escapes article text and page labels without escaping authored comment markup', () => {
  const source = '<nowiki>A|{{danger}} & <b> _ ~ : # * ; = " \' [link]</nowiki>';
  const projection = api.createProjection(source);
  const result = api.buildReviewWikitext(identity, 'Page|{{bad}}', projection, [
    { id: 'literal', color: 'red', anchor: anchor(source, source.slice('<nowiki>'.length, -'</nowiki>'.length)), threads: [{ ...comment('c'), text: '意見：{{done}} [[連結]]' }] },
  ]);
  assert.match(result, /^=== For Each \.\.\. Next的意见 @ Page&#124;&#123;&#123;bad&#125;&#125; ===/);
  assert.ok(result.includes('# {{rvw|A&#124;&#123;&#123;danger&#125;&#125; &#38; &#60;b&#62; &#95; &#126; &#58; &#35; &#42; &#59; &#61; &#34; &#39; &#91;link&#93;}} —— 意見：{{done}} [[連結]]'));
  assert.ok(!result.includes('{{rvw|A|{{danger}}'));
});

test('wikitext keeps multiline template, table, comments and literal-tag constructs intact', () => {
  const source = '正文';
  const note = ['{{模板', '|參數=值', '}}', '<!-- 隱藏', '第二行 -->', '<nowiki>原樣', '* 不加入列表</nowiki>', '{| class="wikitable"', '|-', '| 儲存格', '|}', '最後一行'].join('\n');
  const result = api.buildReviewWikitext(identity, 'Page', api.createProjection(source), [
    { id: 'h', color: 'yellow', anchor: anchor(source, source), threads: [{ ...comment('c'), text: note }] },
  ]);
  assert.ok(result.includes('#* {{模板\n|參數=值\n}}\n#* <!-- 隱藏\n第二行 -->\n#* <nowiki>原樣\n* 不加入列表</nowiki>\n#* {| class="wikitable"\n|-\n| 儲存格\n|}\n#* 最後一行'));
  for (const text of ['{{模板\n|參數=值', '<!-- 文字\n更多', '<syntaxhighlight lang="js">\nconst x = 1;', '{|\n|-']) assert.equal(api.reviewCommentInMarkup(text), true);
  for (const text of ['{{模板\n|參數=值\n}}', '<!-- 文字 -->', '<ref name="x" />\n', '<nowiki>原樣</nowiki>', '{|\n|}\n普通文字']) assert.equal(api.reviewCommentInMarkup(text), false);
});

test('wikitext handles empty or removed annotations and stable ordering at one anchor', () => {
  const source = '正文', projection = api.createProjection(source);
  const highlight = { id: 'h', color: 'yellow', anchor: anchor(source, source) };
  assert.equal(api.buildReviewWikitext(identity, 'Page', projection, []), '');
  assert.equal(api.buildReviewWikitext(identity, 'Page', projection, [{ ...highlight, deleted: { by: 'Example', at: time } }]), '');
  const result = api.buildReviewWikitext(identity, 'Page', projection, [
    { ...highlight, id: 'z', threads: [{ ...comment('z'), text: '後一項' }] },
    { ...highlight, id: 'a', threads: [{ ...comment('a'), text: '前一項' }] },
  ]);
  assert.ok(result.indexOf('前一項') < result.indexOf('後一項'));
  assert.throws(() => api.buildReviewWikitext({ ...identity, revisionId: 0 }, 'Page', projection, []), /valid article revision/);
});
