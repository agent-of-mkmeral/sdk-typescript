/**
 * Zod schemas for the top-level Strands config file.
 *
 * The schema is **single-shape**: there is no `single-agent` vs `multi-agent`
 * mode. Every config has an `agents` map. The simple case is `agents.main`,
 * which `Agent.fromConfig()` can sugar over.
 *
 * Components within the config are `ComponentSpec` objects (provider string
 * + config payload), so customer-defined components don't need to be added
 * to the schema — Zod is permissive about the inner `config` payload, and
 * the component's own `fromConfig` validates its specific fields.
 */

import { z } from 'zod'

/**
 * Component spec — any configurable instance in the YAML.
 * The inner `config` is intentionally `unknown`-typed: validation of the
 * specific shape is the component's own responsibility (its `fromConfig`
 * receives the raw config payload).
 */
export const ComponentSpecSchema = z.object({
  provider: z.string().min(1),
  componentType: z.string().optional(),
  componentVersion: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

/** A `ComponentSpec` OR a short alias string (sugar for `{ provider: "alias", config: {} }`). */
export const ComponentRefSchema = z.union([z.string().min(1), ComponentSpecSchema])

/**
 * MCP server config — purpose-built (not a generic ComponentSpec) because
 * MCP servers are launched as external processes, not Configurable classes.
 */
export const McpServerSchema = z
  .object({
    transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.unknown()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    toolFilter: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .optional(),
    disabled: z.boolean().default(false),
  })
  .strict()

/**
 * Per-agent config.
 *
 * Note: `mcpServers` is a string-array of refs to top-level named MCP
 * servers. There is no inline form — keep one way to do things.
 *
 * `extends` lets an agent inherit defaults from another (declared in
 * `agentDefaults`) instead of array-append override semantics.
 */
export const AgentSpecSchema = z
  .object({
    extends: z.string().optional(),
    description: z.string().optional(),
    model: ComponentRefSchema,
    systemPrompt: z.union([z.string(), z.object({ file: z.string() })]).optional(),
    tools: z.array(ComponentRefSchema).default([]),
    mcpServers: z.array(z.string()).default([]),
    sandbox: ComponentRefSchema.optional(),
    conversationManager: ComponentRefSchema.optional(),
    interventions: z.array(ComponentRefSchema).default([]),
    maxTurns: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict()

/**
 * The top-level Strands config.
 *
 * Single shape — there is always an `agents` map. The 90% case is just
 * `agents.main`. `Agent.fromConfig()` can pluck that for the simple call
 * site.
 */
export const StrandsConfigSchema = z
  .object({
    /** Spec version of the YAML schema itself. */
    version: z.literal('1.0'),
    mcpServers: z.record(z.string(), McpServerSchema).default({}),
    /** Reusable agent fragments referenced via `agents.*.extends`. */
    agentDefaults: z.record(z.string(), AgentSpecSchema.partial()).default({}),
    agents: z.record(z.string(), AgentSpecSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Validate every `agents.*.extends` ref points to a real agentDefaults entry.
    for (const [agentName, agent] of Object.entries(cfg.agents)) {
      if (agent.extends && !(agent.extends in cfg.agentDefaults)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', agentName, 'extends'],
          message: `agents.${agentName}.extends references unknown agentDefaults: "${agent.extends}"`,
        })
      }
      // Validate every mcpServers ref points to a real top-level MCP server.
      for (const ref of agent.mcpServers) {
        if (!(ref in cfg.mcpServers)) {
          ctx.addIssue({
            code: 'custom',
            path: ['agents', agentName, 'mcpServers'],
            message: `agents.${agentName}.mcpServers references unknown mcp server: "${ref}"`,
          })
        }
      }
    }
  })

export type ComponentSpecData = z.infer<typeof ComponentSpecSchema>
export type ComponentRefData = z.infer<typeof ComponentRefSchema>
export type AgentSpecData = z.infer<typeof AgentSpecSchema>
export type StrandsConfigData = z.infer<typeof StrandsConfigSchema>
export type McpServerData = z.infer<typeof McpServerSchema>

/**
 * Coerce a `ComponentRefData` (string alias or full spec) to a normalized
 * `ComponentSpecData` so downstream code only deals with one shape.
 */
export function normalizeComponentRef(ref: ComponentRefData): ComponentSpecData {
  if (typeof ref === 'string') {
    return { provider: ref, config: {} }
  }
  return ref
}
