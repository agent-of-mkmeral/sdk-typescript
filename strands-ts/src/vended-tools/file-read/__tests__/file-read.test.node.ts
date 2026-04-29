import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Buffer } from 'buffer'
import { fileRead } from '../file-read.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { promises as fs } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { ImageBlock, DocumentBlock } from '../../../types/media.js'

describe('fileRead tool', () => {
  let testDir: string
  let context: ToolContext

  const createFreshContext = (): { context: ToolContext } => {
    const agent = createMockAgent()
    const toolContext: ToolContext = {
      toolUse: {
        name: 'fileRead',
        toolUseId: 'test-id',
        input: {},
      },
      agent,
      invocationState: {},
    }
    return { context: toolContext }
  }

  const createTestFile = async (filename: string, content: string | Buffer): Promise<string> => {
    const filePath = path.join(testDir, filename)
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, content)
    return filePath
  }

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `file-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })
    const fresh = createFreshContext()
    context = fresh.context
  })

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('text mode', () => {
    it('reads file content with line numbers', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      const result = await fileRead.invoke({ path: filePath, mode: 'text' }, context)
      expect(result).toContain("Here's the result of running `cat -n`")
      expect(result).toContain('     1  Line 1')
      expect(result).toContain('     2  Line 2')
      expect(result).toContain('     3  Line 3')
    })

    it('handles empty file', async () => {
      const filePath = await createTestFile('empty.txt', '')
      const result = await fileRead.invoke({ path: filePath, mode: 'text' }, context)
      expect(result).toContain("Here's the result of running `cat -n`")
      expect(result).toContain('     1  ')
    })

    it('reads specific line range', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
      const result = await fileRead.invoke({ path: filePath, mode: 'text', start_line: 2, end_line: 4 }, context)
      expect(result).toContain('     2  Line 2')
      expect(result).toContain('     3  Line 3')
      expect(result).toContain('     4  Line 4')
      expect(result).not.toContain('     1  ')
      expect(result).not.toContain('     5  ')
    })

    it('reads from start_line to end with end_line=-1', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
      const result = await fileRead.invoke({ path: filePath, mode: 'text', start_line: 3, end_line: -1 }, context)
      expect(result).toContain('     3  Line 3')
      expect(result).toContain('     4  Line 4')
      expect(result).toContain('     5  Line 5')
      expect(result).not.toContain('     1  ')
      expect(result).not.toContain('     2  ')
    })

    it('throws when start_line is out of range', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      await expect(fileRead.invoke({ path: filePath, mode: 'text', start_line: 0 }, context)).rejects.toThrow(
        'start_line'
      )
    })

    it('throws when end_line exceeds file length', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      await expect(
        fileRead.invoke({ path: filePath, mode: 'text', start_line: 1, end_line: 10 }, context)
      ).rejects.toThrow('end_line')
    })

    it('throws when end_line is less than start_line', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      await expect(
        fileRead.invoke({ path: filePath, mode: 'text', start_line: 3, end_line: 1 }, context)
      ).rejects.toThrow('end_line')
    })

    it('throws for text files exceeding size limit', async () => {
      const largeContent = 'x'.repeat(1048577)
      const filePath = await createTestFile('large.txt', largeContent)
      await expect(fileRead.invoke({ path: filePath, mode: 'text' }, context)).rejects.toThrow('exceeds')
    })
  })

  describe('image mode', () => {
    it('reads PNG file and returns ImageBlock', async () => {
      // Minimal valid PNG (1x1 pixel, transparent)
      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
          '0000000a49444154789c626000000002000198e7399f0000000049454e44ae426082',
        'hex'
      )
      const filePath = await createTestFile('test.png', pngBytes)
      const result = await fileRead.invoke({ path: filePath, mode: 'image' }, context)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as unknown as ImageBlock).format).toBe('png')
      expect((result as unknown as ImageBlock).source.type).toBe('imageSourceBytes')
    })

    it('reads JPEG file and returns ImageBlock', async () => {
      // Minimal JPEG header
      const jpegBytes = Buffer.from(
        'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc40000ffd9',
        'hex'
      )
      const filePath = await createTestFile('test.jpg', jpegBytes)
      const result = await fileRead.invoke({ path: filePath, mode: 'image' }, context)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as unknown as ImageBlock).format).toBe('jpeg')
    })

    it('throws for unsupported image format', async () => {
      const filePath = await createTestFile('test.bmp', Buffer.from('BM'))
      await expect(fileRead.invoke({ path: filePath, mode: 'image' }, context)).rejects.toThrow(
        'Unsupported image format'
      )
    })

    it('throws for image files exceeding size limit', async () => {
      const largeContent = Buffer.alloc(20971521)
      const filePath = await createTestFile('large.png', largeContent)
      await expect(fileRead.invoke({ path: filePath, mode: 'image' }, context)).rejects.toThrow('exceeds')
    })
  })

  describe('document mode', () => {
    it('reads PDF file and returns DocumentBlock', async () => {
      // Minimal PDF content
      const pdfContent = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')
      const filePath = await createTestFile('report.pdf', pdfContent)
      const result = await fileRead.invoke({ path: filePath, mode: 'document' }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as unknown as DocumentBlock).format).toBe('pdf')
      expect((result as unknown as DocumentBlock).name).toBe('report')
      expect((result as unknown as DocumentBlock).source.type).toBe('documentSourceBytes')
    })

    it('reads CSV file and returns DocumentBlock', async () => {
      const csvContent = 'name,age\nAlice,30\nBob,25'
      const filePath = await createTestFile('data.csv', csvContent)
      const result = await fileRead.invoke({ path: filePath, mode: 'document' }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as unknown as DocumentBlock).format).toBe('csv')
      expect((result as unknown as DocumentBlock).name).toBe('data')
    })

    it('reads DOCX file and returns DocumentBlock', async () => {
      const filePath = await createTestFile('doc.docx', Buffer.from('PK\x03\x04'))
      const result = await fileRead.invoke({ path: filePath, mode: 'document' }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as unknown as DocumentBlock).format).toBe('docx')
    })

    it('throws for unsupported document format', async () => {
      const filePath = await createTestFile('test.xyz', Buffer.from('data'))
      await expect(fileRead.invoke({ path: filePath, mode: 'document' }, context)).rejects.toThrow(
        'Unsupported document format'
      )
    })

    it('throws for document files exceeding size limit', async () => {
      const largeContent = Buffer.alloc(20971521)
      const filePath = await createTestFile('large.pdf', largeContent)
      await expect(fileRead.invoke({ path: filePath, mode: 'document' }, context)).rejects.toThrow('exceeds')
    })
  })

  describe('auto mode', () => {
    it('auto-detects PNG as image', async () => {
      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
          '0000000a49444154789c626000000002000198e7399f0000000049454e44ae426082',
        'hex'
      )
      const filePath = await createTestFile('photo.png', pngBytes)
      const result = await fileRead.invoke({ path: filePath }, context)
      expect(result).toBeInstanceOf(ImageBlock)
    })

    it('auto-detects PDF as document', async () => {
      const filePath = await createTestFile('report.pdf', Buffer.from('%PDF-1.4'))
      const result = await fileRead.invoke({ path: filePath }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
    })

    it('auto-detects .txt as text', async () => {
      const filePath = await createTestFile('notes.txt', 'Hello World')
      const result = await fileRead.invoke({ path: filePath, mode: 'auto' }, context)
      // .txt is in DOCUMENT_EXTENSIONS, so it returns DocumentBlock
      expect(result).toBeInstanceOf(DocumentBlock)
    })

    it('auto-detects unknown extension as text', async () => {
      const filePath = await createTestFile('config.ini', 'key=value')
      const result = await fileRead.invoke({ path: filePath }, context)
      expect(typeof result).toBe('string')
      expect(result).toContain('key=value')
    })

    it('auto-detects .py as text', async () => {
      const filePath = await createTestFile('script.py', 'print("hello")')
      const result = await fileRead.invoke({ path: filePath }, context)
      expect(typeof result).toBe('string')
      expect(result).toContain('print("hello")')
    })
  })

  describe('path validation and security', () => {
    it('rejects relative paths', async () => {
      await expect(fileRead.invoke({ path: 'relative/path.txt' }, context)).rejects.toThrow('not an absolute path')
    })

    it('rejects paths with traversal', async () => {
      await expect(fileRead.invoke({ path: '/tmp/../etc/passwd' }, context)).rejects.toThrow('path traversal')
    })

    it('throws when file does not exist', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.txt')
      await expect(fileRead.invoke({ path: nonExistentPath }, context)).rejects.toThrow('does not exist')
    })

    it('throws when path is a directory', async () => {
      await expect(fileRead.invoke({ path: testDir }, context)).rejects.toThrow('is a directory')
    })
  })

  describe('edge cases', () => {
    it('handles files with unicode content in text mode', async () => {
      const content = '你好世界\n🚀 Emoji test\nΣ Greek letters'
      const filePath = await createTestFile('unicode.txt', content)
      const result = await fileRead.invoke({ path: filePath, mode: 'text' }, context)
      expect(result).toContain('你好世界')
      expect(result).toContain('🚀')
    })

    it('handles .webp images', async () => {
      // Minimal WebP header (RIFF....WEBP)
      const webpBytes = Buffer.from('524946462400000057454250', 'hex')
      const filePath = await createTestFile('image.webp', webpBytes)
      const result = await fileRead.invoke({ path: filePath, mode: 'image' }, context)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as unknown as ImageBlock).format).toBe('webp')
    })

    it('handles .gif images', async () => {
      // Minimal GIF header
      const gifBytes = Buffer.from('474946383961', 'hex')
      const filePath = await createTestFile('image.gif', gifBytes)
      const result = await fileRead.invoke({ path: filePath, mode: 'image' }, context)
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as unknown as ImageBlock).format).toBe('gif')
    })

    it('reads .html as document', async () => {
      const htmlContent = '<html><body><h1>Hello</h1></body></html>'
      const filePath = await createTestFile('page.html', htmlContent)
      const result = await fileRead.invoke({ path: filePath, mode: 'document' }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as unknown as DocumentBlock).format).toBe('html')
    })

    it('reads .md as document', async () => {
      const mdContent = '# Title\n\nSome content'
      const filePath = await createTestFile('readme.md', mdContent)
      const result = await fileRead.invoke({ path: filePath, mode: 'document' }, context)
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as unknown as DocumentBlock).format).toBe('md')
    })
  })
})
