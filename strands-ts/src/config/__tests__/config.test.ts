/**
 * Tests for the declarative configuration module (PoC).
 *
 * These exercise:
 *   - the `Configurable` interface contract
 *   - `SecretRef` round-trip safety
 *   - `ProviderRegistry` alias resolution + namespace gating
 *   - `ConfigLoader` schema validation, ref resolution, version migration
 *     and shared-component caching
 *   - `ConfigGenerator` round-trip (dump → load → re-dump)
 */

import { describe, expect, it } from 'vitest'
import {
  ConfigGenerator,
  ConfigLoader,
  ProviderRegistry,
  ProviderResolutionError,
  SecretRef,
  SecretResolver,
  StrandsConfigSchema,
  defaultSecretResolver,
  isConfigurable,
  isSecretRef,
  liftSecretRefs,
  normalizeComponentRef,
} from '../index.js'
import type { Configurable, ConfigurableStatic, ComponentSpec } from '../types.js'

// ─── Test fixtures: minimal Configurable components ─────────────────────────

class FakeModel implements Configurable {
  static readonly componentType = 'model'
  static readonly componentVersion = 1
  static fromConfig(cfg: Record<string, unknown>): FakeModel {
    return new FakeModel(cfg['modelId'] as string, cfg['temperature'] as number | undefined)
  }
  constructor(
    public readonly modelId: string,
    public readonly temperature?: number
  ) {}
  dumpComponent(): ComponentSpec {
    return {
      provider: 'test/fake.FakeModel',
      componentType: FakeModel.componentType,
      componentVersion: FakeModel.componentVersion,
      label: 'FakeModel',
      config: {
        modelId: this.modelId,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      },
    }
  }
}

class FakeSandbox implements Configurable {
  static readonly componentType = 'sandbox'
  static readonly componentVersion = 2
  static fromConfig(cfg: Record<string, unknown>): FakeSandbox {
    return new FakeSandbox(cfg['image'] as string, cfg['apiKey'] as SecretRef | string | undefined)
  }
  static fromConfigPastVersion(cfg: Record<string, unknown>, version: number): FakeSandbox {
    if (version === 1) {
      // v1 used `dockerImage` instead of `image`
      return new FakeSandbox(cfg['dockerImage'] as string)
    }
    throw new Error(`unsupported version=${version}`)
  }
  constructor(
    public readonly image: string,
    public readonly apiKey?: SecretRef | string
  ) {}
  dumpComponent(): ComponentSpec {
    return {
      provider: 'test/fake.FakeSandbox',
      componentType: 'sandbox',
      componentVersion: 2,
      config: {
        image: this.image,
        ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
      },
    }
  }
}

// Importer that returns the fake module exports.
function fakeImporter(_moduleId: string): Promise<Record<string, unknown>> {
  return Promise.resolve({
    FakeModel: FakeModel as unknown as ConfigurableStatic<unknown>,
    FakeSandbox: FakeSandbox as unknown as ConfigurableStatic<unknown>,
  })
}

function buildRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry({ trustedNamespaces: ['test/'] })
  reg.registerAlias('fake-model', 'test/fake.FakeModel')
  reg.registerAlias('fake-sandbox', 'test/fake.FakeSandbox')
  return reg
}

// ─── SecretRef ──────────────────────────────────────────────────────────────

describe('SecretRef', () => {
  it('serializes to a $secret envelope, never includes a resolved value', () => {
    const ref = new SecretRef('env', 'GITHUB_TOKEN')
    const json = JSON.parse(JSON.stringify(ref))
    expect(json).toEqual({ $secret: { provider: 'env', key: 'GITHUB_TOKEN' } })
  })

  it('toString is redacted', () => {
    const ref = new SecretRef('vault', 'db/password')
    expect(ref.toString()).toBe('[SecretRef vault:db/password]')
    expect(ref.toString()).not.toContain('password=')
  })

  it('isSecretRef recognizes both class instances and plain $secret objects', () => {
    expect(isSecretRef(new SecretRef('env', 'X'))).toBe(true)
    expect(isSecretRef({ $secret: { provider: 'env', key: 'X' } })).toBe(true)
    expect(isSecretRef('not a ref')).toBe(false)
    expect(isSecretRef(null)).toBe(false)
    expect(isSecretRef(undefined)).toBe(false)
  })

  it('round-trips through JSON.stringify and lifting', () => {
    const original = new SecretRef('env', 'TOKEN', { region: 'us-east-1' })
    const wire = JSON.parse(JSON.stringify({ secret: original }))
    expect(isSecretRef(wire.secret)).toBe(true)
    const lifted = liftSecretRefs(wire)
    expect(lifted.secret).toBeInstanceOf(SecretRef)
    expect((lifted.secret as SecretRef).provider).toBe('env')
    expect((lifted.secret as SecretRef).key).toBe('TOKEN')
    expect((lifted.secret as SecretRef).options).toEqual({ region: 'us-east-1' })
  })
})

describe('SecretResolver', () => {
  it('resolves env-backed refs through process.env', async () => {
    const prev = process.env.STRANDS_TEST_TOKEN
    process.env.STRANDS_TEST_TOKEN = 'shhh'
    try {
      const ref = new SecretRef('env', 'STRANDS_TEST_TOKEN')
      const value = await defaultSecretResolver.resolve(ref)
      expect(value).toBe('shhh')
    } finally {
      if (prev === undefined) delete process.env.STRANDS_TEST_TOKEN
      else process.env.STRANDS_TEST_TOKEN = prev
    }
  })

  it('throws for unknown providers with structured context', async () => {
    const resolver = new SecretResolver()
    await expect(resolver.resolve(new SecretRef('vault', 'k'))).rejects.toThrow(/provider=<vault>/)
  })

  it('resolveAll walks nested structures and replaces refs in-place', async () => {
    const resolver = new SecretResolver()
    resolver.registerProvider('test', { resolve: async (k) => `value-of-${k}` })
    const config = {
      env: {
        TOKEN: new SecretRef('test', 'TOKEN'),
        REGION: 'us-east-1',
      },
      list: [new SecretRef('test', 'A'), 'plain'],
    }
    const resolved = await resolver.resolveAll(config)
    expect(resolved.env.TOKEN).toBe('value-of-TOKEN')
    expect(resolved.env.REGION).toBe('us-east-1')
    expect(resolved.list).toEqual(['value-of-A', 'plain'])
  })
})

// ─── ProviderRegistry ───────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  it('seeds well-known aliases for built-in providers', () => {
    const reg = new ProviderRegistry()
    expect(reg.resolveAlias('bedrock')).toBe('@strands-agents/sdk/models/bedrock.BedrockModel')
    expect(reg.resolveAlias('sliding-window')).toBe('@strands-agents/sdk.SlidingWindowConversationManager')
  })

  it('passes through unknown aliases unchanged', () => {
    const reg = new ProviderRegistry()
    expect(reg.resolveAlias('@acme/foo.Bar')).toBe('@acme/foo.Bar')
  })

  it('rejects providers from untrusted namespaces', () => {
    const reg = new ProviderRegistry()
    expect(() => reg.assertTrusted('node:fs.readFileSync')).toThrow(ProviderResolutionError)
    expect(() => reg.assertTrusted('@strands-agents/sdk.Foo')).not.toThrow()
  })

  it('respects custom trustedNamespaces', () => {
    const reg = new ProviderRegistry({ trustedNamespaces: ['@acme/'] })
    expect(() => reg.assertTrusted('@acme/sandbox.WasmSandbox')).not.toThrow()
  })

  it('resolves a canonical provider via dynamic import', async () => {
    const reg = buildRegistry()
    const factory = await reg.resolve('test/fake.FakeModel', fakeImporter)
    expect(factory.componentType).toBe('model')
  })

  it('rejects exports that are not ConfigurableStatic', async () => {
    const reg = new ProviderRegistry({ trustedNamespaces: ['test/'] })
    await expect(
      reg.resolve('test/fake.NotAComponent', () => Promise.resolve({ NotAComponent: { hello: 'world' } }))
    ).rejects.toThrow(/does not implement ConfigurableStatic/)
  })

  it('rejects malformed provider strings', async () => {
    const reg = new ProviderRegistry({ trustedNamespaces: ['test/'] })
    await expect(reg.resolve('test/no-dot-here', fakeImporter)).rejects.toThrow(/invalid provider/)
  })
})

// ─── ConfigLoader ───────────────────────────────────────────────────────────

describe('ConfigLoader', () => {
  it('rejects configs with the wrong version literal', () => {
    expect(() =>
      ConfigLoader.load({
        version: '0.9',
        agents: { main: { model: 'fake-model' } },
      })
    ).toThrow()
  })

  it('rejects unknown agentDefaults references', () => {
    expect(() =>
      ConfigLoader.load({
        version: '1.0',
        agents: {
          main: { extends: 'missing', model: 'fake-model' },
        },
      })
    ).toThrow(/extends references unknown agentDefaults/)
  })

  it('rejects unknown mcp server references', () => {
    expect(() =>
      ConfigLoader.load({
        version: '1.0',
        agents: {
          main: { model: 'fake-model', mcpServers: ['ghost'] },
        },
      })
    ).toThrow(/references unknown mcp server/)
  })

  it('hydrates a single agent through fakeImporter', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          main: {
            model: { provider: 'fake-model', config: { modelId: 'fm-1' } },
            sandbox: { provider: 'fake-sandbox', config: { image: 'node:20-slim' } },
          },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agent = await loader.createAgent('main')
    expect(agent.name).toBe('main')
    expect(agent.model).toBeInstanceOf(FakeModel)
    expect((agent.model as FakeModel).modelId).toBe('fm-1')
    expect(agent.sandbox).toBeInstanceOf(FakeSandbox)
  })

  it('shares component instances across agents with identical specs', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          coder: {
            model: { provider: 'fake-model', config: { modelId: 'shared' } },
            sandbox: { provider: 'fake-sandbox', config: { image: 'shared' } },
          },
          reviewer: {
            model: { provider: 'fake-model', config: { modelId: 'shared' } },
            sandbox: { provider: 'fake-sandbox', config: { image: 'shared' } },
          },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agents = await loader.createAgents()
    const coder = agents.get('coder')
    const reviewer = agents.get('reviewer')
    expect(coder).toBeDefined()
    expect(reviewer).toBeDefined()
    expect(coder!.sandbox).toBe(reviewer!.sandbox) // same instance
    expect(coder!.model).toBe(reviewer!.model)
  })

  it('does NOT share instances when configs differ', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          a: { model: { provider: 'fake-model', config: { modelId: 'm1' } } },
          b: { model: { provider: 'fake-model', config: { modelId: 'm2' } } },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agents = await loader.createAgents()
    expect(agents.get('a')!.model).not.toBe(agents.get('b')!.model)
  })

  it('applies extends from agentDefaults', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agentDefaults: {
          base: {
            model: { provider: 'fake-model', config: { modelId: 'default' } },
            maxTurns: 10,
          },
        },
        agents: {
          main: { extends: 'base', model: { provider: 'fake-model', config: { modelId: 'override' } } },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agent = await loader.createAgent('main')
    expect((agent.model as FakeModel).modelId).toBe('override')
    expect(agent.maxTurns).toBe(10)
  })

  it('migrates older component specs via fromConfigPastVersion', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          main: {
            model: { provider: 'fake-model', config: { modelId: 'm' } },
            sandbox: {
              provider: 'fake-sandbox',
              componentVersion: 1,
              config: { dockerImage: 'old-style:latest' },
            },
          },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agent = await loader.createAgent('main')
    expect((agent.sandbox as FakeSandbox).image).toBe('old-style:latest')
  })

  it('refuses to load configs newer than the installed component', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          main: {
            model: { provider: 'fake-model', config: { modelId: 'm' } },
            sandbox: {
              provider: 'fake-sandbox',
              componentVersion: 99,
              config: { image: 'future:latest' },
            },
          },
        },
      },
      { registry, importer: fakeImporter }
    )
    await expect(loader.createAgent('main')).rejects.toThrow(/upgrade the package/)
  })

  it('passes SecretRef objects through to component fromConfig (not resolved)', async () => {
    const registry = buildRegistry()
    const loader = ConfigLoader.load(
      {
        version: '1.0',
        agents: {
          main: {
            model: { provider: 'fake-model', config: { modelId: 'm' } },
            sandbox: {
              provider: 'fake-sandbox',
              config: {
                image: 'node:20',
                apiKey: { $secret: { provider: 'env', key: 'API_KEY' } },
              },
            },
          },
        },
      },
      { registry, importer: fakeImporter }
    )
    const agent = await loader.createAgent('main')
    const sb = agent.sandbox as FakeSandbox
    expect(isSecretRef(sb.apiKey)).toBe(true)
  })
})

// ─── ConfigGenerator round-trip ─────────────────────────────────────────────

describe('ConfigGenerator', () => {
  it('dumps live Configurable instances to plain ComponentSpec form', () => {
    const gen = new ConfigGenerator()
    const model = new FakeModel('m', 0.1)
    gen.addAgent('main', { model })
    const out = gen.toConfig()
    expect(out.agents.main!.model).toMatchObject({
      provider: 'test/fake.FakeModel',
      componentType: 'model',
      componentVersion: 1,
      config: { modelId: 'm', temperature: 0.1 },
    })
  })

  it('round-trips through generator → loader → generator', async () => {
    const registry = buildRegistry()

    const gen1 = new ConfigGenerator()
    gen1.addMcpServer('github', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: { $secret: { provider: 'env', key: 'GH' } } },
      disabled: false,
    })
    gen1.addAgent('main', {
      model: new FakeModel('m', 0.2),
      sandbox: new FakeSandbox('node:20-slim', new SecretRef('env', 'API_KEY')),
      tools: [],
      mcpServers: ['github'],
      maxTurns: 25,
    })

    // Serialize and re-parse — simulates writing to YAML then reading.
    const serialized = JSON.parse(gen1.toJSON())
    const loader = ConfigLoader.load(serialized, { registry, importer: fakeImporter })
    const agent = await loader.createAgent('main')

    expect((agent.model as FakeModel).modelId).toBe('m')
    expect((agent.model as FakeModel).temperature).toBe(0.2)
    expect((agent.sandbox as FakeSandbox).image).toBe('node:20-slim')
    expect(isSecretRef((agent.sandbox as FakeSandbox).apiKey)).toBe(true)
    expect(agent.maxTurns).toBe(25)
    expect(agent.mcpServers).toEqual(['github'])

    // The MCP server config still has the secret as a $secret envelope
    // (not the resolved value).
    const mcp = loader.config.mcpServers['github']
    expect(mcp).toBeDefined()
    expect(mcp!.env!.GITHUB_TOKEN).toBeInstanceOf(SecretRef)
  })

  it('refuses to add the same agent twice', () => {
    const gen = new ConfigGenerator()
    gen.addAgent('main', { model: new FakeModel('m') })
    expect(() => gen.addAgent('main', { model: new FakeModel('m') })).toThrow(/already defined/)
  })

  it('refuses values that are neither Configurable nor a ComponentSpec', () => {
    const gen = new ConfigGenerator()
    expect(() =>
      gen.addAgent('main', {
        // Force-cast to bypass TS — we want runtime validation to catch it.
        model: { foo: 'bar' } as unknown as ComponentSpec,
      })
    ).toThrow(/Configurable nor a ComponentSpec/)
  })
})

// ─── Misc helpers ───────────────────────────────────────────────────────────

describe('helpers', () => {
  it('normalizeComponentRef coerces string aliases to specs', () => {
    expect(normalizeComponentRef('bedrock')).toEqual({ provider: 'bedrock', config: {} })
    expect(normalizeComponentRef({ provider: 'bedrock', config: { modelId: 'x' } })).toEqual({
      provider: 'bedrock',
      config: { modelId: 'x' },
    })
  })

  it('isConfigurable distinguishes by dumpComponent shape', () => {
    expect(isConfigurable(new FakeModel('x'))).toBe(true)
    expect(isConfigurable({})).toBe(false)
    expect(isConfigurable(null)).toBe(false)
  })

  it('schema parses default-on optional fields', () => {
    const out = StrandsConfigSchema.parse({
      version: '1.0',
      agents: { main: { model: 'fake-model' } },
    })
    expect(out.mcpServers).toEqual({})
    expect(out.agentDefaults).toEqual({})
    expect(out.agents.main!.tools).toEqual([])
    expect(out.agents.main!.mcpServers).toEqual([])
    expect(out.agents.main!.interventions).toEqual([])
  })
})
