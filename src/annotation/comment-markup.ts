import { createProjection } from './projection';
import type { ViewNode } from './types';
import { samePageCommentId } from './view-url';

/** Reuse the bounded wikitext parser; comments do not participate in article-source mapping. */
export function renderCommentMarkup(doc: Document, source: string, commentPageUrl = doc.location.href): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const emit = (node: ViewNode): Node | null => {
    if (node.kind === 'hidden') return null;
    if (node.kind === 'text') return doc.createTextNode(node.text);
    const element = doc.createElement(node.tag);
    if (node.flowBreak) element.dataset.breakBefore = node.flowBreak;
    if (node.href) {
      const commentId = samePageCommentId(node.href, commentPageUrl);
      element.setAttribute('href', node.href); element.setAttribute('target', commentId ? '_self' : '_blank'); element.setAttribute('rel', 'noopener noreferrer');
      if (commentId) element.dataset.commentLink = commentId;
    }
    for (const [name, value] of Object.entries(node.attributes ?? {})) element.setAttribute(name, value);
    for (const child of node.children) { const rendered = emit(child); if (rendered) element.append(rendered); }
    return element;
  };
  for (const node of createProjection(source, { mode: 'comment' }).blocks) { const rendered = emit(node); if (rendered) fragment.append(rendered); }
  return fragment;
}

export function scanCommentMarkup(text: string, onBreak?: (position: number) => void): boolean {
  let comment = false, literal: string | null = null, tables = 0, templates = 0;
  const pattern = /<!--|-->|<\/?(nowiki|pre|source|syntaxhighlight|math|poem|ref)\b[^>]*>|\{\{|\}\}|\{\||\|\}|\n/gi;
  const inMarkup = () => comment || literal !== null || tables > 0 || templates > 0;
  let token: RegExpExecArray | null;
  while ((token = pattern.exec(text))) {
    const value = token[0], tag = token[1]?.toLowerCase();
    if (literal) {
      if (tag === literal && value.startsWith('</')) literal = null;
      continue;
    }
    if (comment) {
      if (value === '-->') comment = false;
      continue;
    }
    if (value === '<!--') comment = true;
    else if (tag) {
      if (!value.startsWith('</') && !/\/\s*>$/.test(value)) literal = tag;
    } else if (value === '{{') templates++;
    else if (value === '}}') templates = Math.max(0, templates - 1);
    else if (value === '{|') tables++;
    else if (value === '|}') tables = Math.max(0, tables - 1);
    else if (value === '\n' && !inMarkup()) onBreak?.(token.index);
  }
  return inMarkup();
}

/** The editor uses the same boundaries as the exporter for automatic list editing. */
export function reviewCommentInMarkup(text: string, position = text.length): boolean {
  return scanCommentMarkup(text.slice(0, position));
}
