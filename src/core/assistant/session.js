// Разговор: живёт ровно один диалог (маленькая модель путается на длинном). В запрос идут только его реплики.
// Диалог заканчивается, когда окно закрыло приём продолжения (голос), после 2 минут тишины (переписка),
// при смене собеседника или по ↺. Тогда полезное переносится в базу знаний собеседника, остальное забывается.
const { similarity } = require('../memory');

const SESSION_TURNS = 6; // реплик текущего разговора в запросе
const SESSION_IDLE_MS = 2 * 60 * 1000; // тишина, после которой разговор считается законченным
const RECENT_SKILLS = 3; // навыки последних реплик остаются «под рукой» («а завтра?» после погоды)

const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['person', 'shared'] },
          text: { type: 'string' },
          replaces: { type: 'integer' }, // номер устаревшего факта на ту же тему
          days: { type: 'integer' }, // для планов: сколько дней помнить
        },
        required: ['scope', 'text'],
      },
    },
  },
  required: ['facts'],
};

const known = (mem) => [mem.profileText(), mem.allFactsText()].filter(Boolean).join('\n') || '(ничего)';
const factText = (mem, id) => mem.allFactsText().match(new RegExp(`^#${Number(id)} (.+?)(?: \\(до .+\\))?$`, 'm'))?.[1];

// onEnd(reason) — разговор закончился: окно стирает его реплики (ассистент — «золотая рыбка»:
// помнит только то, что перенесено в базу знаний)
function createSession({ config, llm, memory, audit, onEnd = () => {} }) {
  let state = { personId: undefined, turns: [], recent: [], timer: null };

  function touch() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => end('тишина'), SESSION_IDLE_MS);
    state.timer.unref?.();
  }

  // Реплика разговора: в историю — ответ в том же виде, в каком его пишет модель: с темой и действиями
  // (чтобы «закрой его» знало, что было открыто) и с цифрами, а не словами (иначе модель подражает озвучке)
  function add({ text, topic, actions, say, used }) {
    state.recent = [...new Set([...used, ...state.recent])].slice(0, RECENT_SKILLS);
    state.turns.push({ role: 'user', content: text }, { role: 'assistant', content: JSON.stringify({ topic, actions, say }) });
    state.turns = state.turns.slice(-SESSION_TURNS * 2);
    touch();
  }

  // Другой голос обратился к ассистенту — прошлый разговор закрывается и переносится в память
  async function switchTo(personId) {
    if (state.turns.length && personId !== state.personId) await end('смена собеседника');
    state.personId = personId;
  }

  // Конец разговора: факты о собеседнике — в его базу знаний, общие — в общую; реплики забываем.
  // С гостем (голос не узнан) сохраняется только общее.
  async function end(reason) {
    clearTimeout(state.timer);
    const { personId, turns } = state;
    state = { personId: undefined, turns: [], recent: [], timer: null };
    onEnd(reason);
    if (turns.length < 2) return;
    const mem = memory.forPerson(personId);
    try {
      const saved = save(await extractFacts(turns, mem), mem);
      audit({ memory: 'итог разговора', reason, person: personId, saved });
    } catch (err) {
      audit({ memory: 'итог не удался', error: String(err?.message || err) });
    }
  }

  // Защита от ошибок маленькой модели: итог только ДОБАВЛЯЕТ факты (удаляет — лишь явное «забудь»),
  // обрывки и имя не записываются, повтор уже известного не плодится (remember сам заменит похожий)
  function save(facts, mem) {
    const saved = [];
    for (const f of facts) {
      const text = String(f.text || '').trim();
      if (text.length < 8 || text.split(/\s+/).length < 2 || /^(имя|зовут|пользователя зовут)/i.test(text)) continue;
      const target = f.scope === 'shared' ? memory.shared : mem;
      if (!target.writable) continue;
      if (similarity(`${target.allFactsText()} ${target.profileText()}`, text) >= 0.65) continue; // уже известно другими словами
      // Замена старого факта — только если он на ту же тему («Живёт в Москве» → «Живёт в Казани»)
      const replaced = f.replaces && factText(target, f.replaces);
      const sameTopic = replaced && similarity(replaced, text) >= 0.3;
      const ttl = f.days > 0 && f.days <= 60 ? `|${f.days}` : ''; // срок — только для ближайших планов
      target.remember(`${sameTopic ? `#${f.replaces} ` : ''}${text}${ttl}`);
      saved.push({ scope: f.scope, text, replaced: sameTopic ? replaced : undefined });
    }
    return saved;
  }

  async function extractFacts(turns, mem) {
    const dialog = turns
      .filter((t) => t.role === 'user') // факты берём из слов человека, а не из ответов ассистента
      .map((t) => `— ${t.content}`)
      .join('\n');
    const raw = await llm.chat(
      [
        {
          role: 'system',
          content:
            'Ты — модуль долгой памяти голосового ассистента. Перед тобой реплики человека из одного разговора. ' +
            'Выпиши НОВЫЕ устойчивые факты, которые стоит помнить неделями:\n' +
            '• scope=person — о самом человеке: где живёт, семья и близкие, работа, увлечения, вкусы, привычки, планы с датами;\n' +
            '• scope=shared — не о конкретном человеке: где находится ассистент, дом, питомцы, соседи, общие договорённости.\n' +
            'Не записывай: имя, просьбы и команды («включи…», «какая погода»), вопросы, шутки, эмоции, то, что уже известно.\n' +
            'Каждый факт — короткое полное утверждение от третьего лица. Если факт обновляет известный на ту же тему — укажи replaces.\n' +
            'Планы на дату — с days. Ничего подходящего — пустой список.\n\n' +
            'Примеры:\n' +
            '«я работаю дизайнером, включи музыку» → [{"scope":"person","text":"Работает дизайнером"}]\n' +
            '«завтра с женой едем на дачу, кота кормит соседка Лена» → [{"scope":"person","text":"Женат","days":0},' +
            '{"scope":"person","text":"Завтра едет с женой на дачу","days":2},{"scope":"shared","text":"Кота кормит соседка Лена"}]\n' +
            '«какая погода», «спасибо», «расскажи анекдот» → []\n' +
            '«я переехал в Казань» при известном «#2 Живёт в Москве» → [{"scope":"person","text":"Живёт в Казани","replaces":2}]\n\n' +
            `Уже известно о человеке:\n${known(mem)}\n` +
            `Уже известно общее:\n${known(memory.shared)}`,
        },
        { role: 'user', content: dialog },
      ],
      FACTS_SCHEMA,
      { temperature: config.planTemperature ?? 0.1 }, // факты — не творчество
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : [];
  }

  return {
    add,
    switchTo,
    end,
    history: () => state.turns,
    recent: () => state.recent,
  };
}

module.exports = { createSession, SESSION_TURNS };
