import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { promises as fs } from 'fs'
import * as path from 'path'
import { ImageBlock } from '../../types/media.js'
import { DocumentBlock } from '../../types/media.js'
import type { ImageFormat, DocumentFormat } from '../../mime.js'
import { IMAGE_EXTENSIONS, DOCUMENT_EXTENSIONS } from './types.js'
import type { JSONValue } from '../../types/json.js'

const DEFAULT_MAX_FILE_SIZE = 20971520 // 20MB for binary files
const DEFAULT_MAX_TEXT_FILE_SIZE = 1048576 // 1MB for text files

/**
 * Zod schema for file read input validation.
 */
const fileReadInputSchema = z.object({
  path: z.string().describe('Absolute path to the file to read.'),
  mode: z
    .enum(['text', 'image', 'document', 'auto'])
    .optional()
    .describe(
      'Reading mode: `text` returns content as plain text, `image` returns an ImageBlock, ' +
        '`document` returns a DocumentBlock, `auto` detects from file extension. Defaults to `auto`.'
    ),
  start_line: z.number().optional().describe('Starting line number for text mode (1-indexed).'),
  end_line: z.number().optional().describe('Ending line number for text mode (1-indexed, -1 for end of file).'),
})

/**
 * Detects the reading mode from a file extension.
 *
 * @param filePath - Path to the file
 * @returns Detected mode based on extension
 */
function detectMode(filePath: string): 'text' | 'image' | 'document' {
  const ext = path.extname(filePath).toLowerCase()
  if (ext in IMAGE_EXTENSIONS) return 'image'
  if (ext in DOCUMENT_EXTENSIONS) return 'document'
  return 'text'
}

/**
 * Validates that a path is absolute and safe.
 *
 * @param filePath - Path to validate
 */
function validatePath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    const suggestedPath = path.resolve(filePath)
    throw new Error(
      `The path ${filePath} is not an absolute path, it should start with \`/\`. Maybe you meant ${suggestedPath}?`
    )
  }
  // Check raw input for traversal attempts before normalization resolves them
  if (filePath.includes('..')) {
    throw new Error('Invalid path: path traversal is not allowed')
  }
}

/**
 * Reads a file as text and returns formatted content with line numbers.
 *
 * @param filePath - Path to the file
 * @param startLine - Optional start line (1-indexed)
 * @param endLine - Optional end line (1-indexed, -1 for end)
 * @returns Formatted text content
 */
async function readAsText(filePath: string, startLine?: number, endLine?: number): Promise<string> {
  const stats = await fs.stat(filePath)
  if (stats.size > DEFAULT_MAX_TEXT_FILE_SIZE) {
    throw new Error(
      `File size (${stats.size} bytes) exceeds maximum allowed size for text mode (${DEFAULT_MAX_TEXT_FILE_SIZE} bytes)`
    )
  }

  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const nLines = lines.length

  let initLine = 1
  let selectedLines = lines

  if (startLine !== undefined || endLine !== undefined) {
    const start = startLine ?? 1
    const end = endLine ?? nLines

    if (start < 1 || start > nLines) {
      throw new Error(`Invalid \`start_line\`: ${start}. Must be within [1, ${nLines}]`)
    }

    if (end !== -1 && end > nLines) {
      throw new Error(`Invalid \`end_line\`: ${end}. Must be within [1, ${nLines}] or -1 for end of file`)
    }

    if (end !== -1 && end < start) {
      throw new Error(`Invalid range: \`end_line\` (${end}) cannot be less than \`start_line\` (${start})`)
    }

    initLine = start
    if (end === -1) {
      selectedLines = lines.slice(start - 1)
    } else {
      selectedLines = lines.slice(start - 1, end)
    }
  }

  const numberedLines = selectedLines.map((line, index) => {
    const lineNum = index + initLine
    return `${lineNum.toString().padStart(6)}  ${line}`
  })

  return `Here's the result of running \`cat -n\` on ${filePath}:\n${numberedLines.join('\n')}\n`
}

/**
 * Reads a file as an image and returns an ImageBlock.
 *
 * @param filePath - Path to the image file
 * @returns ImageBlock containing the image data
 */
async function readAsImage(filePath: string): Promise<ImageBlock> {
  const ext = path.extname(filePath).toLowerCase()
  const format = IMAGE_EXTENSIONS[ext] as ImageFormat | undefined

  if (!format) {
    const supported = Object.keys(IMAGE_EXTENSIONS).join(', ')
    throw new Error(`Unsupported image format: ${ext}. Supported formats: ${supported}`)
  }

  const stats = await fs.stat(filePath)
  if (stats.size > DEFAULT_MAX_FILE_SIZE) {
    throw new Error(`File size (${stats.size} bytes) exceeds maximum allowed size (${DEFAULT_MAX_FILE_SIZE} bytes)`)
  }

  const bytes = await fs.readFile(filePath)

  return new ImageBlock({
    format,
    source: { bytes: new Uint8Array(bytes) },
  })
}

/**
 * Reads a file as a document and returns a DocumentBlock.
 *
 * @param filePath - Path to the document file
 * @returns DocumentBlock containing the document data
 */
async function readAsDocument(filePath: string): Promise<DocumentBlock> {
  const ext = path.extname(filePath).toLowerCase()
  const format = DOCUMENT_EXTENSIONS[ext] as DocumentFormat | undefined

  if (!format) {
    const supported = Object.keys(DOCUMENT_EXTENSIONS).join(', ')
    throw new Error(`Unsupported document format: ${ext}. Supported formats: ${supported}`)
  }

  const stats = await fs.stat(filePath)
  if (stats.size > DEFAULT_MAX_FILE_SIZE) {
    throw new Error(`File size (${stats.size} bytes) exceeds maximum allowed size (${DEFAULT_MAX_FILE_SIZE} bytes)`)
  }

  const bytes = await fs.readFile(filePath)
  const baseName = path.basename(filePath, ext)

  return new DocumentBlock({
    name: baseName,
    format,
    source: { bytes: new Uint8Array(bytes) },
  })
}

/**
 * File read tool for reading files in multiple formats (text, image, document).
 *
 * Extends file reading beyond plain text to support images and documents,
 * returning appropriate content blocks that can be processed by multimodal models.
 *
 * @example
 * ```typescript
 * import { fileRead } from '@strands-agents/sdk/vended-tools/file-read'
 * import { Agent } from '@strands-agents/sdk'
 *
 * const agent = new Agent({
 *   model: new BedrockModel({ region: 'us-east-1' }),
 *   tools: [fileRead],
 * })
 *
 * await agent.invoke('Read the image at /tmp/screenshot.png')
 * await agent.invoke('Read the PDF document at /tmp/report.pdf')
 * await agent.invoke('Show me the contents of /tmp/config.json')
 * ```
 */
export const fileRead = tool({
  name: 'fileRead',
  description:
    'Reads files and returns content in the appropriate format. ' +
    'Supports text files (returned as plain text with line numbers), ' +
    'image files (png, jpg, gif, webp — returned as image content blocks), ' +
    'and document files (pdf, csv, doc, docx, xls, xlsx, html, txt, md — returned as document content blocks). ' +
    'Use `mode` to explicitly choose the format, or omit it to auto-detect from file extension.',
  inputSchema: fileReadInputSchema,
  callback: async (input): Promise<JSONValue> => {
    validatePath(input.path)

    const exists = await fs
      .access(input.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      throw new Error(`The path ${input.path} does not exist. Please provide a valid path.`)
    }

    const stat = await fs.stat(input.path)
    if (stat.isDirectory()) {
      throw new Error(`The path ${input.path} is a directory. Please provide a file path.`)
    }

    const resolvedMode = input.mode === undefined || input.mode === 'auto' ? detectMode(input.path) : input.mode

    switch (resolvedMode) {
      case 'text':
        return readAsText(input.path, input.start_line, input.end_line)

      case 'image':
        return readAsImage(input.path) as unknown as JSONValue

      case 'document':
        return readAsDocument(input.path) as unknown as JSONValue

      default:
        throw new Error(`Unknown mode: ${resolvedMode}`)
    }
  },
})
