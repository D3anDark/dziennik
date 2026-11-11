// Put into every page the server serves (`inject` in main.rs), whoever wrote the frontend. The server fills in the
// warning; for an official build it sends this script empty.
(() => {
  const text = __WARNING__;
  const red = '#b91c1c';
  // Styles go through the CSSOM: the server's CSP refuses inline <style> and style attributes.
  const make = (tag, style = {}, ns) => {
    const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    Object.assign(e.style, style);
    return e;
  };
  const host = make('dziennik-warning');
  // A closed shadow root keeps the page's own styles and scripts from reaching the window by accident.
  const root = host.attachShadow({ mode: 'closed' });
  // The dialog covers the whole screen and darkens it; the card sits in the middle.
  const dialog = make('dialog', {
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    margin: '0',
    padding: '1rem',
    border: '0',
    background: 'rgba(20, 0, 0, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });
  const card = make('div', {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '34rem',
    maxHeight: '100%',
    overflow: 'auto',
    padding: '1.75rem 1.5rem 1.5rem',
    borderTop: `12px solid ${red}`,
    borderRadius: '16px',
    background: '#fff',
    color: '#1a1a1a',
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    font: "18px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    textAlign: 'center',
  });
  const svg = 'http://www.w3.org/2000/svg';
  const icon = make('svg', { display: 'block', width: '72px', height: '72px', margin: '0 auto 0.75rem' }, svg);
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const [d, fill] of [['M12 1.5 0.5 21.5h23z', red], ['M10.9 8h2.2l-0.4 7.5h-1.4zM10.8 17.3h2.4v2.4h-2.4z', '#fff']]) {
    const path = make('path', {}, svg);
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    icon.append(path);
  }
  const title = make('h2', {
    margin: '0 0 0.75rem',
    color: red,
    font: 'inherit',
    fontSize: '28px',
    fontWeight: '800',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  });
  title.id = 'title';
  title.textContent = 'Ostrzeżenie';
  const p = make('p', { margin: '0 0 1.5rem', fontWeight: '500', textWrap: 'pretty' });
  p.id = 'text';
  p.textContent = text;
  const ok = make('button', {
    width: '100%',
    padding: '0.85rem 1rem',
    border: '0',
    borderRadius: '10px',
    background: red,
    color: '#fff',
    font: 'inherit',
    fontWeight: '700',
    cursor: 'pointer',
  });
  ok.type = 'button';
  ok.textContent = 'Rozumiem';
  // Removed, not closed: the inline display:flex would keep a closed dialog on screen.
  ok.addEventListener('click', () => host.remove());
  // Only the button dismisses it, so Escape cannot wave it away unread.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-labelledby', 'title');
  dialog.setAttribute('aria-describedby', 'text');
  card.append(icon, title, p, ok);
  dialog.append(card);
  root.append(dialog);
  // Next to <body>, not in it: a frontend that replaces the body's content leaves the window in place.
  document.documentElement.append(host);
  dialog.showModal();
})();
