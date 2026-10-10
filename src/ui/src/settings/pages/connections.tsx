// Подключения MCP: магазин серверов (ставятся одной кнопкой и подключаются сразу), установленные — с состоянием,
// инструментами и кнопками, свой сервер и импорт готового JSON. Сторонний сервер — чужая программа: действия
// с последствиями выполняются только с разрешения (если не включено «без вопросов»).
// Состояние приходит от ядра само (onMcpChanged): «подключается…» → «готов» без перезагрузки страницы.
import { useEffect, useState } from 'react';
import type { Ctx, Page } from '../rows.ts';
import { Line, Section, useActions } from '../Row.tsx';
import { Button, TextField, Toggle } from '../../kit/controls.tsx';

interface Tool {
  name: string;
  title: string;
  description?: string;
  readOnly?: boolean;
  enabled: boolean;
}
interface Server {
  name: string;
  title: string;
  target: string;
  catalog?: string;
  package?: boolean;
  trust: boolean;
  enabled: boolean;
  status?: { state: 'ready' | 'error' | 'connecting' | 'sleeping'; error?: string; ms?: number; tools: Tool[] } | null;
}
interface CatalogItem {
  id: string;
  title: string;
  description: string;
  category: string;
  runtime: 'node' | 'python' | 'remote';
  inputs?: { key: string; label: string; placeholder?: string; secret?: boolean; link?: string }[];
}
interface Data {
  servers: Server[];
  catalog: CatalogItem[];
  node: boolean;
  uv: boolean;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const toolsWord = (n: number) => `${n} ${plural(n, 'инструмент', 'инструмента', 'инструментов')}`;

// Состояние сервера одной строкой и цвет точки
function statusOf(s: Server): { text: string; dot: string } {
  if (!s.enabled) return { text: 'выключен', dot: 'off' };
  const st = s.status;
  if (!st) return { text: 'подключается…', dot: 'busy' };
  const n = st.tools.filter((t) => t.enabled).length;
  if (st.state === 'error') return { text: `ошибка: ${st.error}`, dot: 'error' };
  if (st.state === 'connecting') return { text: 'подключается…', dot: 'busy' };
  if (st.state === 'ready') return { text: `готов · ${toolsWord(n)}${st.ms ? ` · ${st.ms} мс` : ''}`, dot: 'ok' };
  return { text: `${toolsWord(n)} · запустится, когда понадобится`, dot: 'idle' };
}

function Connections({ ctx }: { ctx: Ctx }) {
  const { api } = ctx;
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { act, button, error } = useActions<Data>((r) => r && 'servers' in r && setData(r));
  const value = (k: string) => values[k] || '';
  const setValue = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const off = api.onMcpChanged?.((r) => setData(r));
    void api.mcpList().then(setData);
    return () => off?.();
  }, [api]);
  if (!data) return null;

  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) =>
    !q ||
    texts.some((t) =>
      String(t || '')
        .toLowerCase()
        .includes(q),
    );
  const servers = data.servers.filter((s) => matches(s.title, s.name, s.target, ...(s.status?.tools || []).map((t) => t.title)));
  const have = new Set(data.servers.map((s) => s.catalog || s.name));
  const byCategory = new Map<string, CatalogItem[]>();
  for (const c of data.catalog) {
    if (!matches(c.title, c.description, c.category, c.id)) continue;
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }

  return (
    <>
      <div className="mcp-head">
        <TextField
          type="search"
          value={query}
          placeholder="Найти подключение: поиск, GitHub, заметки…"
          aria-label="Поиск подключений"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!data.node && (
        <Section title="Перед установкой">
          <Line label="Нужен Node.js" hint="Серверы с пометкой «Нужен Node.js» работают через него. Удалённые — и без него.">
            <Button onClick={() => void api.openLink('https://nodejs.org')}>Скачать Node.js</Button>
          </Line>
        </Section>
      )}
      {servers.length > 0 && (
        <Section title="Установлено" note="Серверы запускаются, только когда нужны, и засыпают без дела.">
          {servers.map((s) => {
            const st = statusOf(s);
            const tools = s.status?.tools || [];
            const err = error(s.name, `check:${s.name}`, `update:${s.name}`, `remove:${s.name}`);
            return (
              <div key={s.name}>
                <Line label={s.title} dot={st.dot} hint={err || st.text} warn={!!err || st.dot === 'error'} mono={s.target} wide>
                  <small className="row-hint">вкл</small>
                  <Toggle
                    checked={s.enabled}
                    label={`Включить ${s.title}`}
                    onChange={(on) => void act(s.name, '…', () => api.mcpEnable(s.name, on))}
                  />
                  <small className="row-hint">без вопросов</small>
                  <Toggle
                    checked={s.trust}
                    label={`Выполнять действия ${s.title} без вопроса`}
                    onChange={(on) => void act(s.name, '…', () => api.mcpTrust(s.name, on))}
                  />
                  {tools.length > 0 && (
                    <Button onClick={() => setOpen((o) => ({ ...o, [s.name]: !o[s.name] }))}>
                      {open[s.name] ? 'Скрыть' : 'Инструменты'} ({tools.length})
                    </Button>
                  )}
                  {s.enabled && button(`check:${s.name}`, 'Проверить', 'Проверяю…', () => api.mcpCheck(s.name))}
                  {s.package && button(`update:${s.name}`, 'Обновить', 'Обновляю…', () => api.mcpUpdate(s.name))}
                  {button(`remove:${s.name}`, 'Удалить', 'Удаляю…', () => api.mcpRemove(s.name))}
                </Line>
                {open[s.name] && (
                  <div className="mcp-tools">
                    {tools.map((t) => (
                      <label key={t.name} className="mcp-tool">
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          onChange={(e) => void act(s.name, '…', () => api.mcpTool(s.name, t.name, e.target.checked))}
                        />
                        <span>
                          <span className="row-label">{t.title}</span>
                          {t.readOnly && <span className="tag">только чтение</span>}
                          {t.description && <span className="row-hint">{t.description}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}
      {[...byCategory].map(([category, items]) => (
        <Section key={category} title={`Каталог · ${category}`}>
          {items.map((c) => {
            const needs =
              c.runtime === 'node' ? (data.node ? '' : ' Нужен Node.js.') : c.runtime === 'python' ? (data.uv ? '' : ' Нужен uv.') : '';
            const where = c.runtime === 'remote' ? ' Работает по интернету.' : '';
            const err = error(c.id);
            return (
              <Line
                key={c.id}
                label={c.title}
                hint={err || `${c.description}${where}${needs}`}
                warn={!!err}
                wide={(c.inputs || []).length > 0}
              >
                {have.has(c.id) ? (
                  <span className="status-ok">установлено</span>
                ) : (
                  <>
                    {(c.inputs || []).map((f) => (
                      <span key={f.key} className="mcp-input">
                        <TextField
                          type={f.secret ? 'password' : 'text'}
                          autoComplete="off"
                          placeholder={f.placeholder || f.label}
                          aria-label={f.label}
                          value={value(`${c.id}.${f.key}`)}
                          onChange={(e) => setValue(`${c.id}.${f.key}`, e.target.value)}
                        />
                        {f.link && (
                          <button type="button" className="link" onClick={() => void api.openLink(f.link!)}>
                            {f.secret ? 'где взять ключ' : 'подробнее'}
                          </button>
                        )}
                      </span>
                    ))}
                    {button(
                      c.id,
                      'Установить',
                      c.runtime === 'node' ? 'Скачиваю…' : 'Подключаю…',
                      () =>
                        api.mcpInstall(c.id, Object.fromEntries((c.inputs || []).map((f) => [f.key, value(`${c.id}.${f.key}`).trim()]))),
                      true,
                    )}
                  </>
                )}
              </Line>
            );
          })}
        </Section>
      ))}
      {!q && (
        <Section title="Свой сервер">
          <Line
            label="Команда или адрес"
            hint={error('custom') || 'Пакет npm поставлю к себе — будет запускаться быстро и без интернета.'}
            warn={!!error('custom')}
            wide
          >
            <TextField
              placeholder="Название, например «Мой сервер»"
              aria-label="Название сервера"
              value={value('custom.name')}
              onChange={(e) => setValue('custom.name', e.target.value)}
            />
            <TextField
              placeholder="npx -y пакет …  или  https://…/mcp"
              aria-label="Команда или адрес сервера"
              value={value('custom.target')}
              onChange={(e) => setValue('custom.target', e.target.value)}
            />
            {button('custom', 'Добавить', 'Добавляю…', () => api.mcpAdd(value('custom.name'), value('custom.target')))}
          </Line>
          <Line
            label="Готовые настройки (JSON)"
            hint={
              error('import') || 'Блок из описания сервера — как для Claude Desktop, Cursor или VS Code. Можно несколько серверов сразу.'
            }
            warn={!!error('import')}
            wide
          >
            <textarea
              className="field mcp-json"
              rows={4}
              spellCheck={false}
              aria-label="Настройки сервера в JSON"
              placeholder='{ "mcpServers": { "имя": { "command": "npx", "args": ["-y", "пакет"] } } }'
              value={value('custom.json')}
              onChange={(e) => setValue('custom.json', e.target.value)}
            />
            {button('import', 'Импортировать', 'Импортирую…', async () => {
              const r = await api.mcpImport(value('custom.json'));
              if (r?.ok) setValue('custom.json', '');
              return r;
            })}
          </Line>
        </Section>
      )}
      {q && servers.length === 0 && byCategory.size === 0 && (
        <p className="empty">Ничего не нашлось. Свой сервер можно добавить ниже — очистите поиск.</p>
      )}
    </>
  );
}

export const connections: Page = {
  id: 'connections',
  group: 'brain',
  title: 'Подключения',
  icon: 'connections',
  description: 'Новые умения из MCP-серверов: ставятся одной кнопкой и сразу доступны голосом.',
  keywords: 'mcp сервер каталог магазин установить плагин расширение json импорт',
  Render: Connections,
};
