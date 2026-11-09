import { RPCServer } from "ocpp-rpc";
import { createHmac, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 9220);
const APP_URL = process.env.APP_URL;
const SECRET = process.env.OCPP_BRIDGE_SECRET;
if (!APP_URL || !SECRET) throw new Error("Defina APP_URL e OCPP_BRIDGE_SECRET");

const clients = new Map();

function signed(method, path, body = "") {
  const ts = String(Date.now()), nonce = randomUUID();
  const sig = createHmac("sha256", SECRET).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest("hex");
  return { "x-bridge-ts": ts, "x-bridge-nonce": nonce, "x-bridge-signature": sig };
}

async function ack(id, status, result) {
  const path = "/api/public/ocpp/commands", body = JSON.stringify({ id, status, result });
  await fetch(`${APP_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", ...signed("POST", path, body) }, body }).catch((e) => console.error("ack:", e.message));
}

async function forward(ocppId, action, payload) {
  const path = "/api/public/ocpp/events", body = JSON.stringify({ ocppId, action, payload });
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed("POST", path, body) },
    body,
  });
  if (!res.ok) throw new Error(`App respondeu ${res.status}`);
  return res.json();
}

const server = new RPCServer({ protocols: ["ocpp1.6"], strictMode: true });

server.on("client", (client) => {
  const id = client.identity;
  clients.set(id, client);
  console.log(`[${id}] conectado via OCPP 1.6J`);

  for (const action of ["BootNotification", "Heartbeat", "StatusNotification", "Authorize", "StartTransaction", "MeterValues", "StopTransaction"]) {
    client.handle(action, async ({ params }) => {
      console.log(`[${id}] <- ${action}`);
      try { return await forward(id, action, params); }
      catch (e) {
        console.error(`[${id}] ${action} falhou:`, e.message);
        if (action === "Authorize") return { idTagInfo: { status: "Invalid" } };
        if (action === "StartTransaction") return { transactionId: 0, idTagInfo: { status: "Invalid" } };
        throw e;
      }
    });
  }
  client.handle("DataTransfer", () => ({ status: "Accepted" }));
  client.handle(({ method }) => { console.log(`[${id}] não tratado: ${method}`); return {}; });

  client.on("close", () => {
    clients.delete(id);
    console.log(`[${id}] desconectado`);
    forward(id, "StatusNotification", { connectorId: 1, status: "Unavailable", errorCode: "NoError" }).catch(() => {});
  });
});

async function pollCommands() {
  try {
    const res = await fetch(`${APP_URL}/api/public/ocpp/commands`, { headers: signed("GET", "/api/public/ocpp/commands") });
    if (!res.ok) return;
    const { commands } = await res.json();
    for (const cmd of commands) {
      const client = clients.get(cmd.ocpp_id);
      if (!client) { console.warn(`[${cmd.ocpp_id}] offline, ${cmd.action} será reenviado`); continue; }
      console.log(`[${cmd.ocpp_id}] -> ${cmd.action}`, cmd.payload);
      client.call(cmd.action, cmd.payload)
        .then((r) => ack(cmd.id, r?.status === "Accepted" ? "accepted" : "rejected", r))
        .catch((e) => ack(cmd.id, "failed", { error: e.message }));
    }
  } catch (e) { console.error("poll:", e.message); }
}
setInterval(pollCommands, 2000);

await server.listen(PORT);
console.log(`OCPP 1.6J rodando na porta ${PORT}`);
