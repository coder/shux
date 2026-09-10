import { Layer } from "effect";
import {
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
  type ConfigStores,
} from "@/node/config";
import type { CoreServicesOptions } from "@/node/services/coreServices";
import {
  ConfigTag,
  FileLeaseManagerTag,
  ProvidersConfigStoreTag,
  SecretsStoreTag,
  SessionLocatorTag,
  type StoreTags,
} from "@/node/services/di/tags";

/**
 * Exposes an already-constructed `ConfigStores` bundle as Layer outputs. The
 * stores are true siblings (no inter-dependencies), so `mergeAll` is correct
 * here; anything that depends on a store must be composed with
 * `Layer.provideMerge` instead.
 */
export function StoresLive(stores: ConfigStores): Layer.Layer<StoreTags> {
  return Layer.mergeAll(
    Layer.succeed(ConfigTag)(stores.config),
    Layer.succeed(SessionLocatorTag)(stores.sessionLocator),
    Layer.succeed(ProvidersConfigStoreTag)(stores.providersConfigStore),
    Layer.succeed(SecretsStoreTag)(stores.secretsStore),
    Layer.succeed(FileLeaseManagerTag)(stores.fileLeaseManager)
  );
}

/**
 * Stores for a headless CLI root (`createCoreServices`): the caller's stores
 * when given, otherwise the same per-store defaults rooted at
 * `config.rootDir` that the core graph body applied before the stores became
 * layer inputs. Store constructors only compute paths, so building them ahead
 * of the graph changes nothing observable.
 */
export function StoresFromCoreOptionsLive(opts: CoreServicesOptions): Layer.Layer<StoreTags> {
  const { config } = opts;
  return StoresLive({
    config,
    sessionLocator: opts.sessionLocator ?? new WorkspaceSessionLocator(config.rootDir),
    providersConfigStore: opts.providersConfigStore ?? new ProvidersConfigStore(config.rootDir),
    secretsStore: opts.secretsStore ?? new SecretsStore(config.rootDir),
    fileLeaseManager: opts.fileLeaseManager ?? new FileLeaseManager(config.rootDir),
  });
}
