# File Read Tool

A file reading tool that supports multiple content types — text, images, and documents — returning the appropriate content blocks for multimodal AI model processing.

## Features

- **Text mode**: Read files as plain text with line numbers and optional line range support
- **Image mode**: Read image files (PNG, JPEG, GIF, WebP) and return as `ImageBlock`
- **Document mode**: Read document files (PDF, CSV, DOC, DOCX, XLS, XLSX, HTML, TXT, MD) and return as `DocumentBlock`
- **Auto-detection**: Automatically detects the appropriate mode from file extension
- **Size limits**: 1MB for text files, 20MB for binary files (images/documents)

## Installation

```typescript
import { fileRead } from '@strands-agents/sdk/vended-tools/file-read'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ region: 'us-east-1' }),
  tools: [fileRead],
})

await agent.invoke('Read the image at /tmp/screenshot.png and describe it')
await agent.invoke('Read the PDF at /tmp/report.pdf and summarize it')
```

## Parameters

- `path` (string, required): Absolute path to the file to read
- `mode` (optional): Reading mode — `text`, `image`, `document`, or `auto` (default: `auto`)
- `start_line` (optional): Starting line number for text mode (1-indexed)
- `end_line` (optional): Ending line number for text mode (1-indexed, -1 for end of file)

## Modes

### `auto` (default)

Detects the reading mode from the file extension:

- Image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) → image mode
- Document extensions (`.pdf`, `.csv`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.html`, `.txt`, `.md`) → document mode
- All other extensions → text mode

### `text`

Returns file content as plain text with line numbers (similar to `cat -n`).

### `image`

Returns an `ImageBlock` containing the raw image bytes, suitable for multimodal model processing.

### `document`

Returns a `DocumentBlock` containing the raw document bytes, suitable for document understanding models.

## Example Usage

```typescript
import { fileRead } from '@strands-agents/sdk/vended-tools/file-read'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ region: 'us-east-1' }),
  tools: [fileRead],
})

// Auto-detect mode from extension
await agent.invoke('Read /tmp/diagram.png and explain what it shows')
await agent.invoke('Summarize the document at /tmp/contract.pdf')
await agent.invoke('Show me lines 10-20 of /tmp/app.ts')
```

## Security

- Requires absolute paths (must start with `/`)
- Blocks directory traversal attempts (`..`)
- File size limits enforced
- Clear error messages for invalid inputs

## Limitations

- Node.js only (uses filesystem APIs)
- Image mode supports only PNG, JPEG, GIF, WebP
- Document mode supports only PDF, CSV, DOC, DOCX, XLS, XLSX, HTML, TXT, MD
