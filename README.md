# 💸 WhatsApp AI Financial Tracker

Un sistema automatizado e inteligente para el registro de finanzas personales. Permite enviar mensajes en lenguaje natural a través de WhatsApp para registrar gastos e ingresos, procesarlos mediante Inteligencia Artificial (LLMs) y almacenarlos estructuradamente en Google Sheets de forma automática.

## 🚀 Arquitectura del Proyecto

Este proyecto no es solo un bot, es una arquitectura de microservicios orientada a eventos, diseñada para funcionar 24/7 en la nube:

1. **Interfaz de Usuario (WhatsApp):** El usuario envía un mensaje natural (ej. `"#gasto 45000 almuerzo en San Marcos"`).
2. **Backend (Node.js + Baileys):** Un microservicio alojado en Render escucha los mensajes en tiempo real. Utiliza MongoDB Atlas para persistir la sesión de WhatsApp (evitando re-escaneos de QR).
3. **Orquestador (n8n):** El backend envía el mensaje vía Webhook a n8n, que actúa como el motor lógico del flujo.
4. **Procesamiento IA (Groq API + Qwen):** n8n realiza una petición HTTP al modelo `qwen3.8-27b` a través de Groq. La IA extrae el contexto (monto, descripción, tipo) y fuerza una salida en formato JSON puro.
5. **Almacenamiento (Google Sheets):** n8n parsea el JSON y añade una nueva fila al instante en una hoja de cálculo estructurada.

## 🛠️ Tecnologías No-Backend (Integraciones & IA)

*   **[n8n](https://n8n.io/):** Automatización del flujo de trabajo y orquestación de APIs.
*   **[Groq API](https://groq.com/):** Inferencia ultra-rápida de LLMs mediante chips LPU.
*   **Qwen3.8-27b:** Modelo LLM utilizado por su alta precisión para retornar estructuras JSON válidas sin alucinaciones de formato (Prompt Engineering).
*   **Google Sheets API:** Base de datos final para fácil visualización y futura analítica.

## ⚙️ Configuración del Flujo en n8n

Para replicar la lógica de negocio en n8n, el flujo consta de los siguientes nodos:

1. **Webhook:** Configurado para escuchar peticiones `POST` desde el backend.
2. **HTTP Request (Llamada al LLM):** 
   * Método: `POST` a `https://api.groq.com/openai/v1/chat/completions`
   * Prompt (System): *"Extrae del mensaje el monto, la descripción y el tipo. Devuelve ÚNICAMENTE un objeto JSON válido con las claves: 'monto', 'descripcion', 'tipo'."*
   * Datos: `{{ $json.body.texto }}`
3. **Google Sheets (Append Row):**
   * Mapeo dinámico convirtiendo el string JSON a objeto: `JSON.parse($json.choices[0].message.content).monto`
   * Marca de tiempo inyectada vía Luxon: `{{ $now.setZone('America/Bogota').toFormat('yyyy-MM-dd') }}`

---

## 🧩 Tecnologías Backend

* **Node.js:** Runtime para ejecutar el microservicio y gestionar la conexión con WhatsApp.
* **Express:** Servidor HTTP utilizado para el healthcheck de Render y para exponer la interfaz web del código QR.
* **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys):** Cliente WebSocket que conecta el backend con WhatsApp y recibe eventos de mensajes en tiempo real.
* **[Mongoose](https://mongoosejs.com/) / MongoDB Atlas:** Persistencia de las credenciales (`creds`) y claves criptográficas (`keys`) de Baileys. Esto permite recuperar la sesión después de reinicios o despliegues.
* **[qrcode](https://www.npmjs.com/package/qrcode):** Convierte el QR generado por Baileys en una imagen Base64 que se muestra desde la ruta HTTP principal.
* **Axios:** Cliente HTTP utilizado para enviar los mensajes filtrados al webhook de n8n.
* **Pino y pino-pretty:** Logging estructurado y legible para monitorear el servicio.

## 🔐 Variables de Entorno (`.env`)

El backend requiere un archivo `.env` en desarrollo local. En Render, estas variables deben configurarse desde **Environment Variables** del Web Service.

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `MONGODB_URI` | Sí | Cadena de conexión de MongoDB Atlas. Se utiliza para guardar y recuperar la sesión de Baileys en la colección `whatsapp_auth`. |
| `N8N_WEBHOOK_URL` | No, pero necesaria para enviar datos | URL completa del nodo Webhook de n8n que recibe los movimientos financieros. |
| `PORT` | No | Puerto HTTP del servicio. Render lo proporciona automáticamente; localmente se utiliza `3000` si no se define. |
| `LOG_LEVEL` | No | Nivel de logging de Pino. Por defecto es `info`. |

Ejemplo:

```env
MONGODB_URI=mongodb+srv://usuario:password@cluster.mongodb.net/whatsapp_tracker
N8N_WEBHOOK_URL=https://n8n.example.com/webhook/registrar-movimiento
PORT=3000
LOG_LEVEL=info
```
