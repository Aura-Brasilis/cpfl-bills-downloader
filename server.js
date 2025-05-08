import express from 'express'
import cors from 'cors'
import http from 'http'
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptPath = path.resolve(__dirname, 'script.js');

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

let currentClient = null
let isRunning = false
let currentProcess = null

const send = (type, payload) => {
    currentClient && currentClient.send(JSON.stringify({ type, payload }))
}

app.use(cors())

app.get('/status-script', (req, res) => {
  return res.json({ isRunning })
})

app.post('/exec-script', (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Script already executing' })
  if (!currentClient || currentClient.readyState !== currentClient.OPEN)
    return res.status(400).json({ error: 'Client not found in websocket' })

  isRunning = true
  send('status', 'executando')
  res.json({ status: 'Executing script' })

  currentProcess = spawn('node', [scriptPath])

  currentProcess.stdout.on('data', (data) => {
    console.log(data.toString())
    send('log', data.toString())
  })

  currentProcess.stderr.on('data', (data) => {
    console.error(data.toString())
    send('log', + data.toString())
  })

  currentProcess.on('close', (code) => {
    send('status', code === 0 ? 'finalizado' : 'erro')
    isRunning = false
    currentProcess = null
  })
})

app.post('/cancel-script', (req, res) => {
  if (isRunning && currentProcess) {
    const killed = currentProcess.kill()
    if (killed) {
      send('log', 'Exec canceled by user')
      send('status', 'cancelado')
    }
    res.json({ status: killed ? 'canceled' : 'Not able to cancel' })
  } else {
    res.status(400).json({ error: 'Proccess in execution not found' })
  }
})

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket')
  currentClient = ws
  ws.on('close', () => {
    console.log('Client disconnected')
    if (currentClient === ws) currentClient = null
  })
})

server.listen(3000, () => {
  console.log('API Listening on PORT: 3000')
})