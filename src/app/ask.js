// Запрос из окна: фраза → ассистент → ответ. Новый запрос обрывает недоделанный старый.
const SOURCES = ['text', 'wake', 'hotkey', 'followup', 'followup-voice']; // followup-voice — продолжение, голос подтверждён
const MAX_TEXT = 1000;

// Понятное объяснение сбоя модели — его скажут вслух
function explainError(err, config) {
  const msg = String(err?.cause?.code || err?.message || err);
  if (err?.code === 'NO_MODEL') return 'Языковая модель ещё не скачана. Перезапустите меня — докачаю.';
  if (/llama.cpp не запустился|долго загружает/i.test(msg)) return 'Языковая модель не запустилась. Подробности — в журнале.';
  if (config.backend === 'ollama' && /ECONNREFUSED|fetch failed/i.test(msg)) {
    return 'Не могу связаться с Ollama. Он запущен? Или выберите в настройках встроенный движок.';
  }
  if (/not found/i.test(msg)) return `Модель ${config.model} не найдена. Выполните: ollama pull ${config.model}`;
  if (/timeout|aborted/i.test(msg)) return 'Модель слишком долго отвечает.';
  return `Сбой: ${msg}`;
}

// Подпись реплики в чате — только по настоящей проверке голоса: имя, «Гость» (голос чужой);
// без проверки (текст, короткая фраза) — null, окно оставит «Вы»
function speakerLabel(personId, person) {
  if (typeof personId === 'string' && person) return person.name || 'Без имени';
  return personId === null ? 'Гость' : null;
}

function createAsk({ config, services, voice, ui, ipc }) {
  const { assistant, audit, llm } = services;
  let current = null; // { controller, done } — запрос в работе

  // Оборвать запрос в работе и дождаться, пока он освободит ядро
  async function cancel() {
    if (!current) return;
    const { controller, done } = current;
    controller.abort();
    llm.abortAll();
    audit({ ask: 'отменён' });
    await done;
  }

  // streamId — номер запроса в окне: по нему окно узнаёт предложения ответа, пришедшие раньше самого ответа
  async function ask(text, source, personId, streamId) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
      return { say: 'Пустой или слишком длинный запрос.', error: true };
    }
    // Новый запрос, пока старый ещё думает (человек договорил фразу или перебил) — старый обрываем:
    // модель бросает генерацию, а его ответ окну уже не нужен. Без запроса в работе — без await: ядро
    // занимается синхронно, иначе два запроса подряд разминулись бы и второй не оборвал бы первый
    if (current) await cancel();
    const controller = new AbortController();
    const me = { controller };
    me.done = new Promise((r) => (me.finished = r));
    current = me;
    const person = await voice.resolvePerson(personId);
    if (controller.signal.aborted) return finish(me, { cancelled: true }); // перебили, пока узнавали собеседника
    const src = SOURCES.includes(source) ? source : 'text';
    audit({ ask: text.trim(), source, person: person?.id ?? null });
    try {
      const stream = Number.isInteger(streamId);
      const result = await assistant.handle(text.trim(), {
        source: src,
        person,
        signal: controller.signal,
        onSay: stream ? (part) => ui.send('jarvis:say-part', { id: streamId, text: part }) : undefined,
        onFiller: stream ? (part) => ui.send('jarvis:filler', { id: streamId, text: part }) : undefined,
        beforeActions: src !== 'text' ? () => voice.untilQuiet(controller.signal) : undefined,
      });
      if (result.cancelled || controller.signal.aborted) return { cancelled: true };
      if (!result.ignored) await voice.setPartner(person?.id ?? null);
      return { ...result, person: person?.id ?? null, speakerLabel: speakerLabel(personId, person) }; // окно запомнит, с кем идёт разговор
    } catch (err) {
      if (controller.signal.aborted) return { cancelled: true };
      audit({ error: String(err?.message || err) });
      return { say: explainError(err, config), error: true };
    } finally {
      finish(me);
    }
  }

  // Запрос освободил ядро: следующий может начаться
  function finish(me, result) {
    if (current === me) current = null;
    me.finished();
    return result;
  }

  ipc.handle('jarvis:ask', ask);
  ipc.on('jarvis:cancel', () => cancel());
  return { ask, cancel };
}

module.exports = { createAsk, explainError, speakerLabel };
