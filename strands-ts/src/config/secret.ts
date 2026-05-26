/**
 * First-class secret handling for config files.
 *
 * Two reasons secrets are a separate type from plain env vars:
 *
 * 1. **Round-trip safety**: When `ConfigGenerator.dumpComponent()` serializes
 *    a config back to YAML, plain env interpolation would write the *resolved*
 *    secret value to disk. `SecretRef` round-trips the *reference* instead.
 *
 * 2. **Lazy resolution**: A `SecretRef` is resolved at use time (when the MCP
 *    server is launched, when a request is signed) — not eagerly at load time.
 *    This enables credential rotation and avoids materializing secrets into
 *    config objects that may be logged or traced.
 */

/**
 * Source kind for a secret reference. Custom providers can be registered
 * via `SecretResolver.registerProvider`.
 */
export type SecretProviderName = 'env' | 'secrets-manager' | 'ssm' | 'vault' | string

/**
 * An unresolved reference to a secret.
 *
 * Created by the YAML/JSON loader when it encounters the `!secret` tag or
 * `{ $secret: { provider, key } }` form. The loader does NOT resolve the
 * value — it just constructs a `SecretRef` and leaves it in the config.
 *
 * Components that need the actual value call `SecretResolver.resolve(ref)`
 * at use time.
 */
export class SecretRef {
  static readonly tag = 'SecretRef' as const

  constructor(
    public readonly provider: SecretProviderName,
    public readonly key: string,
    public readonly options?: Record<string, unknown>
  ) {}

  /**
   * Identify a `SecretRef` even across module boundaries / serialization.
   */
  readonly [Symbol.toStringTag] = SecretRef.tag

  /**
   * Round-trip-safe JSON form. NEVER includes the resolved value.
   */
  toJSON(): { $secret: { provider: SecretProviderName; key: string; options?: Record<string, unknown> } } {
    return {
      $secret: {
        provider: this.provider,
        key: this.key,
        ...(this.options ? { options: this.options } : {}),
      },
    }
  }

  /**
   * Hide the secret from `console.log` and other accidental dumps.
   * (We never have the resolved value here, but adopting the convention
   * matches what callers expect from "redacted" types.)
   */
  toString(): string {
    return `[SecretRef ${this.provider}:${this.key}]`
  }
}

/**
 * Type guard for `SecretRef` (works across module boundaries — uses tag,
 * not `instanceof`).
 */
export function isSecretRef(value: unknown): value is SecretRef {
  if (value instanceof SecretRef) return true
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === SecretRef.tag
  ) {
    return true
  }
  // JSON form: { $secret: { provider, key } }
  if (
    value !== null &&
    typeof value === 'object' &&
    '$secret' in value &&
    typeof (value as { $secret: unknown }).$secret === 'object'
  ) {
    return true
  }
  return false
}

/**
 * Coerce any of the accepted secret representations to a `SecretRef`.
 */
export function toSecretRef(value: unknown): SecretRef {
  if (value instanceof SecretRef) return value
  if (value !== null && typeof value === 'object' && '$secret' in value) {
    const s = (value as { $secret: { provider: SecretProviderName; key: string; options?: Record<string, unknown> } })
      .$secret
    return new SecretRef(s.provider, s.key, s.options)
  }
  throw new TypeError('value is not a SecretRef')
}

/**
 * A backend that knows how to resolve secrets for a particular provider.
 */
export interface SecretProvider {
  /** Resolve the secret value for `key`. */
  resolve(key: string, options?: Record<string, unknown>): Promise<string>
}

/**
 * The default env-backed provider — resolves `key` from `process.env`.
 */
export class EnvSecretProvider implements SecretProvider {
  async resolve(key: string): Promise<string> {
    const value = process.env[key]
    if (value === undefined) {
      throw new Error(`secret env var not set: ${key}`)
    }
    return value
  }
}

/**
 * Registry of secret providers. The loader uses this to resolve `SecretRef`
 * objects at use time. Customers can register additional providers
 * (Secrets Manager, SSM, Vault, ...) without touching the config schema.
 */
export class SecretResolver {
  private providers = new Map<SecretProviderName, SecretProvider>()

  constructor() {
    this.providers.set('env', new EnvSecretProvider())
  }

  registerProvider(name: SecretProviderName, provider: SecretProvider): void {
    this.providers.set(name, provider)
  }

  /**
   * Resolve a `SecretRef` to its plaintext value.
   *
   * @param ref - the unresolved reference
   * @throws if the provider is unknown or resolution fails
   */
  async resolve(ref: SecretRef): Promise<string> {
    const provider = this.providers.get(ref.provider)
    if (!provider) {
      throw new Error(`unknown secret provider=<${ref.provider}> | register one via SecretResolver.registerProvider`)
    }
    return provider.resolve(ref.key, ref.options)
  }

  /**
   * Walk a config object and resolve every `SecretRef` it contains.
   * Returns a deep clone with resolved values in place.
   *
   * Use this AT THE BOUNDARY when launching an external process / signing
   * a request — never bake the result back into long-lived config.
   */
  async resolveAll<T>(value: T): Promise<T> {
    if (isSecretRef(value)) {
      return (await this.resolve(toSecretRef(value))) as unknown as T
    }
    if (Array.isArray(value)) {
      return (await Promise.all(value.map((v) => this.resolveAll(v)))) as unknown as T
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await this.resolveAll(v)
      }
      return out as T
    }
    return value
  }
}

/**
 * Default shared resolver. Customers can either use this directly or
 * construct their own `SecretResolver` for isolation.
 */
export const defaultSecretResolver = new SecretResolver()
