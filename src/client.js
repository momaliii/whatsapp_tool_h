import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { color } from "./utils.js";
import { AUTH_DIR } from "./paths.js";

const { Client, LocalAuth } = pkg;

/**
 * Create and start an authenticated WhatsApp Web client.
 * Session is stored in ./.wwebjs_auth so you only scan the QR once.
 * Resolves once the client is fully ready.
 */
export function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
  });

  client.on("qr", (qr) => {
    console.log(
      color.yellow("\nScan this QR with WhatsApp → Linked Devices:\n")
    );
    qrcode.generate(qr, { small: true });
  });

  client.on("auth_failure", (m) =>
    console.error(color.red("Auth failure: " + m))
  );
  client.on("disconnected", (r) =>
    console.error(color.red("Client disconnected: " + r))
  );

  return new Promise((resolve, reject) => {
    client.on("ready", () => {
      console.log(color.green("✓ WhatsApp client ready\n"));
      resolve(client);
    });
    client.initialize().catch(reject);
  });
}
