import { decodeHTMLStrict } from 'entities';
import { templateFields } from './template-fields';
import { opaqueAt, readTag } from './opaque';

const rArgs = new Set(['name', 'n', 'group', 'grp', 'g', 'page', 'p', 'pages', 'pp']);
for (let i = 1; i <= 9; i++) {
  for (const key of [String(i), `name${i}`, `n${i}`, `page${i}`, `p${i}`, `${i}p`, `pages${i}`, `pp${i}`, `${i}pp`]) rArgs.add(key);
}
const rpArgs = new Set(['1', 'page', 'p', 'pages', 'pp', 'location', 'loc', 'at', 'style', 'no-pp', 'nopp', 'quote', 'quotation', 'q', 'wrap']);
const sfnArgs = new Set(['1', '2', '3', '4', '5', 'p', 'page', 'pp', 'pages', 'loc', 'ps', 'postscript', 'ref', 'Ref', 'ignore-false-positive', 'ignore-err']);
// Verified redirects on Chinese Wikipedia, including aliases of aliases.
const families = new Map([['r', 'r'], ['rp', 'rp'], ['page', 'rp'], ['sfn', 'sfn'], ['shortened footnote template', 'sfn']]);
type Value = (...keys: string[]) => string;

/** Reference templates use one atomic source span, with their complete invocation in the popup. */
export function referenceTemplate(source: string, from: number, to: number): string | null {
  const title = /^\{\{([^|{}]+)\|/.exec(source.slice(from, to))?.[1];
  if (!title) return null;
  const family = families.get(title.replace(/_/g, ' ').trim().replace(/^(?:template|模板):\s*/i, '').replace(/\s+/g, ' ').toLowerCase());
  if (!family) return null;
  const parts = templateFields(source, from + 2, to - 2);
  if (!parts || parts.length < 2) return null;
  const allowed = family === 'r' ? rArgs : family === 'rp' ? rpArgs : sfnArgs;
  const args = new Map<string, string>();
  let positional = 1;
  for (const field of parts.slice(1)) {
    const key = field.equals === undefined ? String(positional++) : source.slice(field.from, field.equals).trim();
    if (!allowed.has(key)) return null;
    const raw = source.slice(field.equals === undefined ? field.from : field.equals + 1, field.to).trim();
    // Dynamic names and rich locators require expansion. Keep those invocations as source.
    if (/[{}<>\[\]]/.test(raw)) return null;
    args.set(key, decodeHTMLStrict(raw));
  }
  const value: Value = (...keys) => {
    const key = keys.find(key => args.has(key));
    return key === undefined ? '' : args.get(key) ?? '';
  };
  return family === 'r' ? namedReferences(value) : family === 'rp' ? pageLocator(value) : shortFootnote(value);
}

function namedReferences(value: Value): string | null {
  const labels: string[] = [];
  let gap = false;
  for (let i = 1; i <= 9; i++) {
    const name = i === 1 ? value('name1', 'name', 'n1', 'n', '1') : value(`name${i}`, `n${i}`, String(i));
    const page = i === 1 ? value('page1', 'page', 'p1', '1p', 'p') : value(`page${i}`, `p${i}`, `${i}p`);
    const pages = i === 1 ? value('pages1', 'pages', 'pp1', '1pp', 'pp') : value(`pages${i}`, `pp${i}`, `${i}pp`);
    if (!name) { if (page || pages) return null; gap = true; continue; }
    // The real template stops at gaps; avoid presenting later arguments as active references.
    if (gap || (page && pages)) return null;
    labels.push(`[${name}]${page || pages ? ':' + (page || pages) : ''}`);
  }
  return labels.length ? labels.join('') : null;
}

function pageLocator(value: Value): string | null {
  const pages = value('pages', 'pp', '1');
  const page = value('page', 'p');
  const location = value('location', 'loc', 'at');
  const where = [pages ? pages + (page ? `, [${page}]` : '') : page, location].filter(Boolean).join(', ');
  if (!where) return null;
  if (value('style').toLowerCase() !== 'ama') return ':' + where;
  const prefix = value('no-pp', 'nopp') ? '' : value('pages', 'pp') ? 'pp. ' : page ? 'p. ' : '';
  return `(${prefix}${where})`;
}

function shortFootnote(value: Value): string | null {
  const parts: string[] = [];
  let gap = false;
  for (let i = 1; i <= 5; i++) {
    const part = value(String(i));
    if (!part) { gap = true; continue; }
    if (gap) return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  const where = [value('p', 'page') || value('pp', 'pages'), value('loc')].filter(Boolean).join(', ');
  // Readable source identity, without generating Wikipedia's page-wide numbering or bibliography links.
  return `[${parts.join(' ')}${where ? ':' + where : ''}]`;
}

/** A display-only citation layout; the projection and its source coordinates stay unchanged. */
export function formatReferenceSource(source: string): string {
  let result = '', cursor = 0, formatted = false;
  while (cursor < source.length) {
    const extent = opaqueAt(source, cursor);
    if (!extent) { result += source[cursor++]; continue; }
    const raw = source.slice(cursor, extent.end);
    const fields = extent.reason === 'template' && !raw.startsWith('{{{')
      ? templateFields(source, cursor + 2, extent.end - 2) : null;
    const title = fields?.length ? source.slice(fields[0].from, fields[0].to).trim().replace(/_/g, ' ').replace(/^(?:template|模板):\s*/i, '') : '';
    if (fields && /^cite(?:\s+[a-z][a-z -]*)?$/i.test(title)) {
      const name = title.replace(/\s+/g, ' ').toLowerCase().replace(/^cite/, 'Cite');
      const parameters = fields.slice(1).map(field => {
        if (field.equals === undefined) return `  | ${source.slice(field.from, field.to).trim()}`;
        return `  | ${source.slice(field.from, field.equals).trim()} = ${source.slice(field.equals + 1, field.to).trim()}`;
      });
      result += [`{{${name}`, ...parameters, '}}'].join('\n');
      formatted = true;
    } else result += raw;
    cursor = extent.end;
  }
  if (!formatted) return source;
  const opening = readTag(result, 0);
  const closing = /<\/ref\s*>\s*$/i.exec(result);
  if (opening?.name === 'ref' && !opening.closing && !opening.selfClosing && closing) {
    return `${result.slice(0, opening.end)}\n${result.slice(opening.end, closing.index).trim()}\n${closing[0].trim()}`;
  }
  return result;
}
