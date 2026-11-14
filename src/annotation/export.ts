import type { Annotation } from '../annotations';
import type { ReviewIdentity } from './live-storage';
import { threadRoots } from './annotation-state';
import { headingSourceStart } from './heading-anchors';
import { selectionFromSource } from './mapping';
import { SourceIndex } from './source-index';
import type { AnnotationComment, AnnotationRemoval, HighlightAnnotation, Projection, ViewNode, WikipediaHeadingAnchor } from './types';
import { encodeId } from './uuid';
import { scanCommentMarkup } from './comment-markup';
export { reviewCommentInMarkup } from './comment-markup';

export const annotationExportFormat = 'reviewtool.annotation-export/2';

interface ExportedComment extends Annotation {
  highlightId: string;
  rootId: string;
  parentId: string | null;
  editedAt?: string;
  editedBy?: string;
  resolution?: AnnotationRemoval;
  closed: boolean;
  closure?: AnnotationRemoval;
}

/** A portable discussion export. The groups also feed the existing review-writing importer. */
export function buildAnnotationExport(identity: ReviewIdentity, pageName: string, projection: Projection, annotations: readonly HighlightAnnotation[]) {
  const index = new SourceIndex(projection.source);
  const sections: { start: number; path: string }[] = [], stack: { level: number; title: string }[] = [];
  const text = (nodes: readonly ViewNode[]): string => nodes.map(node => node.kind === 'text' ? node.text : node.kind === 'element' ? text(node.children) : '').join('');
  const walk = (nodes: readonly ViewNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      const start = headingSourceStart(node);
      if (start !== undefined) {
        const level = Number(node.tag.slice(1));
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, title: text(node.children).trim() });
        sections.push({ start: index.toByte(start), path: stack.map(item => item.title).join(' / ') });
      }
      walk(node.children);
    }
  };
  walk(projection.blocks);
  const groups = new Map<string, ExportedComment[]>();
  const highlights = [...annotations].sort((a, b) => a.anchor.start - b.anchor.start || a.id.localeCompare(b.id)).map(annotation => {
    const sourceText = projection.source.slice(index.toUtf16(annotation.anchor.start), index.toUtf16(annotation.anchor.end));
    const quote = selectionFromSource(projection, annotation.anchor)?.quote ?? sourceText;
    const sectionPath = [...sections].reverse().find(section => section.start <= annotation.anchor.start)?.path ?? '序言';
    const visit = (comment: AnnotationComment, root: AnnotationComment, parentId: string | null) => {
      const entry: ExportedComment = {
        id: comment.id, highlightId: annotation.id, rootId: root.id, parentId,
        sectionPath, sentencePos: String(annotation.anchor.start), sentenceText: quote,
        opinion: comment.text, createdBy: comment.author, createdAt: Date.parse(comment.createdAt),
        resolved: Boolean(root.resolution?.resolved), closed: Boolean(root.resolved),
        ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
        ...(comment.editedBy ? { editedBy: comment.editedBy } : {}),
        ...(root.resolution ? { resolution: root.resolution } : {}),
        ...(root.resolved ? { closure: root.resolved } : {}),
      };
      const group = groups.get(sectionPath) ?? []; group.push(entry); groups.set(sectionPath, group);
      for (const reply of comment.replies) visit(reply, root, comment.id);
    };
    for (const root of threadRoots(annotation)) visit(root, root, null);
    // Highlight metadata remains independent from comment authorship and edit metadata.
    const metadata = { ...annotation }; delete metadata.threads; delete metadata.comment;
    return { ...metadata, sectionPath, quote, sourceText };
  });
  return { format: 'reviewtool.annotation-export/1', exportedAt: Date.now(), pageName,
    document: { ...identity, offsetUnit: 'utf8-byte' as const }, highlights,
    groups: [...groups].map(([sectionPath, annotations]) => ({ sectionPath, annotations })),
  };
}

/** Keep the projection canonical for in-process imports; compact IDs only in the downloaded file. */
export function serializeAnnotationExport(payload: ReturnType<typeof buildAnnotationExport>): string {
  return JSON.stringify({ ...payload, format: annotationExportFormat,
    highlights: payload.highlights.map(highlight => ({ ...highlight, id: encodeId(highlight.id) })),
    groups: payload.groups.map(group => ({ ...group, annotations: group.annotations.map(comment => ({ ...comment,
      id: encodeId(comment.id), highlightId: encodeId(comment.highlightId), rootId: encodeId(comment.rootId), parentId: comment.parentId === null ? null : encodeId(comment.parentId),
    })) })),
  }, null, 2);
}

export function downloadAnnotationExport(doc: Document, payload: ReturnType<typeof buildAnnotationExport>): void {
  const url = URL.createObjectURL(new Blob([serializeAnnotationExport(payload)], { type: 'application/json;charset=utf-8' }));
  const link = doc.createElement('a'); link.href = url;
  link.download = `review-tool-annotations-${payload.document.revisionId}-${new Date(payload.exportedAt).toISOString().replace(/[:.]/g, '')}.json`;
  doc.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Article quotations and labels are literal text, even inside the rvw template. */
function inlineWikitext(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[&<>"'\[\]{}|~_:#*;=]/g, character => `&#${character.codePointAt(0)};`);
}

function reviewSections(projection: Projection, offsets: SourceIndex, headingAnchors: readonly WikipediaHeadingAnchor[]) {
  const anchors = new Map(headingAnchors.map(heading => [heading.start, heading.id]));
  const headings: { level: number; start: number; title: string; anchor: string }[] = [];
  const text = (nodes: readonly ViewNode[]): string => nodes.map(node => node.kind === 'text' ? node.text : node.kind === 'element' ? text(node.children) : '').join('');
  const visit = (nodes: readonly ViewNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      const from = headingSourceStart(node);
      if (from !== undefined) {
        const start = offsets.toByte(from);
        headings.push({ level: Number(node.tag.slice(1)), start, title: text(node.children).trim() || '未命名章节', anchor: anchors.get(start) ?? '' });
      }
      visit(node.children);
    }
  };
  visit(projection.blocks);
  headings.sort((left, right) => left.start - right.start);
  const path: typeof headings = [];
  const sections = [{ start: -1, title: '序言', anchor: '' }];
  for (const heading of headings) {
    while (path.length && path[path.length - 1].level >= heading.level) path.pop();
    path.push(heading);
    sections.push({ start: heading.start, title: path.map(part => part.title).join(' / '), anchor: heading.anchor });
  }
  return sections;
}

function commentItems(value: string): string[] {
  const text = value.replace(/\r\n?/g, '\n'), items: string[] = [];
  let start = 0;
  const append = (end: number) => {
    const item = text.slice(start, end).trim();
    if (item) items.push(item);
    start = end + 1;
  };
  scanCommentMarkup(text, append);
  append(text.length);
  return items;
}

function reviewCommentLines(comment: AnnotationComment, depth = 1): string[] {
  const lines: string[] = [];
  for (const item of commentItems(comment.text)) {
    const marker = /^\\?([*#]+)(?:[ \t]+|$)/.exec(item);
    const itemDepth = depth + (marker ? Math.max(0, marker[1].replace(/^#/, '').length - 1) : 0);
    const text = marker ? item.slice(marker[0].length) : item;
    if (text.trim()) lines.push(`#${'*'.repeat(itemDepth)} ${text}`);
  }
  for (const reply of comment.replies) lines.push(...reviewCommentLines(reply, depth + 1));
  return lines;
}

/** Readable review text matching the personal userscript, without publishing an edit. */
export function buildReviewWikitext(identity: ReviewIdentity, pageName: string, projection: Projection, annotations: readonly HighlightAnnotation[], headingAnchors: readonly WikipediaHeadingAnchor[] = []): string {
  if (!Number.isSafeInteger(identity.revisionId) || identity.revisionId < 1) throw new TypeError('A valid article revision is required for export.');
  const offsets = new SourceIndex(projection.source), sections = reviewSections(projection, offsets, headingAnchors);
  const highlights = annotations.filter(annotation => !annotation.deleted).sort((left, right) => left.anchor.start - right.anchor.start || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const lines: string[] = [];
  let sectionIndex = 0, previousSection = -1;
  for (const annotation of highlights) {
    while (sectionIndex + 1 < sections.length && sections[sectionIndex + 1].start <= annotation.anchor.start) sectionIndex++;
    if (sectionIndex !== previousSection) {
      if (lines.length) lines.push('--~~~~', '');
      const section = sections[sectionIndex], fragment = section.anchor ? `#${section.anchor}` : '';
      lines.push(`'''[[Special:PermaLink/${identity.revisionId}${fragment}|${inlineWikitext(section.title)}]]'''`);
      previousSection = sectionIndex;
    }
    const quote = selectionFromSource(projection, annotation.anchor)?.quote ?? projection.source.slice(offsets.toUtf16(annotation.anchor.start), offsets.toUtf16(annotation.anchor.end));
    const prefix = `# {{rvw|${inlineWikitext(quote)}}} —— `;
    const comments = threadRoots(annotation).flatMap(comment => reviewCommentLines(comment));
    if (comments.length === 1 && comments[0].startsWith('#* ') && !comments[0].includes('\n')) lines.push(prefix + comments[0].slice(3));
    else lines.push(prefix, ...comments);
  }
  if (!lines.length) return '';
  lines.push('--~~~~');
  const notice = '以下内容使用[[WP:REVTOOL]]生成<!-- 预期条目变化比较大，没有启用[[Special:PrefixIndex/Wikipedia:ReviewTool/data/|联机行内凸显]]功能😂 -->。--~~~~';
  return [`=== For Each ... Next的意见 @ ${inlineWikitext(pageName)} ===`, '', notice, '', ...lines].join('\n');
}
