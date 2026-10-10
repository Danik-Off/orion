// Сборка интерфейса: три окна — разговор (с капсулой и кубом), настройки, мини-плеер радио.
//   npm run ui:build  → src/ui/dist (его и открывает Electron)
//   npm run ui:watch  → пересборка при каждом изменении
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Окна открываются из file://: модульным скриптам атрибут crossorigin там не нужен и только мешает
const noCrossorigin = (): Plugin => ({
  name: 'orion-no-crossorigin',
  transformIndexHtml: (html) => html.replace(/ crossorigin/g, ''),
});

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), noCrossorigin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130', // Electron 38
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0, // шрифты и прочее — файлами: CSP окна не пускает data: для шрифтов
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        player: resolve(__dirname, 'radio-player.html'),
      },
    },
  },
});
