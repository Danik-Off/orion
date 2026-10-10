// Капсула в углу экрана (режим orb): поведение. Вид — в style.css, раздел «Капсула».
//   - появляется кружком-реактором и пружиной раскрывается; уходя — сжимается обратно и тает;
//   - висит, пока её читают: время показа растёт с длиной ответа, под мышью — не исчезает;
//   - окно прозрачное, но клики мимо капсулы уходят в программу под ней (окно их не забирает);
//   - внутри — карточки ответа (погода, таймер) и «Да / Нет» на подтверждение: полное окно ради них не нужно;
//   - длинный ответ — четыре строки и «Открыть полностью».
// Чистые функции (время показа, хвост распознаваемой фразы) проверяются в Node.
/* exported createCapsule, lingerMs, tailText */
/* global renderCards */

// Сколько показывать капсулу после ответа: 4 с + 60 мс на символ, не дольше 15 с
const lingerMs = (text) => Math.min(15_000, 4000 + 60 * String(text || '').length);

// Распознаваемая фраза в капсуле — её конец: «…и поставь будильник на семь»
function tailText(text, max = 70) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const space = cut.indexOf(' ');
  return `…${space > 0 && space < 15 ? cut.slice(space + 1) : cut}`;
}

if (typeof module !== 'undefined') module.exports = { lingerMs, tailText };

const OPEN_MS = 30; // кружок виден кадр-другой, затем раскрывается
const CLOSE_MS = 320;
const MARGIN = 38; // сверху — место под кнопки и тень (20 px), снизу — отступ капсулы (18 px, см. style.css)

// mode() — текущий режим окна; onHidden() — капсула ушла (окно можно прятать); onStop() — «закрыть» посреди разговора
function createCapsule({ mode, onHidden, onStop }) {
  const body = document.body;
  const stage = document.querySelector('.stage');
  const caption = document.querySelector('#caption');
  const extra = document.querySelector('#orb-extra');
  const more = document.querySelector('#cap-more');
  let closeTimer = null;
  let hover = false;
  let through = null;

  // Высота окна — под капсулу: низ на месте, капсула растёт вверх
  const report = () => mode() === 'orb' && window.jarvis.orbHeight(Math.ceil(stage.getBoundingClientRect().height) + MARGIN);
  new ResizeObserver(() => {
    report();
    // Ответ не влез в четыре строки — предложить полное окно
    more.classList.toggle('on', caption.scrollHeight > caption.clientHeight + 2);
  }).observe(stage);

  // Клики мимо капсулы — программе под окном. Окно получает движение мыши и в «сквозном» режиме (forward)
  function passThrough(on) {
    if (through === on) return;
    through = on;
    window.jarvis.orbPassthrough(on);
  }
  document.addEventListener('mousemove', (e) => mode() === 'orb' && passThrough(!e.target.closest?.('.stage')));
  document.addEventListener('mouseleave', () => mode() === 'orb' && passThrough(true));
  stage.addEventListener('mouseenter', () => (hover = true));
  stage.addEventListener('mouseleave', () => (hover = false));

  // Раскрыться из кружка (окно только что показалось в углу)
  function open() {
    cancelClose();
    through = null;
    passThrough(true);
    body.classList.add('cap-seed');
    setTimeout(() => requestAnimationFrame(() => body.classList.remove('cap-seed')), OPEN_MS);
    requestAnimationFrame(report);
  }

  // Сжаться в кружок и растаять; потом onHidden. Снова позвали («Орион…») — cancelClose
  function close() {
    if (closeTimer) return;
    body.classList.add('cap-seed', 'cap-closing');
    closeTimer = setTimeout(() => {
      closeTimer = null;
      body.classList.remove('cap-closing');
      onHidden();
    }, CLOSE_MS);
  }
  function cancelClose() {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = null;
    body.classList.remove('cap-seed', 'cap-closing');
  }

  // Карточки ответа (cards.js) — в капсулу; null — убрать
  function showCards(cards) {
    const node = cards && renderCards(cards);
    extra.replaceChildren(...(node ? [node] : []));
  }

  // «Выключить компьютер?» — кнопки прямо в капсуле; голосом «да/нет» — как раньше
  function ask(onAnswer) {
    const row = document.createElement('div');
    row.className = 'orb-ask';
    for (const [label, ok, primary] of [
      ['Да', true, true],
      ['Нет', false, false],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn${primary ? ' primary' : ''}`;
      b.textContent = label;
      b.addEventListener('click', (e) => (e.stopPropagation(), onAnswer(ok)));
      row.append(b);
    }
    extra.replaceChildren(row);
  }

  const clear = () => extra.replaceChildren();

  more.addEventListener('click', (e) => (e.stopPropagation(), window.jarvis.presence('full')));
  document.querySelector('#cap-open').addEventListener('click', (e) => (e.stopPropagation(), window.jarvis.presence('full')));
  document.querySelector('#cap-close').addEventListener('click', (e) => {
    e.stopPropagation();
    onStop();
    close();
  });

  return { open, close, cancelClose, closing: () => !!closeTimer, hovered: () => hover, showCards, ask, clear, report, passThrough };
}
