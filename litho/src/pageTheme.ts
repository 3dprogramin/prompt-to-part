// The light / dark switch of the demo and production pages (a shop sets the widget's theme
// attribute itself, to match its own theme). It cycles Auto → Light → Dark, applies the choice to
// the page (data-theme on <html>) and to every <litho-preview> on it, and is remembered in this
// browser.

export type PageTheme = 'auto' | 'light' | 'dark';

const KEY = 'litho-theme';
const ORDER: PageTheme[] = ['auto', 'light', 'dark'];
const LABEL: Record<PageTheme, string> = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };

/** The next theme in the cycle. */
export const nextTheme = (t: PageTheme): PageTheme => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length];

function saved(): PageTheme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function apply(t: PageTheme, button: HTMLButtonElement) {
  document.documentElement.dataset.theme = t;
  for (const el of document.querySelectorAll('litho-preview')) el.setAttribute('theme', t);
  button.textContent = LABEL[t];
  button.title = `Theme: ${t} (click to change)`;
}

const button = document.getElementById('theme-switch');
if (button instanceof HTMLButtonElement) {
  let theme = saved();
  apply(theme, button);
  button.addEventListener('click', () => {
    theme = nextTheme(theme);
    apply(theme, button);
    try { localStorage.setItem(KEY, theme); } catch { /* private window: not remembered */ }
  });
}
