<div align="center">

<img
  src="eausure_header.svg"
  alt="Logo officiel EauSûre"
/>

<br/>

<img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
<img src="https://img.shields.io/badge/Express.js-404D59?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
<img src="https://img.shields.io/badge/MQTT-1F2937?style=for-the-badge&logo=eclipsemosquitto&logoColor=white" alt="MQTT" />

</div>

# EauSûre Hardware API

API centrale de communication terrain pour l'écosystème EauSûre.

Elle est consommée par :
- `Application_Web` pour la supervision, la télémétrie, les gateways et les nœuds ;
- `Application_Mobile` pour la télémétrie, le pairing, la configuration et le provisioning ;
- `Application_Admin_API` pour le pré-enregistrement matériel ;
- `MyFreeRTOSProject` côté firmware gateway et node pour le provisioning, le pairing, les heartbeats, la télémétrie et les commandes.

## Portée

L'écosystème backend d'EauSûre repose sur une fragmentation fonctionnelle des APIs. Chaque service couvre un périmètre précis, mais l'ensemble fonctionne de manière complémentaire :
- **Hardware API** : provisioning, pairing, commandes, télémétrie et orchestration gateway/node ;
- **Admin API** : administration, pré-enregistrement et gestion des releases firmware ;
- **Auth API** : authentification, identité, jetons d'accès et OAuth ;
- **Profile API** : profil utilisateur et préférences.

Dans cette architecture, `Hardware_API` concentre la logique d'échange avec le matériel :
- **ingestion télémétrique** ;
- **provisioning gateway** ;
- **pairing node** ;
- **configuration et commandes MQTT** ;
- **état runtime des gateways et nœuds** ;
- **intégration firmware OTA/FUOTA côté commandes**.

## Vue d'ensemble

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
Admin Web/App -> API: pre-register gateway and node
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

## Stack

- Node.js + Express
- TypeScript
- MongoDB + Mongoose
- MQTT
- JWT côté routes utilisateur
- API key côté firmware gateway

## Rôle de l'API

- reçoit les données capteurs transmises par la gateway via HTTP
- stocke la télémétrie, les signaux radio et les événements dans MongoDB
- publie la télémétrie temps réel sur MQTT pour les dashboards et les clients
- provisionne les gateways sur les comptes utilisateurs
- gère les sessions de pairing des nœuds et l'échange des clés de pairing
- expose des routes authentifiées pour la gestion des gateways et des nœuds

## Consommation de l'API

### Depuis `Application_Web`

Les pages web appellent réellement :
- `GET /api/sensor-data`
- `GET /api/sensor-data/latest`
- `GET /api/sensor-data/stats`
- `GET /api/gateways`
- `GET /api/gateways/:gatewayId/status`
- `GET /api/gateways/:gatewayId/nodes`
- `POST /api/gateways/:gatewayId/nodes/:nodeId/measure`

Le dépôt web contient aussi des routes proxy Next.js pour :
- `PUT /api/gateways/:gatewayId/config`
- `DELETE /api/gateways/:gatewayId`
- `POST /api/gateways/:gatewayId/pairing/confirm-candidate`
- `DELETE /api/gateways/:gatewayId/nodes/:nodeId`
- `PUT /api/gateways/:gatewayId/nodes/:nodeId/config`
- `POST /api/gateways/:gatewayId/firmware-update`
- `POST /api/gateways/:gatewayId/nodes/:nodeId/firmware-update`

À ce stade, je n'ai pas retrouvé d'appel direct depuis une page React vers ces proxies. Pour le web, la gestion des releases FUOTA passe surtout par `Application_Admin_API`, tandis que les commandes de déploiement matériel sont surtout consommées côté mobile.

### Depuis `Application_Mobile`

Le code consomme notamment :
- `GET /sensor-data`
- `GET /sensor-data/latest`
- `GET /sensor-data/stats`
- `GET /gateways`
- `GET /gateways/:gatewayId/nodes`
- `GET /gateways/:gatewayId/commands/:commandId`
- `POST /gateways/:gatewayId/pairing/confirm-candidate`
- `GET /gateways/:gatewayId/pairing/scan`
- `GET /gateways/:gatewayId/pairing/session/:sessionId`
- `PUT /gateways/:gatewayId/location`
- `PUT /gateways/:gatewayId/nodes/:nodeId/config`
- `DELETE /gateways/:gatewayId/nodes/:nodeId`
- `POST /gateways/:gatewayId/pairing/cancel`
- `POST /gateways/:gatewayId/firmware-update`
- `POST /gateways/:gatewayId/nodes/:nodeId/firmware-update`
- `POST /gateways/provisioning/session`

### Depuis `Application_Admin_API`

- `POST /api/registry/admin/pre-register`

### Depuis `MyFreeRTOSProject`

Le firmware consomme directement des routes de registry et de télémétrie, notamment :
- `POST /api/registry/gateway/provision`
- `POST /api/registry/pair-node/verify-proof`
- `POST /api/registry/gateway/heartbeat`
- `POST /api/registry/command/ack`
- `POST /api/registry/command/fail`
- `POST /api/registry/pair-node/rollback`
- `POST /api/registry/pair-node/fail-session`
- `GET /api/registry/gateway/:gatewayHardwareId/config`
- `POST /api/registry/gateways/:gatewayHardwareId/unprovision`
- `POST /api/registry/pair-node`
- `POST /api/sensor-data`

## Structure du projet

| Chemin | Rôle |
|------|------|
| `src/index.ts` | Application Express, middlewares, route de santé et montage des routes |
| `src/config.ts` | Configuration de l'environnement |
| `src/routes/sensorData.ts` | Ingestion télémétrique et requêtes de consultation |
| `src/routes/gateways.ts` | Routes de gestion des gateways et des nœuds côté utilisateur |
| `src/routes/registry.ts` | Provisioning gateway, pairing node, pré-enregistrement admin, acquittement de commandes et heartbeat |
| `src/services/database.ts` | Connexion MongoDB |
| `src/services/mqttService.ts` | Publication MQTT |
| `src/services/commandService.ts` | Persistance des commandes et publication MQTT des commandes |
| `src/services/pairingService.ts` | Aides pour jetons de pairing, mot de passe AP, preuve et clés AES |
| `src/models/` | Schémas MongoDB pour utilisateurs, gateways, nœuds, télémétrie, commandes et sessions de pairing |
| `api/index.ts` | Point d'entrée Vercel |

## Modèle d'authentification

Ce dépôt ne fournit pas de routes de connexion ou d'inscription utilisateur.

À la place :

- les routes côté utilisateur attendent un JWT valide dans `Authorization: Bearer <token>`
- le secret JWT doit correspondre au service d'authentification externe qui émet le jeton
- les routes côté firmware utilisent `X-Gateway-Key` ou `X-API-Key`

## Flux principaux

### Provisioning d'une gateway

1. Un administrateur pré-enregistre l'identifiant matériel de la gateway et son secret matériel.
2. La gateway envoie `POST /api/registry/gateway/provision` avec son identifiant matériel, son secret, sa version firmware et le jeton utilisateur.
3. L'API rattache la gateway au compte utilisateur et retourne le topic MQTT de commande.

### Pairing d'un nœud

1. Un administrateur pré-enregistre l'identifiant du nœud et son secret matériel.
2. L'application mobile ou web confirme un candidat de pairing détecté via `POST /api/gateways/:gatewayId/pairing/confirm-candidate`.
3. L'API crée une session de pairing et publie `CONFIRM_PAIRING` sur MQTT à destination de la gateway.
4. La gateway récupère et vérifie la preuve du nœud via `POST /api/registry/pair-node/verify-proof`.
5. Le nœud finalise le pairing via `POST /api/registry/pair-node`.
6. L'API génère et stocke la clé AES, puis publie `PAIRING_KEY_READY` vers la gateway.

### Ingestion télémétrique

1. La gateway envoie `POST /api/sensor-data`.
2. L'API résout la gateway et le nœud pairé depuis la base.
3. La lecture est stockée dans `SensorData`.
4. Un événement MQTT temps réel est publié pour les tableaux de bord et les clients.

## Résumé des routes

### Utilitaire public

| Méthode | Chemin | Notes |
|------|------|------|
| `GET` | `/health` | Vérification de santé avec état de connexion MQTT |

### Télémétrie

| Méthode | Chemin | Auth | Notes |
|------|------|------|------|
| `POST` | `/api/sensor-data` | Clé API gateway | Reçoit la télémétrie depuis la gateway |
| `GET` | `/api/sensor-data` | JWT | Télémétrie paginée pour l'utilisateur authentifié |
| `GET` | `/api/sensor-data/latest` | JWT | Dernière lecture |
| `GET` | `/api/sensor-data/stats` | JWT | Statistiques agrégées sur une fenêtre temporelle |

### Gateways et nœuds

| Méthode | Chemin | Auth | Notes |
|------|------|------|------|
| `GET` | `/api/gateways` | JWT | Liste les gateways de l'utilisateur courant |
| `DELETE` | `/api/gateways/:gatewayId` | JWT | Délie une gateway du compte utilisateur courant |
| `GET` | `/api/gateways/:gatewayId/status` | JWT | État d'une gateway |
| `GET` | `/api/gateways/:gatewayId/commands/:commandId` | JWT | Récupère l'état d'une commande |
| `PUT` | `/api/gateways/:gatewayId/config` | JWT | Met à jour la configuration gateway et publie une commande |
| `GET` | `/api/gateways/:gatewayId/nodes` | JWT | Liste les nœuds rattachés à une gateway |
| `POST` | `/api/gateways/provisioning/session` | JWT | Crée une session de provisioning pour une gateway |
| `GET` | `/api/gateways/:gatewayId/pairing/scan` | JWT | Déclenche un scan de pairing via MQTT |
| `POST` | `/api/gateways/:gatewayId/pairing/confirm-candidate` | JWT | Confirme un candidat de nœud détecté |
| `GET` | `/api/gateways/:gatewayId/pairing/session/:sessionId` | JWT | Lit l'état d'une session de pairing |
| `POST` | `/api/gateways/:gatewayId/pairing/cancel` | JWT | Annule un pairing sur la gateway |
| `PUT` | `/api/gateways/:gatewayId/location` | JWT | Met à jour la localisation de la gateway |
| `DELETE` | `/api/gateways/:gatewayId/nodes/:nodeId` | JWT | Dé-paire un nœud |
| `POST` | `/api/gateways/:gatewayId/nodes/:nodeId/measure` | JWT | Demande une mesure immédiate |
| `PUT` | `/api/gateways/:gatewayId/nodes/:nodeId/config` | JWT | Met à jour la configuration du nœud et envoie éventuellement une config LoRa |
| `POST` | `/api/gateways/:gatewayId/firmware-update` | JWT | Met en file une mise à jour firmware de gateway |
| `POST` | `/api/gateways/:gatewayId/nodes/:nodeId/firmware-update` | JWT | Met en file une mise à jour firmware de nœud |

### Registry et intégration firmware

| Méthode | Chemin | Auth | Notes |
|------|------|------|------|
| `POST` | `/api/registry/admin/pre-register` | JWT admin | Pré-enregistre une gateway ou un nœud avec son secret matériel |
| `POST` | `/api/registry/gateway/provision` | Jeton + secret matériel | Rattache une gateway à un compte utilisateur |
| `POST` | `/api/registry/gateway/heartbeat` | Clé API gateway | Met à jour l'état de la gateway et récupère les commandes en attente |
| `GET` | `/api/registry/gateway/:gatewayHardwareId/config` | Clé API gateway | Récupère la configuration persistée de la gateway et des nœuds |
| `POST` | `/api/registry/command/ack` | Clé API gateway | Acquitte une commande |
| `POST` | `/api/registry/command/fail` | Clé API gateway | Marque une commande comme échouée |
| `POST` | `/api/registry/pair-node/verify-proof` | Clé API gateway | Vérifie la preuve du nœud et émet un jeton de pairing |
| `POST` | `/api/registry/pair-node` | Jeton de pairing | Finalise le pairing du nœud et génère la clé AES |
| `POST` | `/api/registry/pair-node/rollback` | Clé API gateway | Annule un pairing échoué |
| `POST` | `/api/registry/pair-node/fail-session` | Clé API gateway | Marque une session comme échouée avant émission du jeton |
| `POST` | `/api/registry/gateway/node-status` | Clé API gateway | Met à jour l'état actif et le signal d'un nœud |
| `POST` | `/api/registry/gateways/:gatewayHardwareId/unprovision` | Clé API gateway | Marque une gateway comme déprovisionnée |

## Exemple de requête télémétrique

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

## Variables d'environnement

Variables principales utilisées par `src/config.ts` :
- `NODE_ENV`
- `PORT`
- `API_BASE_URL`
- `JWT_SECRET`
- `MONGODB_URI`
- `MONGODB_CONNECT_TIMEOUT_MS`
- `MONGODB_SERVER_SELECTION_TIMEOUT_MS`
- `GATEWAY_API_KEY`
- `MQTT_BROKER_URL`
- `MQTT_PORT`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `MQTT_CLIENT_ID`
- `MQTT_PUBLISH_TOPIC`
- `MQTT_QOS`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `CORS_ORIGIN`
- `LOG_LEVEL`


Notes :

- `JWT_SECRET` doit correspondre au service d'authentification externe qui émet les jetons utilisateur.
- `GATEWAY_API_KEY` doit correspondre à la valeur utilisée par le firmware gateway.

## Déploiement

Ce projet inclut `api/index.ts` pour le déploiement Vercel ainsi que `vercel.json` pour le routage.


## Notes

- Les commandes sont stockées dans MongoDB puis également publiées sur MQTT.
- Les sessions de pairing et les commandes utilisent une expiration TTL côté MongoDB.
- L'API attend que les gateways et les nœuds soient pré-enregistrés avant provisioning et pairing.
