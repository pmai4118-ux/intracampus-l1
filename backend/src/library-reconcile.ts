import { selectedDeploymentManifest as manifest } from "@intracampus/network";
import { fileURLToPath } from "node:url";
import { requireLibraryDeployment } from "@intracampus/network";
import { LibraryRepository } from "./modules/library/library.repository.ts";
import { readLibraryConfig, LibraryConfigurationError } from "./modules/library/library.config.ts";
import { LibraryReconciler, LibraryChainError } from "./modules/library/library.reconcile.ts";
import { HttpLibraryRpc, LibraryRpcError } from "./modules/library/library.rpc.ts";

let repository: LibraryRepository | undefined;
let rpc: HttpLibraryRpc | undefined;

try {
  const config = readLibraryConfig(process.env);
  const deployment = requireLibraryDeployment(manifest, { allowLocal: config.allowLocal }).library;
  repository = new LibraryRepository(process.env.LIBRARY_DB_PATH?.trim()
    || fileURLToPath(new URL("../data/library.sqlite", import.meta.url)));
  rpc = new HttpLibraryRpc(config.rpcUrl);

  const result = await new LibraryReconciler(repository, rpc, deployment, config.chainFreshness).reconcile();
  const cursorBlock = repository.reconcileState().cursorBlock;
  console.log(JSON.stringify({ safeBlock: result.safeBlock, cursorBlock, caughtUp: result.caughtUp,
    applied: result.applied, ignored: result.ignored }));
  if (!result.caughtUp) process.exitCode = 2;
} catch (error) {
  const code = error instanceof LibraryChainError || error instanceof LibraryRpcError ? error.code
    : error instanceof LibraryConfigurationError ? "CONFIGURATION_ERROR"
    : error instanceof Error && error.message === "LIBRARY_DATABASE_BUSY" ? "DATABASE_BUSY"
    : "INTERNAL_ERROR";
  console.error(JSON.stringify({ error: { code } }));
  process.exitCode = 1;
} finally {
  rpc?.destroy();
  repository?.close();
}
