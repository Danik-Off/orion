// Предохранитель окна: ошибка при отрисовке не оставляет пустое окно (звук при этом живёт своей жизнью),
// а показывает, что случилось, и даёт перезагрузить окно. Ошибка уходит в журнал: главный процесс читает
// консоль окна и пишет строки «Uncaught …» (app/crash-guard.js).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Holo } from './Holo.tsx';
import { Button } from './controls.tsx';

export class ErrorBoundary extends Component<{ children: ReactNode; title?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Uncaught (отрисовка окна) ${error?.stack || error}\n${info.componentStack || ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <Holo className="crash-panel tone-amber" tone="amber" glass="solid" flicker={false}>
          <div className="crash-title">Что-то пошло не так в окне{this.props.title ? ` «${this.props.title}»` : ''}</div>
          <p className="crash-text">Ошибка записана в журнал. Голос и команды работают — окно можно просто перезагрузить.</p>
          <Button variant="primary" onClick={() => location.reload()}>
            Перезагрузить окно
          </Button>
        </Holo>
      </div>
    );
  }
}
