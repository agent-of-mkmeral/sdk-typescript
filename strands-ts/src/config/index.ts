/**
 * Public entry point for the declarative configuration module.
 *
 * Status: PoC. The interfaces here (`Configurable`, `ConfigurableStatic`,
 * `ComponentSpec`, `SecretRef`) are the customer-facing contract. Existing
 * SDK components (`BedrockModel`, `SlidingWindowConversationManager`, the
 * various `*Sandbox` classes, etc.) need to implement `Configurable` for
 * the loader/generator to build them — that work is intentionally out of
 * scope for this PoC and tracked separately.
 */

export type { ComponentSpec, Configurable, ConfigurableStatic } from './types.js'
export { isConfigurable, isConfigurableStatic } from './types.js'

export {
  SecretRef,
  isSecretRef,
  toSecretRef,
  EnvSecretProvider,
  SecretResolver,
  defaultSecretResolver,
} from './secret.js'
export type { SecretProvider, SecretProviderName } from './secret.js'

export { ProviderRegistry, ProviderResolutionError, WELL_KNOWN_PROVIDERS, defaultRegistry } from './registry.js'

export {
  StrandsConfigSchema,
  AgentSpecSchema,
  ComponentSpecSchema,
  ComponentRefSchema,
  McpServerSchema,
  normalizeComponentRef,
} from './schema.js'
export type { StrandsConfigData, AgentSpecData, ComponentSpecData, ComponentRefData, McpServerData } from './schema.js'

export { ConfigLoader, liftSecretRefs } from './loader.js'
export type { ConfigLoaderOptions, BuiltAgent } from './loader.js'

export { ConfigGenerator, ConfigGeneratorError } from './generator.js'
export type { AgentBuildInput, ConfigurableInput } from './generator.js'
