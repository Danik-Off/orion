// Установка: первый запуск (голос, слух, быстрые команды), затем предложение «стать умнее» — большая модель,
// и докачка любых частей позже — из настроек.
const { install, missing, estimate, formatBytes, brainReady, FIRST_RUN, ALL_STAGES, PART_TITLES } = require('../core/setup');

function createSetupFlow({ config, modelsDir, services, ui, voice, ipc }) {
  const { audit, llama, assistant } = services;
  let answerOffer = null;
  let answerBrain = null;
  let busy = null; // идущая установка — вторую параллельно не начинаем

  // Прежде чем качать — показать, что и сколько весит, и дождаться согласия.
  // «Позже» только прячет вопрос: окно может задать его снова, ответ по-прежнему ждётся здесь.
  async function offer() {
    const plan = await estimate(config, modelsDir, FIRST_RUN);
    audit({ setup: 'предложение', total: plan.total });
    ui.send('jarvis:setup-offer', {
      parts: plan.parts.map((p) => ({ title: p.title, size: formatBytes(p.bytes) })),
      total: formatBytes(plan.total),
      ollama: true,
    });
    return new Promise((resolve) => (answerOffer = resolve));
  }

  // Поставить этапы stages с прогрессом в окне; модули подключаются по мере готовности
  function installStages(stages) {
    busy ??= (async () => {
      audit({ setup: 'начало', stages, models: missing(config, modelsDir, stages).map((i) => i.name) });
      await install({
        config,
        modelsDir,
        stages,
        report: (r) => ui.send('jarvis:setup', r),
        onStageDone: async (stage, changed) => {
          if (changed && (stage === 'voice' || stage === 'hearing')) {
            await voice.ready;
            voice.reload(); // подключить только что скачанное
          }
          if (changed && stage === 'brain') {
            if (config.backend === 'llamacpp') await llama.restart().catch(() => {}); // модель только что скачана
            assistant.warmup();
          }
          ui.send('jarvis:setup', { stage, done: true, ready: stage });
        },
      }).catch((err) => {
        audit({ setup: 'ошибка', error: String(err?.message || err) });
        ui.send('jarvis:setup', { error: true, title: `Установка прервалась: ${err.message}. Перезапустите меня — докачаю.` });
      });
      ui.send('jarvis:setup', { finished: true, stages });
      audit({ setup: 'готово', stages });
    })().finally(() => (busy = null));
    return busy;
  }

  // Первый запуск. Ответ: true — всё на месте (или установилось), false — пользователь отказался
  async function run() {
    if (missing(config, modelsDir, FIRST_RUN).length) {
      if (!(await offer())) {
        audit({ setup: 'отказ' });
        return false;
      }
      await installStages(FIRST_RUN);
    }
    return true;
  }

  // «Я могу стать умнее»: большой модели нет — предложить докачать Qwen или подключить внешнюю.
  // Спрашивается после установки (и при запуске, пока не ответили «не предлагать»); в настройках — всегда
  async function offerBrain() {
    if (config.brainOffer === false || config.escalate === false || (await brainReady(config, modelsDir))) return;
    const local = { ...config, backend: 'llamacpp' };
    const plan = await estimate(local, modelsDir, ['brain']);
    audit({ brain: 'предложение', total: plan.total });
    ui.send('jarvis:brain-offer', { size: formatBytes(plan.total) });
    const answer = await new Promise((resolve) => (answerBrain = resolve));
    audit({ brain: 'ответ', answer });
    if (answer === 'never') services.ctx.saveSettings({ brainOffer: false });
    if (answer === 'download') await installBrain();
  }

  // Большая модель на этом компьютере: выбрать встроенный движок и скачать Qwen
  async function installBrain() {
    if (config.backend !== 'llamacpp' || config.escalate === false) services.ctx.saveSettings({ backend: 'llamacpp', escalate: true });
    await installStages(['brain']);
  }

  // Части для настроек: что установлено и сколько весит недостающее
  async function components() {
    const local = { ...config, backend: 'llamacpp' }; // «Большая модель» в списке частей — Qwen на этом компьютере
    const stages = await Promise.all(
      ALL_STAGES.map(async (stage) => {
        const cfg = stage === 'brain' ? local : config;
        const todo = missing(cfg, modelsDir, [stage]);
        const bytes = todo.length ? (await estimate(cfg, modelsDir, [stage])).total : 0;
        return { stage, title: PART_TITLES[stage], installed: todo.length === 0, size: todo.length ? formatBytes(bytes) : '' };
      }),
    );
    return { stages, installing: !!busy, brainReady: await brainReady(config, modelsDir) };
  }

  ipc.on('jarvis:setup-answer', (ok) => {
    answerOffer?.(ok === true);
    answerOffer = null;
  });
  ipc.on('jarvis:brain-answer', (answer) => {
    answerBrain?.(['download', 'connect', 'later', 'never'].includes(answer) ? answer : 'later');
    answerBrain = null;
  });
  ipc.handle('jarvis:components', components);
  // Докачать части из настроек: stage — 'voice' | 'hearing' | 'router' | 'brain'
  ipc.handle('jarvis:install-component', async (stage) => {
    if (!ALL_STAGES.includes(stage)) return { ok: false };
    if (busy) return { ok: false, error: 'Уже идёт установка' };
    if (stage === 'brain') installBrain();
    else installStages([stage]);
    return { ok: true };
  });

  return { run, offerBrain };
}

module.exports = { createSetupFlow };
