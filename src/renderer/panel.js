// Панель над строкой ввода: текст, необязательное поле и кнопки. Ею пользуются вопросы, мастер записи голоса и установка.
/* exported showPanel, hidePanel */
/* global $, panel */

// Панель: текст, необязательное поле ввода и кнопки [подпись, действие, основная?].
// modal — посреди окна поверх всего (вопрос, без ответа на который дальше не пойти)
function showPanel(text, buttons, field, { modal = false } = {}) {
  panel.classList.toggle('modal', modal);
  $('#backdrop').hidden = !modal;
  $('#panel-text').textContent = text;
  const actions = $('#panel-actions');
  actions.replaceChildren();
  const box = $('#panel-field');
  box.replaceChildren();
  if (field) {
    const f = document.createElement('input');
    f.className = 'panel-input';
    f.placeholder = field.placeholder || '';
    f.value = field.value || '';
    f.maxLength = 40;
    f.addEventListener('keydown', (e) => e.key === 'Enter' && field.onEnter?.(f.value));
    box.append(f);
    setTimeout(() => f.focus(), 0);
  }
  for (const [label, fn, primary] of buttons) {
    const b = document.createElement('button');
    b.className = `btn${primary ? ' primary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => fn($('#panel-field input')?.value));
    actions.append(b);
  }
  panel.hidden = false;
}
const hidePanel = () => {
  panel.hidden = true;
  $('#backdrop').hidden = true;
};
