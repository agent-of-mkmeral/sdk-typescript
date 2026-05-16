/**
 * Core types for declarative agent configuration.
 *
 * The `Configurable` interface is the spine of the config system. Anything
 * that can be created from a YAML/JSON config and serialized back implements it.
 *
 * The pattern follows AutoGen's `ComponentModel` design: components carry a
 * `provider` string (a fully-qualified module + export path) instead of an
 * opaque type identifier. This makes configs self-describing — the loader
 * resolves `provider` via dynamic import without any pre-registration step.
 */

/**
 * Schema for a single component instance in a config file.
 *
 * @example
 * ```yaml
 * sandbox:
 *   provider: "@strands-agents/sdk.DockerSandbox"
 *   componentVersion: 1
 *   config:
 *     image: "node:20-slim"
 *     memory: "512m"
 * ```
 */
export interface ComponentSpec<TConfig = Record<string, unknown>> {
  /**
   * Fully-qualified provider string: `"<module>.<exportName>"`.
   *
   * Built-ins use a short alias (e.g. `"bedrock"`) that the registry resolves
   * to the canonical provider. External components use the full module path.
   */
  provider: string

  /**
   * Logical category — `"model"`, `"sandbox"`, `"conversationManager"`, etc.
   * Optional: defaults to whatever category the provider declares.
   */
  componentType?: string

  /**
   * Version of THIS component's config schema (independent of the spec
   * version on the top-level config). Lets a single component evolve its
   * config without breaking the whole file.
   */
  componentVersion?: number

  /** Human-readable label for diagnostics. Defaults to the export name. */
  label?: string

  /** Optional description (defaults to docstring of the provider class). */
  description?: string

  /** The actual config payload passed to `fromConfig()`. */
  config: TConfig
}

/**
 * Static side of a configurable class: the class itself knows how to hydrate
 * an instance from a typed config object.
 */
export interface ConfigurableStatic<TInstance, TConfig = Record<string, unknown>> {
  /**
   * The category this provider serves (e.g. `"sandbox"`, `"model"`,
   * `"conversationManager"`). Used for type validation when loading.
   */
  readonly componentType: string

  /**
   * Current version of this component's config schema. Bump when introducing
   * breaking changes; implement `fromConfigPastVersion` to migrate older specs.
   */
  readonly componentVersion?: number

  /**
   * Optional override for the provider string written by `dumpComponent`.
   * Use to keep canonical paths stable when refactoring internal modules.
   */
  readonly componentProviderOverride?: string

  /**
   * Hydrate an instance from a validated config object.
   * MUST be `Promise`-returning (or sync). Loader awaits in either case.
   */
  fromConfig(config: TConfig): TInstance | Promise<TInstance>

  /**
   * Optional: hydrate from a past version's config shape.
   * Called when `componentVersion` in the spec is older than the current.
   */
  fromConfigPastVersion?(config: Record<string, unknown>, version: number): TInstance | Promise<TInstance>
}

/**
 * Instance side of a configurable class.
 */
export interface Configurable<TConfig = Record<string, unknown>> {
  /**
   * Serialize this instance back to a `ComponentSpec` that round-trips
   * through `ConfigLoader.create()`. Secrets are returned as `SecretRef`
   * objects, NOT resolved values.
   */
  dumpComponent(): ComponentSpec<TConfig>
}

/**
 * Type guard for `Configurable` instances.
 */
export function isConfigurable(obj: unknown): obj is Configurable {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'dumpComponent' in obj &&
    typeof (obj as Configurable).dumpComponent === 'function'
  )
}

/**
 * Type guard for `ConfigurableStatic` factories.
 */
export function isConfigurableStatic(obj: unknown): obj is ConfigurableStatic<unknown, Record<string, unknown>> {
  return (
    obj !== null &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    typeof (obj as { componentType?: unknown }).componentType === 'string' &&
    typeof (obj as { fromConfig?: unknown }).fromConfig === 'function'
  )
}
