// Будильник в окне: звенит (или включает радио), пока человек не выключит.
//   - громкость нарастает: сначала тихо, через минуту — в полную силу;
//   - выключить — кнопкой или голосом БЕЗ имени («стоп», «выключи», «встаю», «проснулся»): спросонья «Орион» никто
//     не скажет; «ещё 5 минут», «отложи», «дай поспать» — позвонит снова через столько минут (по умолчанию 10);
//   - сам смолкает через 15 минут, чтобы не звенеть весь день в пустой квартире.
/* global playChime */
/* exported createAlarm */
const ALARM_STOP =
  /^(стоп|хватит|выключи|выключай|отключи|встаю|встал|встала|проснулся|проснулась|я встал|я проснулся|все|всё|ладно|тихо)( будильник| его)?$/;
const ALARM_SNOOZE = /(ещ[её]|отложи|дай поспать|разбуди позже|попозже|через)/;
const RING_FOR_MS = 15 * 60_000;

function snoozeMinutes(text) {
  const words = { одну: 1, две: 2, три: 3, пять: 5, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, полчаса: 30 };
  const digits = String(text).match(/\d+/);
  if (digits) return Number(digits[0]);
  for (const [w, n] of Object.entries(words)) if (new RegExp(`(^|\\s)${w}(\\s|$)`).test(text)) return n;
  return 10;
}

function createAlarm({ radio, panel, label, snoozeButton, stopButton, onSnooze = () => {}, onChange = () => {} }) {
  let current = null; // { payload, timer, chime, started }

  function ring(msg) {
    stop({ silent: true });
    const payload = { id: msg.id, label: msg.label, radio: msg.radio };
    current = { payload, started: Date.now() };
    label.textContent = `⏰ ${msg.label}`;
    panel.hidden = false;
    if (msg.station?.url) {
      // Радио с нарастанием громкости
      radio.setVolume(0.15);
      radio.play(msg.station);
      current.chime = setInterval(() => radio.setVolume(Math.min(0.9, 0.15 + ((Date.now() - current.started) / 60_000) * 0.75)), 2000);
    } else {
      // Сигнал: каждые 1,5 с, громче с каждой минутой
      const beep = () => playChime('alarm', Math.min(1, 0.25 + (Date.now() - current.started) / 60_000));
      beep();
      current.chime = setInterval(beep, 1500);
    }
    current.timer = setTimeout(() => stop(), RING_FOR_MS);
    onChange(true);
  }

  function stop({ silent = false } = {}) {
    if (!current) return false;
    clearInterval(current.chime);
    clearTimeout(current.timer);
    if (current.payload.radio) radio.stop();
    current = null;
    panel.hidden = true;
    if (!silent) onChange(false);
    return true;
  }

  function snooze(minutes = 10) {
    if (!current) return false;
    const payload = current.payload;
    stop();
    onSnooze(payload, minutes);
    return true;
  }

  // Фраза, пока звенит: выключить или отложить → true (фраза — для будильника, дальше её не разбирать)
  function heard(text) {
    if (!current) return false;
    const t = String(text)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/^орион\s+/, '')
      .trim();
    if (ALARM_SNOOZE.test(t)) return snooze(snoozeMinutes(t));
    if (ALARM_STOP.test(t) || /выключи будильник|отключи будильник/.test(t)) return stop();
    return false;
  }

  stopButton.addEventListener('click', () => stop());
  snoozeButton.addEventListener('click', () => snooze(10));

  return { ring, stop, snooze, heard, ringing: () => !!current };
}

if (typeof module !== 'undefined') module.exports = { createAlarm, snoozeMinutes, ALARM_STOP, ALARM_SNOOZE };
