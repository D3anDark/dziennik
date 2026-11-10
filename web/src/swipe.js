/**
 * Svelte action: a horizontal swipe that turns a page, for views with a "previous" and a "next" (a week, a month).
 * While the finger is down the content follows it 1:1 through direct transform writes; on release a spring
 * seeded with the finger's speed either turns the page or puts the content back, and a new touch can catch it
 * mid-flight. Touch and pen only: with a mouse the buttons do the job, and they stay the keyboard path too.
 * The element needs `touch-action: pan-y` (class "swipe") so vertical scrolling stays with the browser.
 */
const INTENT = 10; // px of mostly-horizontal travel before the gesture is ours
const FLICK = 0.5; // px/ms: a fast flick turns the page however short it was
const FAR = 0.35; // share of the width that turns the page at any speed
const STIFFNESS = 320;
const DAMPING = 34;

export function swipe(node, turn) {
  let start = null; // { x, y, id } while a finger is down
  let dragging = false;
  let x = 0;
  let speed = 0; // px/ms, of the last move
  let last = null; // { x, t } of the previous move
  let frame = 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  const place = (to) => {
    x = to;
    node.style.transform = to ? `translateX(${to}px)` : '';
  };

  /** Springs from where the content is to `target`, starting at the finger's speed, then calls `done`. */
  function settle(target, done) {
    cancelAnimationFrame(frame);
    if (still.matches) {
      place(target);
      return done?.();
    }
    let v = speed * 1000;
    let before = performance.now();
    const step = (now) => {
      const dt = Math.min(now - before, 32) / 1000;
      before = now;
      v += (-STIFFNESS * (x - target) - DAMPING * v) * dt;
      place(x + v * dt);
      if (Math.abs(x - target) < 0.5 && Math.abs(v) < 20) {
        place(target);
        return done?.();
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function down(e) {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    // Catches the content if it is still settling from the last swipe.
    cancelAnimationFrame(frame);
    start = { x: e.clientX - x, y: e.clientY, id: e.pointerId };
    last = { x: e.clientX, t: e.timeStamp };
    speed = 0;
  }

  function move(e) {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    if (!dragging) {
      if (Math.abs(dx - x) < INTENT || Math.abs(dx - x) < Math.abs(e.clientY - start.y)) return;
      dragging = true;
      node.setPointerCapture(e.pointerId);
    }
    if (e.timeStamp > last.t) speed = (e.clientX - last.x) / (e.timeStamp - last.t);
    last = { x: e.clientX, t: e.timeStamp };
    place(dx);
  }

  function up(e) {
    if (!start || e.pointerId !== start.id) return;
    const wasDragging = dragging;
    start = null;
    dragging = false;
    if (!wasDragging) return x && settle(0);
    const width = node.offsetWidth;
    // A finger that stopped before lifting did not flick, whatever its speed a moment earlier was.
    if (e.timeStamp - last.t > 80) speed = 0;
    // A flick decides, unless it goes back the way the content came: that takes the swipe back.
    const [flick, side] = [Math.abs(speed) > FLICK ? Math.sign(speed) : 0, Math.sign(x)];
    const go = flick ? (flick === side ? side : 0) : Math.abs(x) > width * FAR ? side : 0;
    if (!go || e.type === 'pointercancel') return settle(0);
    // Off to the side it was thrown to, then the new page comes in from the other one.
    settle(go * width, () => {
      (go < 0 ? turn.next : turn.prev)();
      place(-go * width * 0.3);
      speed = 0;
      settle(0);
    });
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  return {
    update: (next) => (turn = next),
    destroy() {
      cancelAnimationFrame(frame);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    },
  };
}
