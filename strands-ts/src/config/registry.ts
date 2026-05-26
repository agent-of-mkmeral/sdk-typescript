/**
 * Provider registry for declarative configuration.
 *
 * The registry maps short aliases (e.g. `"bedrock"`, `"sliding-window"`) to
 * canonical provider strings (`"<module>.<exportName>"`), and resolves
 * canonical providers to their `ConfigurableStatic` factories via dynamic
 * import.
 *
 * **No pre-registration is required for built-ins to work** — the registry
 * ships seeded with well-known aliases. Customers only register additional
 * aliases when they want short names for their own components, OR they can
 * just use the canonical `"<module>.<exportName>"` form directly in YAML.
 */

import { isConfigurableStatic, type ConfigurableStatic } from './types.js'

/** Built-in well-known aliases — seeded into every fresh registry. */
export const WELL_KNOWN_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  // Models
  bedrock: '@strands-agents/sdk/models/bedrock.BedrockModel',
  anthropic: '@strands-agents/sdk/models/anthropic.AnthropicModel',
  openai: '@strands-agents/sdk/models/openai.OpenAIModel',

  // Conversation managers
  'sliding-window': '@strands-agents/sdk.SlidingWindowConversationManager',
  summarizing: '@strands-agents/sdk.SummarizingConversationManager',
  'null-conversation': '@strands-agents/sdk.NullConversationManager',
})

/**
 * Default trusted namespaces — providers whose canonical path starts with
 * one of these prefixes are loaded without an extra opt-in. Any other
 * provider must be explicitly allowed via `registerNamespace` or the
 * `STRANDS_ALLOWED_PROVIDER_NAMESPACES` env var.
 */
const DEFAULT_TRUSTED_NAMESPACES: readonly string[] = ['@strands-agents/sdk', '@strands-agents/']

/**
 * Read additional trusted namespaces from the environment.
 * Format: comma-separated package prefixes.
 */
function readEnvTrustedNamespaces(): string[] {
  const raw = process.env.STRANDS_ALLOWED_PROVIDER_NAMESPACES
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Errors thrown by the registry. Distinct class so callers can `instanceof`
 * to handle config errors specifically.
 */
export class ProviderResolutionError extends Error {
  override readonly name = 'ProviderResolutionError'
}

/**
 * The provider registry.
 *
 * Stateless except for the alias map and trust list — the actual factory
 * lookups go through dynamic `import()` and are NOT cached here so that
 * tests can reset module state between runs.
 */
export class ProviderRegistry {
  private aliases = new Map<string, string>()
  private trusted: string[]

  constructor(options?: { aliases?: Record<string, string>; trustedNamespaces?: string[] }) {
    for (const [alias, canonical] of Object.entries(WELL_KNOWN_PROVIDERS)) {
      this.aliases.set(alias, canonical)
    }
    if (options?.aliases) {
      for (const [alias, canonical] of Object.entries(options.aliases)) {
        this.aliases.set(alias, canonical)
      }
    }
    this.trusted = [...DEFAULT_TRUSTED_NAMESPACES, ...(options?.trustedNamespaces ?? []), ...readEnvTrustedNamespaces()]
  }

  /**
   * Register a short alias for a canonical provider path.
   * Useful when a customer wants `"my-sandbox"` instead of
   * `"@acme/wasm-sandbox.WasmSandbox"` in YAML.
   */
  registerAlias(alias: string, canonical: string): void {
    this.aliases.set(alias, canonical)
  }

  /**
   * Allow loading providers from an additional namespace prefix.
   */
  registerNamespace(prefix: string): void {
    if (!this.trusted.includes(prefix)) {
      this.trusted.push(prefix)
    }
  }

  /** Resolve an alias to a canonical provider string (or pass through). */
  resolveAlias(provider: string): string {
    return this.aliases.get(provider) ?? provider
  }

  /**
   * Validate that a canonical provider string is from a trusted namespace.
   *
   * @throws `ProviderResolutionError` if the provider is rejected.
   */
  assertTrusted(canonical: string): void {
    const isTrusted = this.trusted.some((prefix) => canonical.startsWith(prefix))
    if (!isTrusted) {
      throw new ProviderResolutionError(
        `provider=<${canonical}> | provider is not in a trusted namespace | trusted=<${this.trusted.join(',')}>`
      )
    }
  }

  /**
   * Resolve a provider string to its `ConfigurableStatic` factory.
   *
   * Lookup steps:
   *   1. Resolve aliases (`"bedrock"` → `"@strands-agents/sdk/models/bedrock.BedrockModel"`)
   *   2. Validate the canonical path is in a trusted namespace
   *   3. Split into module + export name (last `.` segment is the export)
   *   4. Dynamic-import the module
   *   5. Pluck the named export and validate it is `ConfigurableStatic`
   *
   * The optional `importer` lets tests inject a fake module loader.
   */
  async resolve(
    provider: string,
    importer?: (moduleId: string) => Promise<Record<string, unknown>>
  ): Promise<ConfigurableStatic<unknown, Record<string, unknown>>> {
    const canonical = this.resolveAlias(provider)
    this.assertTrusted(canonical)

    const lastDot = canonical.lastIndexOf('.')
    if (lastDot <= 0 || lastDot === canonical.length - 1) {
      throw new ProviderResolutionError(`provider=<${canonical}> | invalid provider | expected "<module>.<exportName>"`)
    }
    const moduleId = canonical.slice(0, lastDot)
    const exportName = canonical.slice(lastDot + 1)

    let mod: Record<string, unknown>
    try {
      mod = importer ? await importer(moduleId) : ((await import(moduleId)) as Record<string, unknown>)
    } catch (err) {
      throw new ProviderResolutionError(
        `provider=<${canonical}>, module=<${moduleId}> | failed to import module | ${(err as Error).message}`
      )
    }

    const factory = mod[exportName]
    if (!isConfigurableStatic(factory)) {
      throw new ProviderResolutionError(
        `provider=<${canonical}>, export=<${exportName}> | export does not implement ConfigurableStatic`
      )
    }
    return factory as ConfigurableStatic<unknown, Record<string, unknown>>
  }
}

/**
 * Default shared registry. Most callers should use this. Tests should
 * construct their own to avoid cross-test alias pollution.
 */
export const defaultRegistry = new ProviderRegistry()
