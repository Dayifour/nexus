// L'IA qui pilote : elle relit le profil du projet et les propositions du catalogue, les ajuste (ou en ajoute) selon la
// demande de l'utilisateur, et rend un avis. Sa réponse est un JSON validé par Zod ; tout écart est rejeté (jamais
// exécuté tel quel), et le catalogue reste disponible en repli.
import { z } from "zod";
import { DeployProvider, DeploymentProposal, type ProjectProfile } from "@nexus/contracts";
import { AUTOMATED, PROVIDER_LABEL } from "./propose.ts";

const LeadAnswer = z.strictObject({
  advice: z.string().max(4000),
  proposals: z
    .array(DeploymentProposal.omit({ origin: true }))
    .min(1)
    .max(5),
});

export function buildLeadPrompt(
  profile: ProjectProfile,
  proposals: readonly DeploymentProposal[],
  request?: string,
  language: "fr" | "en" = "fr",
): string {
  const providers = DeployProvider.options.map(
    (p) => `${p} (${PROVIDER_LABEL[p]}${AUTOMATED.has(p) ? ", déploiement automatique par Nexus" : ", guide manuel"})`,
  );
  return [
    "Tu es l'architecte qui pilote le déploiement de ce projet. Tu ne modifies AUCUN fichier et n'exécutes AUCUNE commande : tu réponds seulement.",
    "Propose les meilleures architectures de déploiement (2 à 4) pour ce projet, en ajustant les propositions de départ si utile.",
    request ? `Demande de l'utilisateur, prioritaire : ${request}` : "",
    "",
    "Profil du projet (analyse statique) :",
    JSON.stringify(profile, null, 1),
    "",
    "Propositions de départ (catalogue) :",
    JSON.stringify(
      proposals.map(({ origin: _o, ...p }) => p),
      null,
      1,
    ),
    "",
    `Fournisseurs autorisés (champ provider) : ${providers.join(", ")}.`,
    "Règles : étapes « auto » seulement pour les fournisseurs à déploiement automatique ; ordre base → back-end → front-end ;",
    "coûts mensuels réalistes en USD avec une réserve ; identifiants (champ id) courts en minuscules ; aucun secret ni valeur de variable.",
    "Les secrets attendus (requirements de type secret) utilisent ces noms : VERCEL_TOKEN, RENDER_API_KEY, RAILWAY_TOKEN, ATLAS_CLIENT_SECRET.",
    "",
    'Réponds UNIQUEMENT avec un bloc ```json contenant {"advice": string (ta recommandation argumentée), "proposals": [...] }',
    language === "en"
      ? "Write advice and every text field (title, summary, pros, cons, steps) in English."
      : "Rédige advice et tous les champs de texte (title, summary, pros, cons, steps) en français.",
    "où chaque proposition a exactement les champs : id, title, summary, placements, monthlyCost, complexity, pros, cons, requirements, steps.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/** Extrait et valide la réponse de l'IA. Lève une erreur explicite si elle est absente ou non conforme. */
export function parseLeadAnswer(text: string): { advice: string; proposals: DeploymentProposal[] } {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let lastError = "réponse sans JSON";
  for (const raw of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      lastError = "JSON invalide";
      continue;
    }
    const r = LeadAnswer.safeParse(data);
    if (!r.success) {
      lastError = r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(" ; ");
      continue;
    }
    // Une étape « auto » chez un fournisseur que Nexus ne sait pas piloter devient manuelle (jamais d'exécution inventée).
    const proposals = r.data.proposals.map((p) => ({
      ...p,
      steps: p.steps.map((s) =>
        s.kind === "auto" && !AUTOMATED.has(s.provider) ? { ...s, kind: "manual" as const } : s,
      ),
      origin: "ai" as const,
    }));
    const ids = new Set<string>();
    for (const p of proposals) {
      if (ids.has(p.id)) p.id = `${p.id}-${ids.size}`;
      ids.add(p.id);
    }
    return { advice: r.data.advice, proposals };
  }
  throw new Error(`Réponse de l'IA inexploitable (${lastError})`);
}
