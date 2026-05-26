/**
 * `ConfigGenerator` — produces a YAML/JSON-serializable Strands config
 * from in-memory components.
 *
 * It walks instances that implement `Configurable.dumpComponent()` and
 * assembles a `StrandsConfigData` object. Secrets remain as `SecretRef`
 * instances and serialize via `SecretRef.toJSON()` to the `$secret`
 * envelope — round-trip-safe.
 *
 * The generator is stateless aside from the in-progress config it builds.
 * Output is plain JSON-compatible objects; the caller picks the
 * serializer (YAML, JSON, etc.) — same reason the loader doesn't bundle
 * a YAML parser.
 */

import type { StrandsConfigData, AgentSpecData, McpServerData } from './schema.js'
import { isConfigurable, type Configurable, type ComponentSpec } from './types.js'

export class ConfigGeneratorError extends Error {
  override readonly name = 'ConfigGeneratorError'
}

export class ConfigGenerator {
  private cfg: StrandsConfigData = {
    version: '1.0',
    mcpServers: {},
    agentDefaults: {},
    agents: {},
  }

  /**
   * Add a named MCP server to the top-level shared map.
   */
  addMcpServer(name: string, server: McpServerData): this {
    if (name in this.cfg.mcpServers) {
      throw new ConfigGeneratorError(`mcp server already defined: "${name}"`)
    }
    this.cfg.mcpServers[name] = server
    return this
  }

  /**
   * Add an agent. The `agent` argument carries already-dumped component
   * specs OR live `Configurable` instances — the generator dumps live
   * instances on the way in.
   */
  addAgent(name: string, agent: AgentBuildInput): this {
    if (name in this.cfg.agents) {
      throw new ConfigGeneratorError(`agent already defined: "${name}"`)
    }
    this.cfg.agents[name] = this.toSpec(agent)
    return this
  }

  private toSpec(agent: AgentBuildInput): AgentSpecData {
    const spec: AgentSpecData = {
      model: dumpRef(agent.model, 'model'),
      tools: (agent.tools ?? []).map((t, i) => dumpRef(t, `tools[${i}]`)),
      mcpServers: agent.mcpServers ?? [],
      interventions: (agent.interventions ?? []).map((iv, i) => dumpRef(iv, `interventions[${i}]`)),
    }
    if (agent.description !== undefined) spec.description = agent.description
    if (agent.systemPrompt !== undefined) spec.systemPrompt = agent.systemPrompt
    if (agent.sandbox !== undefined) spec.sandbox = dumpRef(agent.sandbox, 'sandbox')
    if (agent.conversationManager !== undefined) {
      spec.conversationManager = dumpRef(agent.conversationManager, 'conversationManager')
    }
    if (agent.maxTurns !== undefined) spec.maxTurns = agent.maxTurns
    if (agent.timeout !== undefined) spec.timeout = agent.timeout
    return spec
  }

  /**
   * Get the assembled config. The returned object is plain JSON-shape —
   * `SecretRef` instances serialize via `toJSON` when run through
   * `JSON.stringify` or any YAML library that respects `toJSON`.
   */
  toConfig(): StrandsConfigData {
    return this.cfg
  }

  /**
   * JSON serialization helper. Returns a stringified config — secrets
   * are written as `{ "$secret": { ... } }` envelopes.
   */
  toJSON(indent = 2): string {
    return JSON.stringify(this.cfg, null, indent)
  }
}

/**
 * What `addAgent` accepts — components can be live `Configurable`
 * instances OR pre-dumped `ComponentSpec` objects.
 */
export interface AgentBuildInput {
  description?: string
  model: ConfigurableInput
  tools?: ConfigurableInput[]
  mcpServers?: string[]
  sandbox?: ConfigurableInput
  conversationManager?: ConfigurableInput
  interventions?: ConfigurableInput[]
  systemPrompt?: string | { file: string }
  maxTurns?: number
  timeout?: number
}

export type ConfigurableInput = Configurable | ComponentSpec<Record<string, unknown>>

/**
 * Coerce a live `Configurable` or pre-built spec into a `ComponentSpec`.
 * Throws with a structured error path if the value is neither.
 */
function dumpRef(input: ConfigurableInput, path: string): ComponentSpec<Record<string, unknown>> {
  if (isConfigurable(input)) {
    return input.dumpComponent() as ComponentSpec<Record<string, unknown>>
  }
  if (input !== null && typeof input === 'object' && typeof (input as { provider?: unknown }).provider === 'string') {
    return input as ComponentSpec<Record<string, unknown>>
  }
  throw new ConfigGeneratorError(`path=<${path}> | value is neither Configurable nor a ComponentSpec`)
}
