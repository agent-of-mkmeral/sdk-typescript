/**
 * `ConfigLoader` — parses, validates, and instantiates a Strands config.
 *
 * The loader does NOT manage runtime lifecycle. It hydrates components
 * from config and returns them. Owning shared MCP clients / sandboxes is
 * the caller's job (consistent with how Agents work today: you pass
 * resources in, the Agent uses them, you tear them down).
 *
 * The pipeline:
 *
 * ```
 *   raw object  ─►  schema.parse  ─►  resolve $secret refs  ─►  build()
 * ```
 *
 * Secret refs are NOT resolved at load time. They survive as `SecretRef`
 * objects in the config and the component owners (e.g. an MCP client
 * launcher) resolve them at use time via `SecretResolver`.
 */

import { ProviderRegistry, defaultRegistry } from './registry.js'
import {
  StrandsConfigSchema,
  type StrandsConfigData,
  type AgentSpecData,
  type ComponentSpecData,
  type ComponentRefData,
  normalizeComponentRef,
} from './schema.js'
import type { ConfigurableStatic } from './types.js'
import { isSecretRef, toSecretRef, SecretRef } from './secret.js'

/**
 * Walk a JSON-ish value and replace any `{ $secret: { provider, key } }`
 * objects with `SecretRef` instances. Pure transform — does NOT contact
 * any secret backend.
 */
export function liftSecretRefs<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (isSecretRef(value)) {
    return toSecretRef(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => liftSecretRefs(v)) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = liftSecretRefs(v)
  }
  return out as T
}

export interface ConfigLoaderOptions {
  /** Registry to use for provider resolution. Defaults to `defaultRegistry`. */
  registry?: ProviderRegistry
  /**
   * Optional importer for tests / sandboxed environments.
   * Receives a module ID, returns the module's exports.
   */
  importer?: (moduleId: string) => Promise<Record<string, unknown>>
}

/**
 * Result of a build — a fully hydrated set of agent components.
 */
export interface BuiltAgent {
  name: string
  model: unknown
  tools: unknown[]
  mcpServers: string[]
  sandbox?: unknown
  conversationManager?: unknown
  interventions: unknown[]
  systemPrompt?: string | { file: string }
  maxTurns?: number
  timeout?: number
}

/**
 * Build state for a multi-agent config — components are de-duplicated by
 * provider+config so that two agents referencing the same sandbox spec
 * share an instance.
 */
class SharedComponentCache {
  private cache = new Map<string, unknown>()

  async getOrBuild(spec: ComponentSpecData, factory: () => Promise<unknown>): Promise<unknown> {
    const key = `${spec.provider}::${JSON.stringify(spec.config)}::${spec.componentVersion ?? ''}`
    let inst = this.cache.get(key)
    if (inst === undefined) {
      inst = await factory()
      this.cache.set(key, inst)
    }
    return inst
  }
}

/**
 * `ConfigLoader` — load, validate, and hydrate.
 */
export class ConfigLoader {
  private constructor(
    public readonly config: StrandsConfigData,
    private readonly options: {
      registry: ProviderRegistry
      importer?: (moduleId: string) => Promise<Record<string, unknown>>
    }
  ) {}

  /**
   * Load a config from a parsed YAML/JSON object.
   *
   * (File-loading is deliberately separate — the SDK shouldn't pull in a
   * YAML parser as a hard dependency. Customers parse the file with their
   * preferred library and hand us the object.)
   */
  static load(raw: unknown, options: ConfigLoaderOptions = {}): ConfigLoader {
    const parsed = StrandsConfigSchema.parse(raw)
    const lifted = liftSecretRefs(parsed)
    const opts: { registry: ProviderRegistry; importer?: (moduleId: string) => Promise<Record<string, unknown>> } = {
      registry: options.registry ?? defaultRegistry,
    }
    if (options.importer) opts.importer = options.importer
    return new ConfigLoader(lifted, opts)
  }

  /**
   * Get the merged spec for an agent (with `extends` applied).
   */
  getAgentSpec(name: string): AgentSpecData {
    const spec = this.config.agents[name]
    if (!spec) throw new Error(`agent=<${name}> | not found in config`)
    if (!spec.extends) return spec
    const base = this.config.agentDefaults[spec.extends]
    if (!base) {
      throw new Error(`agent=<${name}>, extends=<${spec.extends}> | unknown agentDefaults reference`)
    }
    // Shallow merge: base first, then spec overrides. Arrays in spec
    // REPLACE arrays in base (no surprise append). To compose tool sets,
    // declare the union in the agentDefault and override only what differs.
    return { ...base, ...spec, extends: undefined } as AgentSpecData
  }

  /**
   * Build a single agent's components.
   */
  async createAgent(name: string): Promise<BuiltAgent> {
    const cache = new SharedComponentCache()
    return this.buildAgent(name, cache)
  }

  /**
   * Build all agents, sharing component instances by provider+config across
   * agents (so two agents that reference the same sandbox spec share one
   * instance).
   */
  async createAgents(): Promise<Map<string, BuiltAgent>> {
    const cache = new SharedComponentCache()
    const out = new Map<string, BuiltAgent>()
    for (const name of Object.keys(this.config.agents)) {
      out.set(name, await this.buildAgent(name, cache))
    }
    return out
  }

  private async buildAgent(name: string, cache: SharedComponentCache): Promise<BuiltAgent> {
    const spec = this.getAgentSpec(name)

    const model = await this.buildOne(spec.model, cache)
    const tools = await Promise.all(spec.tools.map((t) => this.buildOne(t, cache)))
    const sandbox = spec.sandbox ? await this.buildOne(spec.sandbox, cache) : undefined
    const conversationManager = spec.conversationManager
      ? await this.buildOne(spec.conversationManager, cache)
      : undefined
    const interventions = await Promise.all(spec.interventions.map((i) => this.buildOne(i, cache)))

    const built: BuiltAgent = {
      name,
      model,
      tools,
      mcpServers: spec.mcpServers,
      interventions,
    }
    if (sandbox !== undefined) built.sandbox = sandbox
    if (conversationManager !== undefined) built.conversationManager = conversationManager
    if (spec.systemPrompt !== undefined) built.systemPrompt = spec.systemPrompt
    if (spec.maxTurns !== undefined) built.maxTurns = spec.maxTurns
    if (spec.timeout !== undefined) built.timeout = spec.timeout
    return built
  }

  private async buildOne(ref: ComponentRefData, cache: SharedComponentCache): Promise<unknown> {
    const spec = normalizeComponentRef(ref)
    return cache.getOrBuild(spec, async () => {
      const factory: ConfigurableStatic<unknown, Record<string, unknown>> = await this.options.registry.resolve(
        spec.provider,
        this.options.importer
      )

      // Per-component versioning: if the spec is older than the current
      // factory version, dispatch to the migration hook (if provided).
      const currentVersion = factory.componentVersion ?? 1
      const specVersion = spec.componentVersion ?? currentVersion
      if (specVersion < currentVersion) {
        if (factory.fromConfigPastVersion) {
          return factory.fromConfigPastVersion(spec.config, specVersion)
        }
        throw new Error(
          `provider=<${spec.provider}>, specVersion=<${specVersion}>, currentVersion=<${currentVersion}> | migration not implemented (no fromConfigPastVersion)`
        )
      }
      if (specVersion > currentVersion) {
        throw new Error(
          `provider=<${spec.provider}>, specVersion=<${specVersion}>, currentVersion=<${currentVersion}> | config is newer than installed component | upgrade the package`
        )
      }
      return factory.fromConfig(spec.config)
    })
  }
}

// Re-export so callers can `import { SecretRef } from './loader.js'` if
// they need to construct refs programmatically.
export { SecretRef }
