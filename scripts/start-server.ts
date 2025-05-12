import path from 'node:path'
import { fileURLToPath } from 'url'
import express from 'express'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'

import { initProxy, ValidationError } from '../src/init-server'

export async function startServer(args: string[] = process.argv.slice(2)) {
  // Resolve OpenAPI spec path
  const filename = fileURLToPath(import.meta.url)
  const directory = path.dirname(filename)
  const specPath = path.resolve(directory, '../scripts/notion-openapi.json')
  const baseUrl = process.env.BASE_URL ?? undefined

  // Determine SSE mode and port
  const enableSse = args.includes('--sse') || process.env.ENABLE_SSE === 'true'
  let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000
  const portIdx = args.findIndex(a => a === '--port')
  if (portIdx !== -1 && args[portIdx + 1]) {
    const p = parseInt(args[portIdx + 1], 10)
    if (!isNaN(p)) port = p
  }

  if (!enableSse) {
    // Default stdio transport for non-SSE mode
    const proxy = await initProxy(specPath, baseUrl)
    await proxy.connect(new StdioServerTransport())
    return proxy.getServer()
  }

  // SSE mode: HTTP server with Express
  const app = express()
  app.use(express.json())

  // Map session IDs to transports
  const sessions = new Map<string, SSEServerTransport>()

  // SSE handshake: client opens EventSource to /events
  app.get('/events', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/events', res)
      sessions.set(transport.sessionId, transport)
      transport.onclose = () => sessions.delete(transport.sessionId)

      // Initialize a new proxy per session
      const proxy = await initProxy(specPath, baseUrl)
      // Connect proxy to SSE transport (starts the SSE stream)
      await proxy.connect(transport)
      console.log(`SSE session ${transport.sessionId} connected`)
    } catch (err) {
      console.error('Failed to establish SSE session:', err)
      if (!res.headersSent) res.status(500).send('SSE connection error')
    }
  })

  // Receive client messages via POST
  app.post('/events', async (req, res) => {
    const sessionId = String(req.query.sessionId || '')
    const transport = sessions.get(sessionId)
    if (!transport) {
      res.status(404).send('Session not found')
      return
    }
    // Delegate to transport's POST handler (parses and forwards message)
    try {
      await transport.handlePostMessage(req, res, req.body)
    } catch (err) {
      console.error('Error handling SSE message:', err)
    }
  })

  // Start listening
  app.listen(port, () => {
    console.log(`SSE server listening at http://localhost:${port}/events`)
  })
}

startServer().catch(error => {
  if (error instanceof ValidationError) {
    console.error('Invalid OpenAPI 3.1 specification:')
    error.errors.forEach(err => console.error(err))
  } else {
    console.error('Error:', error)
  }
  process.exit(1)
})
