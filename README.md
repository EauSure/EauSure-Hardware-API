# Water Quality Monitor API

Backend API for the water quality monitoring platform.

This service receives telemetry from the gateway, stores it in MongoDB, publishes live updates over MQTT, and manages gateway and IoT node registration, provisioning, pairing, and command delivery.

## High-Level Flow

```text
                           +----------------------+
                           |   Web / Mobile App   |
                           |  JWT-authenticated   |
                           +----------+-----------+
                                      |
                                      | manage gateways, nodes,
                                      | confirm pairing
                                      v
+-------------+               +-------+--------+               +------------------+
|  IoT Node   | <-- LoRa ---> |      Gateway   | <-- HTTPS --> |       API        |
|  ESP32-S3   | <- Wifi AP -> |      ESP32     |               |  Express + TS    |
+------+------+               +---+---------+--+               +-----+--------+---+
       |                          |         |                        |        |
       | local AP during pairing  |         | MQTT commands/events   |        |
       | /identity                |         +----------------------->|        |
       | /prove                   |         |<-----------------------+        |
       | /provision               |                                           |
       |                          | telemetry/Status transmission             |
       |During Pairing Phase Only +------------------------------------------>|
       +--------------------------+------------------------------------------>|
                                                                              |
                                                               +-----------------------------+
                                                               |                             |              
                                                     +---------V---------+         +---------V---------+
                                                     |      MongoDB      |         |    MQTT Broker    |
                                                     | telemetry, nodes, |         | live data + cmds  |
                                                     | gateways, pairing |         +-------------------+
                                                     | sessions, command |
                                                     +-------------------+
```               

```text
Provisioning / Pairing
----------------------
Admin/Web App -> API: pre-register gateway and node
Gateway -> API: provision gateway to user account
Gateway -> API: confirm candidate / verify node proof
Node -> API: finalize pair-node
API -> Gateway: publish PAIRING_KEY_READY

Runtime
-------
Gateway -> Node: ACTIVATE / HEARTBEAT_REQ / MEASURE_REQ
Node -> Gateway: encrypted DATA / HEARTBEAT_ACK / ACTIVATE_OK
Gateway -> API: POST /api/sensor-data
API -> MongoDB: persist reading
API -> MQTT: publish live update
```

## What This API Does

- accepts sensor data from the gateway over HTTP
- stores telemetry, signal data, and event data in MongoDB
- publishes live telemetry to MQTT for dashboards and clients
- provisions gateways to user accounts
- manages node pairing sessions and pairing key exchange
- exposes authenticated routes for gateway and node management

## Tech Stack

- Node.js + Express
- TypeScript
- MongoDB + Mongoose
- MQTT
- JWT-based user authentication
- API key authentication for gateway firmware

## Project Structure

| Path | Purpose |
|------|---------|
| `src/index.ts` | Express app, middleware, health check, route mounting |
| `src/config.ts` | Environment configuration |
| `src/routes/sensorData.ts` | Telemetry ingestion and telemetry queries |
| `src/routes/gateways.ts` | User-facing gateway and node management routes |
| `src/routes/registry.ts` | Gateway provisioning, node pairing, admin pre-registration, command ack/heartbeat |
| `src/services/database.ts` | MongoDB connection |
| `src/services/mqttService.ts` | MQTT publishing |
| `src/services/commandService.ts` | Command persistence and MQTT command publishing |
| `src/services/pairingService.ts` | Pairing token, AP password, proof, and AES key helpers |
| `src/models/` | MongoDB schemas for users, gateways, nodes, telemetry, commands, and pairing sessions |
| `api/index.ts` | Vercel entry point |
| `test_api.ps1` | Local PowerShell API test script |

## Authentication Model

This repository does not provide user login or registration routes.

Instead:

- user-facing routes expect a valid JWT in `Authorization: Bearer <token>`
- the JWT secret must match the external auth service that issued the token
- firmware-facing routes use `X-Gateway-Key` or `X-API-Key`

## Main Flows

### Gateway provisioning

1. An admin pre-registers the gateway hardware ID and device secret.
2. The gateway sends `POST /api/registry/gateway/provision` with its hardware ID, device secret, firmware version, and user token.
3. The API links the gateway to the user account and returns the MQTT command topic.

### Node pairing

1. An admin pre-registers the node ID and device secret.
2. The mobile/web app confirms a detected pairing candidate through `POST /api/gateways/:gatewayId/pairing/confirm-candidate`.
3. The API creates a pairing session and publishes `CONFIRM_PAIRING` over MQTT to the gateway.
4. The gateway fetches and verifies node proof through `POST /api/registry/pair-node/verify-proof`.
5. The node completes pairing through `POST /api/registry/pair-node`.
6. The API generates and stores the AES key, then publishes `PAIRING_KEY_READY` to the gateway.

### Telemetry ingestion

1. The gateway sends `POST /api/sensor-data`.
2. The API resolves the gateway and paired node from the database.
3. The reading is stored in `SensorData`.
4. A live MQTT event is published for dashboards and clients.

## Route Summary

### Public utility

| Method | Path | Notes |
|------|------|------|
| `GET` | `/health` | Health check with MQTT connection status |

### Telemetry

| Method | Path | Auth | Notes |
|------|------|------|------|
| `POST` | `/api/sensor-data` | Gateway API key | Receive telemetry from gateway |
| `GET` | `/api/sensor-data` | JWT | Paginated telemetry for authenticated user |
| `GET` | `/api/sensor-data/latest` | JWT | Latest reading |
| `GET` | `/api/sensor-data/stats` | JWT | Aggregated stats for a time window |

### Gateways and nodes

| Method | Path | Auth | Notes |
|------|------|------|------|
| `GET` | `/api/gateways` | JWT | List gateways for current user |
| `DELETE` | `/api/gateways/:gatewayId` | JWT | Unlink gateway from current user |
| `GET` | `/api/gateways/:gatewayId/status` | JWT | Gateway status |
| `PUT` | `/api/gateways/:gatewayId/config` | JWT | Update gateway config and publish command |
| `GET` | `/api/gateways/:gatewayId/nodes` | JWT | List nodes attached to a gateway |
| `POST` | `/api/gateways/:gatewayId/pairing/confirm-candidate` | JWT | Confirm a discovered node candidate |
| `DELETE` | `/api/gateways/:gatewayId/nodes/:nodeId` | JWT | Unpair node |
| `POST` | `/api/gateways/:gatewayId/nodes/:nodeId/measure` | JWT | Request immediate measurement |
| `PUT` | `/api/gateways/:gatewayId/nodes/:nodeId/config` | JWT | Send node config update |

### Registry and firmware integration

| Method | Path | Auth | Notes |
|------|------|------|------|
| `POST` | `/api/registry/admin/pre-register` | JWT admin | Pre-register gateway or node with device secret |
| `POST` | `/api/registry/gateway/provision` | Token + device secret | Link gateway to user account |
| `POST` | `/api/registry/gateway/heartbeat` | Gateway API key | Update gateway status and fetch pending commands |
| `POST` | `/api/registry/command/ack` | Gateway API key | Ack a command |
| `POST` | `/api/registry/pair-node/verify-proof` | Gateway API key | Verify node proof and issue pairing token |
| `POST` | `/api/registry/pair-node` | Pairing token | Finalize node pairing and generate AES key |
| `POST` | `/api/registry/pair-node/rollback` | Gateway API key | Roll back a failed pairing |
| `POST` | `/api/registry/gateway/node-status` | Gateway API key | Update node active/signal status |

## Example Telemetry Request

```http
POST /api/sensor-data
X-Gateway-Key: your-gateway-api-key
Content-Type: application/json
```

```json
{
  "nodeId": "12345678",
  "gatewayHardwareId": "A1B2C3D4E5F6",
  "seq": 42,
  "b": 85,
  "v": 3.9,
  "m": 150,
  "p": 6.82,
  "ps": 8,
  "t": 280,
  "ts": 7,
  "u": 2.1,
  "us": 6,
  "tw": 22.5,
  "tm": 45.2,
  "te": 38.1,
  "e": "None",
  "rssi": -45,
  "snr": 11.2
}
```

## Environment Variables

Copy `.env.example` to `.env` and update the values.

Important variables:

```env
NODE_ENV=development
PORT=3000
API_BASE_URL=http://localhost:3000

JWT_SECRET=your-shared-jwt-secret
MONGODB_URI=mongodb://localhost:27017/water-quality-monitor
GATEWAY_API_KEY=your-gateway-api-key

MQTT_BROKER_URL=mqtt://broker.hivemq.com
MQTT_PORT=1883
MQTT_CLIENT_ID=water-quality-api-broadcaster
MQTT_PUBLISH_TOPIC=water-quality/live-data
```

Notes:

- `JWT_SECRET` must match the external auth service issuing user tokens.
- `GATEWAY_API_KEY` must match the value used by gateway firmware.
- MQTT is optional for live updates, but the API is built around publishing commands and telemetry events when available.

## Local Development

```bash
cd API
npm install
npm run dev
```

Useful commands:

```bash
npm run type-check
npm run build
npm start
```

## Deployment

This project includes `api/index.ts` for Vercel deployment and `vercel.json` for routing.

Set these environment variables in the deployment platform:

- `JWT_SECRET`
- `MONGODB_URI`
- `GATEWAY_API_KEY`
- `API_BASE_URL`
- `MQTT_BROKER_URL`
- `MQTT_PORT`
- `MQTT_USERNAME` and `MQTT_PASSWORD` if your broker requires them

## Notes

- Commands are stored in MongoDB and also published over MQTT.
- Pairing sessions and commands use TTL-backed expiration in MongoDB.
- The API expects gateways and nodes to be pre-registered before provisioning and pairing.
- `test_api.ps1` can be used to exercise the local API manually.
