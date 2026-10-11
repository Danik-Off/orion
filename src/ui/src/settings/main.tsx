// Окно настроек: боковая панель разделов с поиском и страница выбранного раздела.
// Раздел открывается по адресу #id (окно разговора открывает, например, #models); поиск ищет по всем строкам.
import { StrictMode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../kit/kit.css';
import './settings.css';
import { api } from '../bridge.ts';
import { createStore } from './store.ts';
import type { Ctx, Page } from './rows.ts';
import { rowsOf, searchText } from './rows.ts';
import { RowView, SectionView } from './Row.tsx';
import { about, advanced, general, hearing, models, skills, voice } from './pages/basic.tsx';
import { components } from './pages/components.tsx';
import { library } from './pages/library.tsx';
import { connections } from './pages/connections.tsx';
import { help } from './pages/help.tsx';
import { Sphere } from '../kit/Sphere.tsx';
import { Icon, type IconName } from '../kit/Icon.tsx';
import { Button } from '../kit/controls.tsx';
import { ErrorBoundary } from '../kit/ErrorBoundary.tsx';

const GROUPS = [
  { id: 'assistant', title: 'Ассистент' },
  { id: 'brain', title: 'Интеллект' },
  { id: 'system', title: 'Система' },
] as const;
const PAGES: Page[] = [help, general, voice, hearing, models, library, connections, skills, advanced, components, about];

// Совпадение — по началу слов: «ключ» находит «Ключ API», но не «вклЮЧать»
const wordsOf = (text: string) =>
  String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const matcher = (query: string) => {
  const want = wordsOf(query);
  if (!want.length) return null; // одни знаки препинания — это не поиск
  return (text: string) => {
    const have = wordsOf(text);
    return want.every((w) => have.some((h) => h.startsWith(w)));
  };
};

const pageFromHash = () => PAGES.find((p) => p.id === location.hash.slice(1))?.id || 'general';

function App({ ctx }: { ctx: Ctx }) {
  const s = useSyncExternalStore(ctx.store.subscribe, ctx.store.getState);
  const [pageId, setPageId] = useState(pageFromHash);
  const [query, setQuery] = useState('');
  const [updates, setUpdates] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLElement>(null);

  const open = (id: string) => {
    setQuery('');
    setPageId(PAGES.some((p) => p.id === id) ? id : 'general');
  };
  useEffect(() => {
    if (location.hash !== `#${pageId}`) history.replaceState(null, '', `#${pageId}`);
    content.current?.scrollTo(0, 0);
  }, [pageId]);
  useEffect(() => {
    api().onSettingsPage(open);
    window.addEventListener('hashchange', () => open(pageFromHash()));
    // Настройку поменяли голосом («говори медленнее») — показать новое значение и здесь
    api().onSettingsChanged(() => void ctx.store.load());
    void api()
      .updatesList?.()
      .then((r) => setUpdates(r?.updates || 0));
    api().onUpdatesChanged?.((r) => setUpdates(r?.updates || 0));
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [ctx]);
  useEffect(() => {
    document.title = `${s.values.name || 'Орион'} — настройки`;
  }, [s.values.name]);

  const page = PAGES.find((p) => p.id === pageId) || PAGES[0];
  const found = useMemo(() => {
    const matches = matcher(query);
    if (!matches) return null;
    return PAGES.map((p) => {
      const pageMatch = matches(`${p.title} ${p.keywords || ''}`);
      if (p.Render) return pageMatch ? { page: p, rows: null } : null;
      // Только то, что сейчас видно на странице: скрытые разделы и строки (when) не ищутся, одна настройка — один раз
      const seen = new Set<string>();
      const rows = (p.sections || [])
        .filter((sec) => !sec.when || sec.when(s.values, s))
        .flatMap((sec) => rowsOf(sec, s))
        .filter((row) => !row.when || row.when(s.values, s))
        .filter((row) => {
          const key = 'key' in row ? row.key : row.label;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const hit = pageMatch ? rows : rows.filter((row) => matches(searchText(row)));
      return hit.length ? { page: p, rows: hit } : null;
    }).filter(Boolean) as { page: Page; rows: ReturnType<typeof rowsOf> | null }[];
  }, [query, s]);

  return (
    <div className={`settings${s.values['ui.calm'] === true ? ' calm' : ''}`}>
      <span className="settings-scan" aria-hidden="true" />
      <header className="titlebar">
        <Sphere size={16} spin={10} />
        <span className="titlebar-text">{`${s.values.name || 'Орион'} — настройки`}</span>
      </header>
      <div className="layout">
        <nav className="sidebar" aria-label="Разделы настроек">
          <label className="search">
            <Icon name="search" />
            <input
              ref={search}
              type="search"
              placeholder="Поиск настроек"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
          </label>
          {GROUPS.map((g) => (
            <div className="nav-group" key={g.id}>
              <div className="nav-title">{g.title}</div>
              {PAGES.filter((p) => p.group === g.id).map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`nav-item${!found && p.id === page.id ? ' on' : ''}`}
                  onClick={() => open(p.id)}
                >
                  <Icon name={p.icon as IconName} size={18} />
                  <span>{p.title}</span>
                  {p.id === 'components' && updates > 0 && <span className="badge" title={`Обновлений: ${updates}`} />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <main className="content" ref={content} tabIndex={-1}>
          {s.restart && (
            <div className="restart-bar tone-amber">
              <span>Часть изменений заработает после перезапуска.</span>
              <Button variant="danger" onClick={() => api().restart()}>
                Перезапустить
              </Button>
            </div>
          )}
          {s.error && (
            <div className="settings-error tone-amber" role="alert">
              {s.error}
            </div>
          )}
          {!s.loaded ? (
            <div className="page-state" role="status">
              {s.loadError ? (
                <>
                  <span>Не удалось загрузить настройки: {s.loadError}</span>
                  <Button onClick={() => void ctx.store.load()}>Повторить</Button>
                </>
              ) : (
                <span>Загружаю…</span>
              )}
            </div>
          ) : found ? (
            <>
              <div className="page-head">
                <h1>Поиск</h1>
                <p>«{query}»</p>
              </div>
              {found.map(({ page: p, rows }) => (
                <section className="section" key={p.id}>
                  <button type="button" className="found-in" onClick={() => open(p.id)}>
                    {p.title}
                  </button>
                  {rows ? (
                    <div className="card-list">
                      {rows.map((row, i) => (
                        <RowView key={'key' in row ? row.key : `${row.label}-${i}`} row={row} ctx={ctx} s={s} />
                      ))}
                    </div>
                  ) : (
                    <Button onClick={() => open(p.id)}>Открыть «{p.title}»</Button>
                  )}
                </section>
              ))}
              {!found.length && <p className="empty">Ничего не нашлось. Попробуйте другое слово.</p>}
            </>
          ) : (
            <>
              <div className="page-head">
                <h1>{page.title}</h1>
                {page.description && <p>{page.description}</p>}
              </div>
              {page.Render ? (
                <page.Render ctx={ctx} />
              ) : (
                page.sections?.map((sec, i) => <SectionView key={sec.title || i} section={sec} ctx={ctx} s={s} />)
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const store = createStore(api());
const ctx: Ctx = { api: api(), store };
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary title="настройки">
      <App ctx={ctx} />
    </ErrorBoundary>
  </StrictMode>,
);
void store.load();
