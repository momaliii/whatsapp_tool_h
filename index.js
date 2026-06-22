#!/usr/bin/env node
import { createClient } from "./src/client.js";
import { runCampaign } from "./src/sender.js";
import { color, loadContacts, toJid, loadJson } from "./src/utils.js";
import { ensureData } from "./src/paths.js";

ensureData();

const cmd = process.argv[2] || "send";
const flags = new Set(process.argv.slice(3));

function banner() {
  console.log(
    color.bold(color.green("\n  watitool ")) +
      color.gray("— safe human-like bulk WhatsApp sender\n")
  );
}

async function main() {
  banner();

  switch (cmd) {
    case "login": {
      // Just establish/refresh the session, then exit.
      const client = await createClient();
      console.log(color.green("Session saved. You can now run: npm run send"));
      await client.destroy();
      process.exit(0);
      break;
    }

    case "check": {
      // Validate & normalize the contact list without sending anything.
      const cfg = loadJson("config.json");
      const rows = loadContacts("contacts.csv");
      console.log(color.bold(`Checking ${rows.length} contact(s):\n`));
      let bad = 0;
      for (const r of rows) {
        const { number } = toJid(r.number, cfg.countryCode);
        const ok = number && number.length >= 7;
        if (!ok) bad++;
        console.log(
          (ok ? color.green("✓") : color.red("✗")) +
            ` ${r.number}  →  ${number || "INVALID"}  ${color.gray(r.name || "")}`
        );
      }
      console.log(
        "\n" + (bad ? color.red(`${bad} invalid`) : color.green("all valid")) + "\n"
      );
      process.exit(0);
      break;
    }

    case "send": {
      const dryRun = flags.has("--dry-run") || flags.has("-n");
      const client = await createClient();
      try {
        await runCampaign(client, { dryRun });
      } finally {
        await client.destroy();
        process.exit(0);
      }
      break;
    }

    default:
      console.log(
        `Usage:
  ${color.cyan("node index.js login")}            Scan QR / refresh the WhatsApp session
  ${color.cyan("node index.js check")}            Validate & normalize contacts.csv (no sending)
  ${color.cyan("node index.js send")}             Run the campaign
  ${color.cyan("node index.js send --dry-run")}   Simulate the run (no messages actually sent)
`
      );
      process.exit(0);
  }
}

main().catch((e) => {
  console.error(color.red("\nError: " + (e.stack || e.message || e)));
  process.exit(1);
});
