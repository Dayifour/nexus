// Montage de l'application React et démarrage du pont d'événements du main.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startEventBridge } from "./lib/events.ts";
import { useAppStore } from "./stores/app.ts";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";

export function mount(root: HTMLElement): void {
  startEventBridge();
  void useAppStore.getState().loadInfo();
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="app">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
