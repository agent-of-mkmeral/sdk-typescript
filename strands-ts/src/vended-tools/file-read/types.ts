/**
 * Type definitions for the file read tool.
 */

import type { ImageFormat, DocumentFormat } from '../../mime.js'

/**
 * Reading mode for the file read tool.
 */
export type FileReadMode = 'text' | 'image' | 'document' | 'auto'

/**
 * Input parameters for the file read tool.
 */
export interface FileReadInput {
  /**
   * Absolute path to the file to read.
   */
  path: string

  /**
   * Reading mode. Determines how the file content is returned.
   * - text: Returns file content as plain text with line numbers
   * - image: Returns file content as an ImageBlock
   * - document: Returns file content as a DocumentBlock
   * - auto: Automatically detects the appropriate mode from file extension
   */
  mode?: FileReadMode

  /**
   * Starting line number for text mode (1-indexed).
   */
  start_line?: number

  /**
   * Ending line number for text mode (1-indexed, -1 for end of file).
   */
  end_line?: number
}

/**
 * Mapping from file extensions to image formats.
 */
export const IMAGE_EXTENSIONS: Record<string, ImageFormat> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
}

/**
 * Mapping from file extensions to document formats.
 */
export const DOCUMENT_EXTENSIONS: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.doc': 'doc',
  '.docx': 'docx',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'txt',
  '.md': 'md',
  '.json': 'json',
  '.xml': 'xml',
}
