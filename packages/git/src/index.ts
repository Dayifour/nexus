export {
  GitBroker,
  locateGit,
  unsafeConfigKeys,
  type DiffOptions,
  type DiffResult,
  type GitBrokerOptions,
  type MergePlan,
  type MergeResult,
  type RepoInfo,
  type Runner,
  type StatusResult,
  type TaskWorktree,
} from "./broker.ts";
export { bound, GitError, isGitError, type GitErrorCode } from "./errors.ts";
export {
  parseNameStatusZ,
  parsePorcelainZ,
  type FileChange,
  type FileChangeStatus,
  type StatusEntry,
} from "./parse.ts";
export {
  canonicalJson,
  mergePlanFingerprint,
  planPush,
  sha256Hex,
  stripUrlCredentials,
  type MergePlanInput,
  type PushPlan,
  type PushPlanInput,
} from "./plan.ts";
export {
  isEnvFile,
  maskSecret,
  maskSecretsInText,
  scanDiffForSecrets,
  unquoteDiffPath,
  type ScanResult,
  type SecretFinding,
  type SecretRule,
} from "./secrets.ts";
export {
  assertAuthor,
  assertCommitMessage,
  assertRelativePath,
  assertSafeRefName,
  assertTaskBranch,
  assertTaskId,
  isSafeRefName,
  taskBranchName,
  TASK_BRANCH,
  type GitAuthor,
} from "./validate.ts";
