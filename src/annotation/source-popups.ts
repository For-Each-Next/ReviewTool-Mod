import { annotationMessages, type AnnotationMessages } from './i18n';
import type { ElementNode } from './types';
import { imagePreviews } from './image-preview';
import type { PopupLayout } from './popup-layout';
import { decodeHTMLStrict } from 'entities';
import { formatReferenceSource } from './reference-template';
import { externalLinkAt } from './external-links';

let nextPopup = 0;

/** Keep source readable and selectable while making citation destinations directly usable. */
function appendReferenceSource(doc: Document, code: HTMLElement, source: string): void {
  const base = new URL('/wiki/', /^https?:/.test(doc.location?.href ?? '') ? doc.location.href : 'https://zh.wikipedia.org/');
  const pattern = /\[\[[^\r\n\[\]]+\]\]|(?:https?:)?\/\/[^\s<>\[\]{}|]+/gi;
  let from = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const raw = match[0];
    let href: URL | undefined, length = raw.length;
    if (raw.startsWith('[[')) {
      const title = decodeHTMLStrict(raw.slice(2, -2).split('|')[0]).trim().replace(/^:/, '');
      const [page, ...fragment] = title.split('#');
      if (page && !/^[.]{1,2}$/.test(page) && !/[\u0000-\u001f\u007f<>\[\]{}]/.test(page)) {
        href = new URL(encodeURIComponent(page.replace(/ /g, '_')), base);
        if (fragment.length) href.hash = fragment.join('#').replace(/ /g, '_');
      }
    } else {
      const external = externalLinkAt(source, match.index, base.href);
      if (external) {
        const target = new URL(external.href);
        if (target.protocol === 'https:' || target.protocol === 'http:') { href = target; length = external.end - match.index; }
      }
    }
    if (!href) continue;
    code.append(doc.createTextNode(source.slice(from, match.index)));
    const link = doc.createElement('a');
    link.textContent = raw.slice(0, length); link.href = href.href;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    code.append(link);
    from = match.index + length;
  }
  code.append(doc.createTextNode(source.slice(from)));
}

/** One interactive source popup per mounted view; its contents are excluded from annotation mapping. */
export function sourcePopups(doc: Document, root: HTMLElement, source: string, entries: WeakMap<HTMLElement, ElementNode>, images: WeakMap<HTMLElement, HTMLImageElement>, selectTrigger: (element: HTMLElement) => void, layout: PopupLayout, messages: AnnotationMessages = annotationMessages()) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let linkModifier = false;
  const setLinkModifier = (pressed: boolean) => {
    if (pressed === linkModifier) return;
    linkModifier = pressed; root.toggleAttribute('data-link-modifier', pressed);
  };
  const updateLinkModifier = (event: KeyboardEvent | PointerEvent) => setLinkModifier(event.metaKey || event.ctrlKey);
  doc.addEventListener('keydown', updateLinkModifier, options);
  doc.addEventListener('keyup', updateLinkModifier, options);
  doc.defaultView?.addEventListener('blur', () => setLinkModifier(false), options);
  const thumbnail = imagePreviews(controller.signal);
  const popup = doc.createElement('div');
  popup.className = 'annotation-source-popup';
  popup.dataset.annotationPopup = '';
  popup.id = `annotation-source-popup-${++nextPopup}`;
  popup.setAttribute('role', 'dialog');
  popup.tabIndex = -1;
  popup.hidden = true;
  const heading = doc.createElement('div'); heading.className = 'annotation-popup-heading';
  heading.id = popup.id + '-heading';
  popup.setAttribute('aria-labelledby', heading.id);
  const code = doc.createElement('pre');
  const preview = doc.createElement('div'); preview.className = 'annotation-popup-image';
  preview.dataset.annotationImage = ''; preview.hidden = true;
  popup.append(heading, code, preview);
  let active: HTMLElement | null = null;
  let down: { x: number; y: number } | null = null;
  let dragged = false;
  let selectingLink: HTMLElement | null = null;
  const restoreLink = () => {
    if (selectingLink?.dataset.targetUrl) selectingLink.setAttribute('href', selectingLink.dataset.targetUrl);
    selectingLink = null;
  };
  let restoringFocus = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const hide = (restoreFocus = false) => {
    const previous = active;
    const popupFocused = popup.contains(doc.activeElement);
    cancel(); popup.hidden = true; layout.hide('source');
    active?.setAttribute('aria-expanded', 'false');
    active?.removeAttribute('aria-describedby');
    active = null;
    if (restoreFocus && popupFocused && previous) {
      restoringFocus = true; previous.focus({ preventScroll: true }); restoringFocus = false;
    }
  };
  const trigger = (target: EventTarget | null): HTMLElement | null => {
    const element = (target as Element | null)?.closest?.<HTMLElement>('[data-inspect]') ?? null;
    return element && root.contains(element) && entries.has(element) ? element : null;
  };
  const inside = (target: EventTarget | null, element: HTMLElement | null): boolean => Boolean(target && 'nodeType' in target && element?.contains(target as Node));
  const position = () => {
    if (!active || popup.hidden) return;
    const trigger = active;
    layout.show('source', popup, () => trigger.getBoundingClientRect());
  };
  const displayImage = (image: HTMLImageElement) => {
    preview.replaceChildren(image);
    if (image.complete && image.naturalWidth === 0) preview.textContent = messages.imageUnavailable;
    position();
  };
  const show = (element: HTMLElement) => {
    const model = entries.get(element);
    if (!model?.inspection) return;
    hide(); active = element;
    const image = images.get(element);
    const isImage = model.inspection.kind === 'image';
    heading.textContent = isImage ? messages.imagePreview : model.inspection.kind === 'link' ? messages.linkSource : messages.referenceSource;
    code.hidden = isImage;
    code.replaceChildren();
    if (!isImage) {
      const raw = source.slice(model.inspection.from, model.inspection.to);
      if (model.inspection.kind === 'reference') appendReferenceSource(doc, code, formatReferenceSource(raw));
      else code.textContent = raw;
    }
    preview.hidden = !isImage;
    preview.textContent = isImage ? messages.imageLoading : '';
    if (!popup.isConnected) root.append(popup);
    popup.hidden = false;
    element.setAttribute('aria-expanded', 'true');
    element.setAttribute('aria-describedby', popup.id);
    position();
    if (image) displayImage(image);
    else if (isImage) {
      void thumbnail(model.fileName ?? '').then(result => {
        if (controller.signal.aborted || active !== element || popup.hidden) return;
        let loaded: HTMLImageElement | null = null;
        if (result) {
          loaded = doc.createElement('img');
          loaded.src = result.url; loaded.width = result.width; loaded.height = result.height;
          loaded.alt = model.fileName ?? '';
          images.set(element, loaded);
        }
        if (loaded) displayImage(loaded);
        else { preview.textContent = messages.imageUnavailable; position(); }
      });
    }
  };
  const later = () => {
    cancel();
    timer = setTimeout(() => {
      if (doc.activeElement !== active && !layout.contains(doc.activeElement)) hide();
    }, 140);
  };
  root.addEventListener('pointerover', event => {
    updateLinkModifier(event);
    if (event.buttons) return;
    const element = trigger(event.target);
    if (inside(doc.activeElement, popup)) { cancel(); return; }
    if (element && element !== active) show(element);
    else if (element || layout.contains(event.target)) cancel();
  }, options);
  root.addEventListener('pointerout', event => {
    if (inside(event.relatedTarget, active) || layout.contains(event.relatedTarget)) return;
    if (trigger(event.target) || layout.contains(event.target)) later();
  }, options);
  root.addEventListener('focusin', event => { const element = trigger(event.target); if (element && !restoringFocus) show(element); }, options);
  root.addEventListener('focusout', event => {
    if (layout.contains(event.relatedTarget)) return;
    if (trigger(event.target) || (inside(event.target, popup) && event.relatedTarget && event.relatedTarget !== active)) hide();
  }, options);
  root.addEventListener('click', event => {
    const element = trigger(event.target);
    if (element) {
      const model = entries.get(element);
      if ((event.metaKey || event.ctrlKey) && model?.inspection?.kind === 'link') {
        event.preventDefault();
        doc.defaultView?.open(model.href, '_blank', 'noopener');
        return;
      }
      event.preventDefault();
      if (event.detail > 0 && dragged) return;
      show(element);
      selectTrigger(element);
    }
  }, options);
  root.addEventListener('pointerdown', event => {
    down = { x: event.clientX, y: event.clientY }; dragged = false;
    restoreLink();
    const link = (event.target as Element).closest<HTMLElement>('a[data-target-url]');
    // Let the browser start a text selection on an ordinary drag; modified clicks remain links.
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey) { selectingLink = link; link.removeAttribute('href'); }
  }, options);
  doc.addEventListener('pointerup', restoreLink, options);
  doc.addEventListener('pointercancel', restoreLink, options);
  root.addEventListener('pointermove', event => {
    updateLinkModifier(event);
    if (down && event.buttons && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) dragged = true;
  }, options);
  root.addEventListener('keydown', event => {
    const element = trigger(event.target);
    if (element === active && !popup.hidden && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault(); popup.focus({ preventScroll: true }); return;
    }
    if (element && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); show(element);
      selectTrigger(element);
    }
  }, options);
  popup.addEventListener('load', position, { ...options, capture: true });
  popup.addEventListener('error', event => {
    if (inside(event.target, preview)) { preview.textContent = messages.imageUnavailable; position(); }
  }, { ...options, capture: true });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(true); }, options);
  doc.addEventListener('pointerdown', event => {
    if (!inside(event.target, active) && !layout.contains(event.target)) hide();
  }, options);
  doc.addEventListener('scroll', event => { if (!layout.contains(event.target)) hide(); }, { ...options, capture: true });
  doc.defaultView?.addEventListener('resize', () => hide(), options);
  return { hide: () => hide(), destroy: () => { setLinkModifier(false); restoreLink(); hide(); controller.abort(); popup.remove(); } };
}
