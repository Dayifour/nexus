// Erreurs normalisées du Git broker : un code stable (contrat pour l'UI et le journal) et un message borné.
// Aucune sortie git brute non bornée ne traverse cette frontière.

export type GitErrorCode =
  | "INVALID_REF"
  | "INVALID_PATH"
  | "INVALID_ARGUMENT"
  | "NOT_A_REPOSITORY"
  | "NOT_MAIN_WORKTREE"
  | "NOT_TASK_WORKTREE"
  | "WORKTREE_ROOT_INSIDE_REPO"
  | "WORKTREE_EXISTS"
  | "BRANCH_EXISTS"
  | "REF_NOT_FOUND"
  | "MAIN_WORKTREE_DIRTY"
  | "NOTHING_TO_COMMIT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_MISMATCH"
  | "MERGE_IN_PROGRESS"
  | "MERGE_FAILED"
  | "MAIN_WORKTREE_NOT_RESTORED"
  | "UNSAFE_REPO_CONFIG"
  | "GIT_FAILED"
  | "GIT_TIMEOUT"
  | "GIT_SPAWN_FAILED"
  | "OUTPUT_LIMIT";

export const MAX_ERROR_MESSAGE = 600;

export class GitError extends Error {
  readonly code: GitErrorCode;
  /** Données structurées bornées (ex. fichiers concernés), jamais de sortie brute. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: GitErrorCode, message: string, details?: Record<string, unknown>) {
    super(bound(message, MAX_ERROR_MESSAGE));
    this.name = "GitError";
    this.code = code;
    if (details) this.details = details;
  }
}

export function bound(text: string, max: number): string {
  // Les caractères de contrôle sont remplacés : un message d'erreur ne doit pas piloter un terminal ou un journal.
  // oxlint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const isGitError = (e: unknown, code?: GitErrorCode): e is GitError =>
  e instanceof GitError && (code === undefined || e.code === code);
