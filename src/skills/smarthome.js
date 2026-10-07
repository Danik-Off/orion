// Умный дом через Home Assistant (локальный REST API): свет, розетки, шторы, сцены и датчики.
// Подключается, только если в config.json указан homeAssistant: { "url": "http://homeassistant.local:8123", "token": "..." }.
// Токен — «Долгосрочный токен доступа» из профиля пользователя Home Assistant.
const { score } = require('../lib/app-catalog');

const CONTROLLED = new Set(['light', 'switch', 'fan', 'cover', 'scene', 'script', 'media_player', 'input_boolean', 'climate']);
let cache = { at: 0, states: [] };

function api(ctx, pathname, body) {
  const { url, token } = ctx.config.homeAssistant;
  return fetch(new URL(pathname, url), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Home Assistant: HTTP ${res.status}`);
    return res.json();
  });
}

async function states(ctx) {
  if (Date.now() - cache.at > 60_000) cache = { at: Date.now(), states: await api(ctx, '/api/states') };
  return cache.states;
}

// Устройство по названию, как его назвали голосом («свет в спальне»)
async function findEntity(ctx, query, domains) {
  let best = null;
  for (const s of await states(ctx)) {
    const domain = s.entity_id.split('.')[0];
    if (domains && !domains.has(domain)) continue;
    const name = s.attributes?.friendly_name || s.entity_id;
    const v = Math.max(score(query, name), score(query, s.entity_id.split('.')[1].replace(/_/g, ' ')) * 0.9);
    if (v > 0 && (!best || v > best.v)) best = { v, s, domain, name };
  }
  return best;
}

const ACTIONS = {
  on: { cover: 'open_cover', default: 'turn_on', word: 'включил' },
  off: { cover: 'close_cover', default: 'turn_off', word: 'выключил' },
  toggle: { cover: 'toggle', default: 'toggle', word: 'переключил' },
};

// arg: "on|свет в спальне" | "off|..." | "toggle|..." | "state|температура в гостиной"
async function home(arg, ctx) {
  const [verb, ...rest] = String(arg).split('|');
  const query = rest.join('|').trim();
  const v = verb.trim().toLowerCase();
  if (!query) return { ok: false, message: 'Какое устройство, сэр?' };
  if (v === 'state') {
    const found = await findEntity(ctx, query);
    if (!found) return { ok: false, message: `Не нашёл «${query}» в умном доме, сэр.` };
    const unit = found.s.attributes?.unit_of_measurement || '';
    const state =
      { on: 'включено', off: 'выключено', open: 'открыто', closed: 'закрыто', unavailable: 'недоступно' }[found.s.state] || found.s.state;
    return { ok: true, speak: `${found.name}: ${state}${unit ? ` ${unit}` : ''}.` };
  }
  const action = ACTIONS[v];
  if (!action) return { ok: false, message: 'Не понял, что сделать с устройством, сэр.' };
  const found = await findEntity(ctx, query, CONTROLLED);
  if (!found) return { ok: false, message: `Не нашёл «${query}» в умном доме, сэр.` };
  const service = ['scene', 'script'].includes(found.domain) ? 'turn_on' : action[found.domain] || action.default;
  await api(ctx, `/api/services/${found.domain}/${service}`, { entity_id: found.s.entity_id });
  cache.at = 0;
  return { ok: true, speak: `${found.name}: ${action.word}.` };
}

module.exports = {
  id: 'smarthome',
  needs: [],
  title: 'умный дом (Home Assistant): свет, розетки, шторы, сцены, датчики температуры',
  keywords: [
    'свет',
    'ламп',
    'розетк',
    'штор',
    'жалюз',
    'кондиц',
    'обогрев',
    'умный дом',
    'датчик',
    'температура в',
    'влажност',
    'сцен',
    'люстр',
  ],
  available: (config) => Boolean(config.homeAssistant?.url && config.homeAssistant?.token),
  tools: [
    {
      name: 'home',
      use: 'управлять устройством умного дома или узнать его состояние',
      arg: '"on|устройство" | "off|устройство" | "toggle|устройство" | "state|устройство или датчик"',
      examples: [['выключи свет в спальне', { addressed: true, say: '', actions: [{ tool: 'home', arg: 'off|свет в спальне' }] }]],
      run: home,
    },
  ],
};
