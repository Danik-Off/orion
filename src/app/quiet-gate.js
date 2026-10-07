// Человек сейчас говорит (идут промежуточные результаты распознавания). Действия голосовой команды ждут конца
// его фразы: если это продолжение («напомни… через десять» — пауза — «секунд»), окно заменит запрос
// договорённым, и действия по обрывку не выполнятся. После конца фразы — ещё graceMs на решение окна.
function createQuietGate({ graceMs = 250, maxWaitMs = 6000 } = {}) {
  let talking = false;
  let waiters = [];

  function setTalking(value) {
    talking = value;
    if (value) return;
    const ready = waiters;
    waiters = [];
    ready.forEach((w) => w());
  }

  // Дождаться тишины (не дольше maxWaitMs: рядом говорят без конца — телевизор); signal — отмена запроса
  function untilQuiet(signal) {
    if (!talking) return Promise.resolve();
    return new Promise((resolve) => {
      const giveUp = setTimeout(finish, maxWaitMs);
      let grace = null;
      function finish() {
        clearTimeout(giveUp);
        clearTimeout(grace);
        resolve();
      }
      const onQuiet = () => {
        grace = setTimeout(() => (talking ? waiters.push(onQuiet) : finish()), graceMs);
      };
      waiters.push(onQuiet);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  return { setTalking, untilQuiet, isTalking: () => talking };
}

module.exports = { createQuietGate };
