export {
  buildBwrapArgs,
  EGRESS_SOCKET_MOUNT,
  findMaskedPaths,
  gitMetadataPaths,
  isCredentialName,
  isEnvFileName,
  WORKSPACE_MOUNT,
  type BwrapBuild,
} from "./profile.ts";
export { buildSeccompProgram, DENIED_SYSCALLS_X86_64, seccompSupported } from "./seccomp.ts";
export {
  isForbiddenAddress,
  startEgressProxy,
  type EgressDecision,
  type EgressProxy,
  type EgressProxyOptions,
  type Resolver,
} from "./egress-proxy.ts";
export {
  createSandboxedRunner,
  probeSandbox,
  sandboxInvocation,
  sandboxUsable,
  writeSeccompFile,
  type Runner,
  type SandboxCapabilities,
} from "./runner.ts";

/**
 * Chemin du pont TCP->socket Unix à monter dans le sandbox pour les clients HTTPS_PROXY. Calculé à l'appel
 * (et non au chargement) : dans le bundle CommonJS d'Electron, le fichier doit être fourni par l'empaquetage.
 */
export function proxyBridgePath(): string {
  return new URL("./proxy-bridge.mjs", import.meta.url).pathname;
}
