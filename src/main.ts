import state from './state';
import styles from './styles.css';
import annotationStyles from './annotation/style.css';
import { initLiveAnnotation } from './annotation/live';

/** The bundle waits for mediawiki.base before evaluating this entry point. */
async function init(): Promise<void> {
  await mw.loader.using(['mediawiki.api', 'mediawiki.util']);
  if (document.readyState === 'loading') await new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  if (mw.config.get('wgNamespaceNumber') !== 0) return;
  await state.initHanAssist().catch(error => console.warn('[ReviewTool] Language helper unavailable; using default labels.', error));
  const style = document.createElement('style'); style.id = 'reviewtool-local-styles'; style.textContent = styles + annotationStyles; document.head.append(style);
  await initLiveAnnotation();
}
void init().catch(error => console.error('[ReviewTool] Startup failed', error));
