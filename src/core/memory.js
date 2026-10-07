// Долгая память — база знаний о людях, раздельная по голосам (%APPDATA%\<app>\memory\people\<id>\).
//  • Профиль: имя и город — на них опираются навыки (погода по городу собеседника и т.п.).
//  • Факты: короткие утверждения с номерами. Добавляются, обновляются по номеру и удаляются;
//    у временных («завтра собеседование») есть срок жизни. В запрос попадают только относящиеся к делу.
// Разговоры здесь не хранятся: после диалога полезное переносится в факты (см. core/assistant/session.js),
// остальное забывается — маленькой модели вредит длинный контекст.
const fs = require('node:fs');
const path = require('node:path');

const MAX_FACTS = 200;
const FACTS_IN_PROMPT = 8;
const PROFILE_KEYS = { name: 'имя', city: 'город' };

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1)); // атомарно: сначала во временный файл
  fs.renameSync(tmp, file);
}

// Сравнение фраз по «основам» слов (первые 4 буквы) с допуском на одну опечатку:
// «стель» ≈ «стиль», «общение» ≈ «общения». Для пары сотен фактов этого хватает.
const stems = (text) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.slice(0, 4));

const close = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
  return diff <= 1;
};

function similarity(a, b) {
  const A = [...new Set(stems(a))];
  const B = [...new Set(stems(b))];
  if (!A.length || !B.length) return 0;
  const common = A.filter((x) => B.some((y) => close(x, y))).length;
  return common / Math.min(A.length, B.length);
}

// База знаний одного человека
function createPersonMemory(dir) {
  const profileFile = path.join(dir, 'profile.json');
  const factsFile = path.join(dir, 'facts.json');
  const profile = load(profileFile, {});
  let facts = load(factsFile, []);

  const prune = () => {
    const before = facts.length;
    facts = facts.filter((f) => !f.expires || f.expires > Date.now());
    if (facts.length !== before) save(factsFile, facts);
  };

  // arg: "city=Липецк" или "name=Саша"; пустое значение удаляет поле
  function setProfile(arg) {
    const m = String(arg).match(/^\s*(\w+)\s*=\s*(.*)$/);
    if (!m || !PROFILE_KEYS[m[1]]) {
      return { ok: false, message: `В профиле есть только поля: ${Object.keys(PROFILE_KEYS).join(', ')}.` };
    }
    const value = m[2].trim().slice(0, 100);
    if (value) profile[m[1]] = value;
    else delete profile[m[1]];
    save(profileFile, profile);
    return { ok: true };
  }

  // arg: "факт", "#3 новый текст" (обновить), "факт|7" (помнить 7 дней)
  function remember(arg) {
    prune();
    let text = String(arg).trim();
    let days = null;
    const ttl = text.match(/\|\s*(\d+)\s*$/);
    if (ttl) {
      days = Number(ttl[1]);
      text = text.slice(0, ttl.index).trim();
    }
    const replace = text.match(/^#(\d+)\s+/);
    if (replace) text = text.slice(replace[0].length).trim();
    if (!text) return { ok: false, message: 'Что именно запомнить?' };

    // Явное обновление по номеру или почти такой же факт — заменяем, а не копим дубликаты
    const target = replace ? facts.find((f) => f.id === Number(replace[1])) : facts.find((f) => similarity(f.text, text) >= 0.8);
    const now = Date.now();
    const expires = days ? now + days * 86_400_000 : undefined;
    if (target) {
      Object.assign(target, { text: text.slice(0, 300), updated: now, expires });
    } else {
      const id = facts.reduce((m, f) => Math.max(m, f.id), 0) + 1;
      facts.push({ id, text: text.slice(0, 300), created: now, updated: now, expires });
      if (facts.length > MAX_FACTS) facts.sort((a, b) => b.updated - a.updated).splice(MAX_FACTS);
    }
    save(factsFile, facts);
    return { ok: true };
  }

  // arg: "#3", описание факта или «всё»
  function forget(arg) {
    prune();
    const text = String(arg).trim();
    const byId = text.match(/^#?(\d+)$/);
    let removed;
    if (byId) removed = facts.filter((f) => f.id === Number(byId[1]));
    else if (/^(всё|все|all)$/i.test(text)) removed = facts;
    else {
      // Самый похожий факт, если он хоть сколько-то похож
      const best = facts.map((f) => ({ f, s: similarity(f.text, text) })).sort((a, b) => b.s - a.s)[0];
      removed = best && best.s >= 0.5 ? [best.f] : [];
    }
    if (!removed.length) return { ok: false, message: 'Не нашёл такого в памяти.' };
    facts = facts.filter((f) => !removed.includes(f));
    save(factsFile, facts);
    return { ok: true };
  }

  // Факты для запроса: похожие на вопрос, затем самые свежие — не больше FACTS_IN_PROMPT
  function relevantFacts(query) {
    prune();
    if (facts.length <= FACTS_IN_PROMPT) return facts;
    const ranked = facts.map((f) => ({ f, s: similarity(f.text, query) })).sort((a, b) => b.s - a.s || b.f.updated - a.f.updated);
    const chosen = new Set(
      ranked
        .filter((x) => x.s > 0)
        .slice(0, FACTS_IN_PROMPT - 3)
        .map((x) => x.f),
    );
    for (const f of [...facts].sort((a, b) => b.updated - a.updated)) {
      if (chosen.size >= FACTS_IN_PROMPT) break;
      chosen.add(f);
    }
    return [...chosen].sort((a, b) => a.id - b.id);
  }

  const format = (list) =>
    list.map((f) => `#${f.id} ${f.text}${f.expires ? ` (до ${new Date(f.expires).toLocaleDateString('ru-RU')})` : ''}`).join('\n');

  return {
    writable: true,
    profile: () => ({ ...profile }),
    profileText: () =>
      Object.entries(profile)
        .map(([k, v]) => `${PROFILE_KEYS[k] || k}: ${v}`)
        .join('; '),
    setProfile,
    remember,
    forget,
    factsText: (query) => format(relevantFacts(query)),
    allFactsText: () => (prune(), format(facts)),
    count: () => (prune(), facts.length),
  };
}

// Незнакомый голос: отвечаем, но ничего не запоминаем
const GUEST_MESSAGE = 'Я не узнал ваш голос, поэтому не запоминаю. Запишите голос кнопкой с человечком — и я буду помнить.';
const guestMemory = {
  writable: false,
  profile: () => ({}),
  profileText: () => '',
  setProfile: () => ({ ok: false, message: GUEST_MESSAGE }),
  remember: () => ({ ok: false, message: GUEST_MESSAGE }),
  forget: () => ({ ok: false, message: GUEST_MESSAGE }),
  factsText: () => '',
  allFactsText: () => '',
  count: () => 0,
};

// Общая память (memory\shared\) — одна на всех: где находится ассистент, дом, семья,
// факты не о конкретном человеке. Её видят все собеседники, включая гостя.
function createMemory({ dir }) {
  const cache = new Map();
  const shared = createPersonMemory(path.join(dir, 'shared'));
  const forPerson = (id) => {
    if (!id) return guestMemory;
    const safe = String(id).replace(/[^a-z0-9-]/gi, '');
    if (!cache.has(safe)) cache.set(safe, createPersonMemory(path.join(dir, 'people', safe)));
    return cache.get(safe);
  };

  // Переход со старого формата: общий профиль и факты → первому записанному человеку
  function adoptLegacy(personId) {
    const moved = [];
    for (const name of ['profile.json', 'facts.json']) {
      const from = path.join(dir, name);
      const to = path.join(dir, 'people', String(personId), name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        moved.push(name);
      }
    }
    try {
      fs.unlinkSync(path.join(dir, 'history.json')); // разговоры больше не храним
    } catch {}
    cache.delete(String(personId));
    return moved;
  }

  function removePerson(id) {
    cache.delete(String(id));
    fs.rmSync(path.join(dir, 'people', String(id).replace(/[^a-z0-9-]/gi, '')), { recursive: true, force: true });
  }

  return { forPerson, adoptLegacy, removePerson, shared, guest: guestMemory };
}

module.exports = { createMemory, similarity };
