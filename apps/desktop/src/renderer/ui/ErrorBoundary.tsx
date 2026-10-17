// Barrière d'erreur React : une vue qui plante n'emporte ni le plan de travail ni l'application. Le panneau fautif
// affiche un message localisé et se recharge (remontage de ses enfants) sans toucher aux autres panneaux.
import { CircleAlert, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../i18n/index.ts";
import { allowWindowUnload } from "../lib/unsaved.ts";
import { logEvent } from "../stores/log.ts";
import { Button } from "./primitives.tsx";

interface Props {
  /** « panel » : un onglet du plan de travail ; « app » : racine (dernier recours, recharge la fenêtre). */
  scope: "panel" | "app";
  /** Nom affiché dans le journal (ex. composant du panneau). */
  label?: string;
  children: ReactNode;
}

interface State {
  error?: Error;
  generation: number;
}

function Fallback({ scope, error, onReset }: { scope: Props["scope"]; error: Error; onReset(): void }) {
  const t = useT();
  return (
    <div className="error-boundary" role="alert" data-testid={`error-boundary-${scope}`}>
      <CircleAlert size={26} aria-hidden className="error-boundary-icon" />
      <p className="error-boundary-title">{t(scope === "app" ? "crash.appTitle" : "crash.panelTitle")}</p>
      <p className="error-boundary-body">{t("crash.body")}</p>
      <details className="error-boundary-detail">
        <summary>{t("crash.detail")}</summary>
        <pre>{String(error.message || error).slice(0, 2000)}</pre>
      </details>
      <Button variant="primary" icon={<RotateCcw size={14} />} onClick={onReset}>
        {t(scope === "app" ? "crash.reloadApp" : "crash.reloadPanel")}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      logEvent("error", "ui", `${this.props.label ?? this.props.scope}: ${error.message}`.slice(0, 500));
    } catch {
      // journal indisponible : rien à faire
    }
    console.error(error, info.componentStack);
  }

  private reset = () => {
    if (this.props.scope === "app") {
      allowWindowUnload();
      window.location.reload();
      return;
    }
    this.setState((s) => ({ error: undefined, generation: s.generation + 1 }));
  };

  override render(): ReactNode {
    if (this.state.error) return <Fallback scope={this.props.scope} error={this.state.error} onReset={this.reset} />;
    // La clé change à chaque rechargement : les enfants repartent d'un état neuf.
    return <ErrorBoundaryContent key={this.state.generation}>{this.props.children}</ErrorBoundaryContent>;
  }
}

function ErrorBoundaryContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
