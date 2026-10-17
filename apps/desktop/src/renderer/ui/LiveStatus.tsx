// Région d'état discrète pour les lecteurs d'écran : annonce les CHANGEMENTS d'état d'un agent (« a terminé »,
// « attend votre réponse »), jamais le flux de sortie lui-même (qui rendrait la lecture inutilisable).
import { useEffect, useRef, useState } from "react";

export function LiveStatus({ message }: { message: string | undefined }) {
  const [text, setText] = useState("");
  const previous = useRef(message);
  useEffect(() => {
    // État initial (ouverture du panneau) : rien n'est annoncé ; seules les transitions le sont.
    if (message === previous.current) return;
    previous.current = message;
    setText(message ?? "");
  }, [message]);
  return (
    <div className="sr-only-live" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
