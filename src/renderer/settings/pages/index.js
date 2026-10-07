// Разделы настроек и их группы в боковой панели. Новый раздел — файл в этой папке и строка здесь.
//
// Раздел: { id, group, title, icon, description, keywords?,
//   sections: [{ title?, note?, when?(values), rows: [строки из ../rows.js] | (state) → строки }]
//   — или render(ctx) → { node, refresh(state), dispose?() } для своего вида (как «Компоненты») }
import general from './general.js';
import voice from './voice.js';
import hearing from './hearing.js';
import models from './models.js';
import connections from './connections.js';
import skills from './skills.js';
import advanced from './advanced.js';
import components from './components.js';
import about from './about.js';

export const GROUPS = [
  { id: 'assistant', title: 'Ассистент' },
  { id: 'brain', title: 'Интеллект' },
  { id: 'system', title: 'Система' },
];

export const PAGES = [general, voice, hearing, models, connections, skills, advanced, components, about];
