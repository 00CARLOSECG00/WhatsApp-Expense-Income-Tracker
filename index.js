import 'dotenv/config'

import express from 'express'
import mongoose from 'mongoose'
import axios from 'axios'
import pino from 'pino'
import pretty from 'pino-pretty'
import qrcode from 'qrcode'
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto
} from '@whiskeysockets/baileys'

const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pretty({ colorize: false, translateTime: false })
)
const app = express()
const port = Number(process.env.PORT) || 3000
let qrImage = ''
let isConnected = false

app.get('/', (_request, response) => {
  if (isConnected) {
    return response.status(200).send('<h1>WhatsApp Conectado y escuchando!</h1>')
  }

  if (qrImage) {
    return response.status(200).send(`<img src="${qrImage}" style="width: 300px; height: 300px;" />`)
  }

  return response.status(200).send('<h1>Generando QR, recarga en unos segundos...</h1>')
})

const authDocumentSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    data: { type: String, required: true }
  },
  { collection: 'whatsapp_auth', versionKey: false }
)

const authDocumentModel = mongoose.models.WhatsAppAuth || mongoose.model('WhatsAppAuth', authDocumentSchema)

function serialize(value) {
  return JSON.stringify(value, BufferJSON.replacer)
}

function deserialize(value) {
  return JSON.parse(value, BufferJSON.reviver)
}

async function useMongoDBAuthState() {
  const credentialsDocument = await authDocumentModel.findById('creds').lean()
  const creds = credentialsDocument ? deserialize(credentialsDocument.data) : initAuthCreds()

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore({
        get: async (type, ids) => {
          const documents = await authDocumentModel
            .find({ _id: { $in: ids.map((id) => `${type}-${id}`) } })
            .lean()

          return ids.reduce((result, id) => {
            const document = documents.find((item) => item._id === `${type}-${id}`)
            if (document) {
              let value = deserialize(document.data)
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              result[id] = value
            }
            return result
          }, {})
        },
        set: async (data) => {
          const operations = []

          for (const [type, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values)) {
              const documentId = `${type}-${id}`
              if (value === null || value === undefined) {
                operations.push({ deleteOne: { filter: { _id: documentId } } })
              } else {
                operations.push({
                  updateOne: {
                    filter: { _id: documentId },
                    update: { $set: { data: serialize(value) } },
                    upsert: true
                  }
                })
              }
            }
          }

          if (operations.length > 0) {
            await authDocumentModel.bulkWrite(operations)
          }
        }
      }, logger)
    },
    saveCreds: async () => {
      await authDocumentModel.updateOne(
        { _id: 'creds' },
        { $set: { data: serialize(creds) } },
        { upsert: true }
      )
    }
  }
}

function getMessageText(message) {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    ''
  )
}

function getSenderNumber(message) {
  const senderJid = message.key.participant || message.key.participantAlt || ''
  return senderJid.split('@')[0].split(':')[0]
}

async function sendToN8n(message, text, tipoOperacion) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL
  if (!webhookUrl) {
    logger.warn('N8N_WEBHOOK_URL no está configurada; se omite el webhook')
    return
  }

  const idDelGrupo = message.key.remoteJid
  await axios.post(webhookUrl, {
    textoDelMensaje: text,
    numeroRemitente: getSenderNumber(message),
    idDelGrupo,
    tipoOperacion
  })
}

async function handleMessagesUpsert({ messages }) {
  for (const message of messages) {
    const groupId = message.key.remoteJid || ''
    if (!groupId.endsWith('@g.us')) {
      continue
    }

    const text = getMessageText(message)
    const match = text.match(/^#(gasto|ingreso)\b/i)
    if (!match) {
      continue
    }

    const tipoOperacion = match[1].toLowerCase()
    try {
      await sendToN8n(message, text, tipoOperacion)
      logger.info({ groupId, tipoOperacion }, 'Mensaje enviado a n8n')
    } catch (error) {
      logger.error({ err: error, groupId }, 'No se pudo enviar el mensaje a n8n')
    }
  }
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMongoDBAuthState()
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('WhatsApp Expense Income Tracker'),
    logger,
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.upsert', handleMessagesUpsert)
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.toDataURL(qr)
        .then((image) => {
          qrImage = image
        })
        .catch((error) => logger.error({ err: error }, 'No se pudo generar la imagen del QR'))
    }

    if (connection === 'open') {
      isConnected = true
      logger.info('WhatsApp conectado')
    }

    if (connection === 'close') {
      isConnected = false
      qrImage = ''
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      logger.warn({ statusCode, shouldReconnect }, 'Conexión de WhatsApp cerrada')
      if (shouldReconnect) {
        startWhatsApp().catch((error) => logger.error({ err: error }, 'Error al reconectar WhatsApp'))
      }
    }
  })
}

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI es obligatoria')
  }

  await mongoose.connect(process.env.MONGODB_URI)
  logger.info('MongoDB conectado')
  app.listen(port, () => logger.info({ port }, 'Healthcheck disponible'))
  await startWhatsApp()
}

start().catch((error) => {
  logger.error({ err: error }, 'No se pudo iniciar el servicio')
  process.exitCode = 1
})