// Люди: запись голоса по четырём фразам, имя и обращение, настройка отклика на имя.
/* exported wizardHeard, startWizard, cancelWizard */
/* global panel, peopleBtn, name, voices:writable, wizard:writable, talkingTo:writable, mic, toggleMic, interrupt, speak, playChime, refreshState, showPanel, hidePanel */

// Ядро предлагает записать голос (знакомство) — тот же мастер, что у кнопки с человечком
window.jarvis.onEnrollOffer(() => !wizard && startWizard());

async function refreshPeople() {
  voices = (await window.jarvis.people()) || voices;
  peopleBtn.classList.toggle('on', voices.people.length > 0);
}

function showPeople() {
  const list = voices.people
    .map((p) => `• ${p.name || 'без имени'} — «${p.honorific}», порог ${p.threshold}, образцов ${p.samples}`)
    .join('\n');
  const last = voices.last
    ? `\nПоследняя фраза: сходство ${voices.last.score} с «${voices.last.name || 'без имени'}» — ${voices.last.match ? 'узнан' : 'не узнан'}.`
    : '';
  const text = voices.people.length
    ? `Я узнаю по голосу:\n${list}${last}\n\nБез обращения по имени я продолжаю разговор только с тем, кто его начал. ` +
      'Если узнаю плохо — перезапишите голос: порог подстроится под ваш микрофон.'
    : 'Запишу ваш голос по четырём фразам и спрошу, как к вам обращаться. После этого я буду узнавать вас, ' +
      'обращаться «сэр» или «мисс», помнить именно ваше и не реагировать на чужие разговоры.';
  const buttons = [[voices.people.length ? 'Добавить человека' : 'Начать', () => startWizard(), true]];
  buttons.push(['Настроить отклик на имя', () => startWakeTuning()]);
  for (const p of voices.people) buttons.push([`Изменить: ${p.name || 'без имени'}`, () => editPerson(p)]);
  buttons.push(['Закрыть', hidePanel]);
  showPanel(text, buttons);
}

function editPerson(p) {
  showPanel(
    `${p.name || 'Без имени'} — обращение «${p.honorific}».`,
    [
      ['Сэр', async () => (await window.jarvis.personUpdate(p.id, { honorific: 'сэр' }), refreshPeople().then(showPeople))],
      ['Мисс', async () => (await window.jarvis.personUpdate(p.id, { honorific: 'мисс' }), refreshPeople().then(showPeople))],
      ['Переименовать', async (value) => (await window.jarvis.personUpdate(p.id, { name: value }), refreshPeople().then(showPeople))],
      ['Перезаписать голос', () => startWizard(p)],
      [
        'Удалить',
        async () => {
          await window.jarvis.personRemove(p.id);
          if (talkingTo === p.id) talkingTo = undefined;
          await refreshPeople();
          showPeople();
        },
      ],
      ['Назад', showPeople],
    ],
    { placeholder: 'Новое имя', value: p.name },
  );
}

async function startWizard(existing) {
  if (!mic.isOn()) await toggleMic();
  if (!mic.isOn()) return;
  interrupt({ end: true });
  const { needed } = await window.jarvis.enrollStart();
  // Каждая фраза начинается с имени: заодно запоминаем, как распознаватель слышит ваше «Орион».
  // Распознанный текст сверяется с фразой — фон, телевизор или чужая речь в образцы голоса не попадут.
  wizard = {
    stage: 'phrases',
    step: 0,
    needed,
    id: existing?.id,
    heard: [],
    phrases: [
      `${name}, какая сегодня погода и что у меня в планах?`,
      `${name}, включи, пожалуйста, какую-нибудь спокойную музыку.`,
      `${name}, напомни мне через десять минут проверить почту.`,
      `${name}, расскажи что-нибудь интересное про космос.`,
    ],
  };
  window.jarvis.setListening(true);
  promptPhrase();
  refreshState();
}

function promptPhrase(note = '') {
  const { step, needed, phrases, heard } = wizard;
  const done = heard.length ? `\n\nЗаписано: ${heard.map((h) => `«${h}» ✓`).join(' · ')}` : '';
  const tip = step ? '' : '\nГоворите так, как обычно обращаетесь ко мне, — с того места, где обычно сидите.';
  showPanel(`${note}Фраза ${step + 1} из ${needed}. Скажите обычным голосом:\n«${phrases[step]}»${tip}${done}`, [['Отмена', cancelWizard]]);
}

function promptName() {
  wizard.stage = 'name';
  speak('Как к вам обращаться?');
  showPanel(
    'Как к вам обращаться? Скажите имя или напишите его.',
    [
      ['Дальше', (value) => value?.trim() && promptHonorific(value.trim()), true],
      ['Отмена', cancelWizard],
    ],
    { placeholder: 'Имя', onEnter: (v) => v.trim() && promptHonorific(v.trim()) },
  );
}

function promptHonorific(personName) {
  wizard.stage = 'honorific';
  wizard.name = personName;
  speak(`Приятно познакомиться, ${personName}. Обращаться к вам «сэр» или «мисс»?`);
  showPanel(`${personName}, обращаться к вам «сэр» или «мисс»?`, [
    ['Сэр', () => finishWizard('сэр'), true],
    ['Мисс', () => finishWizard('мисс'), true],
    ['Отмена', cancelWizard],
  ]);
}

async function finishWizard(honorific) {
  window.jarvis.setListening(false);
  const person = await window.jarvis.enrollFinish({ name: wizard.name, honorific, id: wizard.id });
  wizard = null;
  await refreshPeople();
  if (person?.id) talkingTo = person.id;
  // Что получилось: порог узнавания, громкость голоса относительно шума, усиление микрофона
  const details = [];
  if (person?.threshold) details.push(`порог узнавания ${person.threshold}`);
  if (typeof person?.level === 'number' && typeof person?.noise === 'number') {
    details.push(`голос громче фона на ${Math.round(person.level - person.noise)} дБ`);
  }
  if (person?.gain) details.push(`усиление микрофона +${Math.round(person.gain)} дБ`);
  const similar = person?.similar
    ? `\n\nВаш голос очень похож на записанный голос «${person.similar.name || 'без имени'}». Если это тоже вы — удалите лишнюю запись в «Люди», иначе я буду вас путать.`
    : '';
  showPanel(
    `Готово, ${honorific} ${person?.name || ''}. Теперь я узнаю вас по голосу.`.replace(/\s+\./, '.') +
      (details.length ? `\n${details.join(', ')}.` : '') +
      similar,
    [['Отлично', hidePanel, true]],
  );
  speak(`Готово, ${honorific}. Теперь я узнаю вас по голосу.`);
  playChime();
  refreshState();
}

// Настройка отклика на имя: человек трижды говорит только имя
async function startWakeTuning() {
  if (!mic.isOn()) await toggleMic();
  if (!mic.isOn()) return;
  interrupt();
  wizard = { stage: 'wake', step: 0, needed: 3, log: [] };
  window.jarvis.setListening(true);
  promptWake();
  refreshState();
}

function promptWake(note = '') {
  const { step, needed, log: heardSoFar } = wizard;
  const heard = heardSoFar.length ? `\n\nУслышал: ${heardSoFar.join(' · ')}` : '';
  showPanel(`${note}Скажите «${name}» — только имя, обычным голосом (${step + 1} из ${needed}).${heard}`, [
    ['Готово', finishWakeTuning],
    ['Отмена', cancelWizard],
  ]);
}

function finishWakeTuning() {
  window.jarvis.setListening(false);
  const learned = wizard?.log.filter((x) => x.includes('запомнил')).length || 0;
  wizard = null;
  showPanel(learned ? `Готово: запомнил, как слышу ваше «${name}».` : `Ваше «${name}» я и так слышу хорошо.`, [
    ['Отлично', hidePanel, true],
  ]);
  refreshState();
}

// Во время мастера всё услышанное — это ответы мастеру
async function wizardHeard(text) {
  if (wizard.stage === 'wake') {
    const r = await window.jarvis.wakeLearn();
    if (!wizard) return;
    wizard.log.push(r.added.length ? `«${r.heard}» — запомнил` : r.recognized ? `«${r.heard}» — узнаю` : `«${r.heard}» — не похоже на имя`);
    wizard.step += 1;
    return wizard.step >= wizard.needed ? finishWakeTuning() : promptWake();
  }
  if (wizard.stage === 'phrases') {
    const r = await window.jarvis.enrollAdd(wizard.phrases[wizard.step]);
    if (!wizard) return;
    if (r.error) return promptPhrase(`${r.error}.\n\n`);
    wizard.heard.push(r.heard);
    wizard.step = r.count;
    return r.done ? promptName() : promptPhrase();
  }
  if (wizard.stage === 'name') {
    // «меня зовут Саша» → «Саша»
    const n = text
      .replace(/^(меня зовут|зови меня|называй меня|я)\s+/i, '')
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    return promptHonorific(n.charAt(0).toUpperCase() + n.slice(1));
  }
  if (wizard.stage === 'honorific') {
    if (/мисс|мэм|мадам|девуш|женщ/i.test(text)) return finishWizard('мисс');
    if (/сэр|сер|мужч|парен/i.test(text)) return finishWizard('сэр');
  }
}

function cancelWizard() {
  window.jarvis.setListening(false);
  wizard = null;
  window.jarvis.enrollCancel();
  hidePanel();
  refreshState();
}

peopleBtn.addEventListener('click', async () => {
  if (wizard) return cancelWizard();
  if (!panel.hidden) return hidePanel();
  await refreshPeople(); // свежая «последняя оценка»
  showPeople();
});
