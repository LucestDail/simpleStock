const { randomUUID } = require('crypto');

const HEARTBEAT_INTERVAL_MS = 25000;
const subscribers = new Map();

function writeEvent(res, eventType, payload = {}, options = {}) {
  const envelope = {
    id: options.id || randomUUID(),
    type: eventType,
    emittedAt: options.emittedAt || new Date().toISOString(),
    payload,
  };
  res.write(`id: ${envelope.id}\n`);
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  return envelope;
}

function getSubscriberCount() {
  return subscribers.size;
}

function subscribe(res) {
  const clientId = randomUUID();
  subscribers.set(clientId, { id: clientId, res, connectedAt: new Date().toISOString() });
  return clientId;
}

function unsubscribe(clientId) {
  const client = subscribers.get(clientId);
  if (!client) return false;

  subscribers.delete(clientId);
  try {
    client.res.end();
  } catch (_) {
    // noop
  }
  return true;
}

function sendToClient(clientId, eventType, payload = {}, options = {}) {
  const client = subscribers.get(clientId);
  if (!client) return null;

  try {
    return writeEvent(client.res, eventType, payload, options);
  } catch (_) {
    subscribers.delete(clientId);
    return null;
  }
}

function broadcast(eventType, payload = {}, options = {}) {
  const disconnected = [];

  for (const [clientId, client] of subscribers.entries()) {
    try {
      writeEvent(client.res, eventType, payload, options);
    } catch (_) {
      disconnected.push(clientId);
    }
  }

  for (const clientId of disconnected) {
    subscribers.delete(clientId);
  }
}

setInterval(() => {
  const emittedAt = new Date().toISOString();
  for (const [clientId, client] of subscribers.entries()) {
    try {
      client.res.write(`: heartbeat ${emittedAt}\n\n`);
    } catch (_) {
      subscribers.delete(clientId);
    }
  }
}, HEARTBEAT_INTERVAL_MS).unref();

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  subscribe,
  unsubscribe,
  sendToClient,
  broadcast,
  getSubscriberCount,
};
