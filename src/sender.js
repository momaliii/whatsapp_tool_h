import cliProgress from "cli-progress";
import { color } from "./utils.js";
import { runCampaign as runCore } from "./campaign.js";

/** CLI front-end for the shared campaign core: renders a live progress bar. */
export async function runCampaign(client, opts = {}) {
  const bar = new cliProgress.SingleBar(
    {
      format:
        color.cyan("{bar}") +
        " {percentage}% | {value}/{total} | ✓{sent} ✗{failed} ⊘{skipped} | {phase} {wait}s | {name}",
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  let started = false;

  await runCore(client, {
    dryRun: opts.dryRun,
    control: opts.control,
    on: {
      start(stats) {
        if (!stats.total) return;
        bar.start(stats.total, 0, { sent: 0, failed: 0, skipped: 0, phase: "", wait: "", name: "" });
        started = true;
      },
      progress({ index, stats, name, phase, wait }) {
        if (started)
          bar.update(index, { ...stats, phase, wait: wait || 0, name: name || "" });
      },
      log(level, msg) {
        if (!started) {
          const paint = level === "error" ? color.red : level === "warn" ? color.yellow : color.gray;
          console.log(paint(msg));
        }
      },
      done(stats) {
        if (started) bar.stop();
        console.log(
          "\n" +
            color.bold("Done. ") +
            color.green(`✓ ${stats.sent} sent`) + "  " +
            color.red(`✗ ${stats.failed} failed`) + "  " +
            color.yellow(`⊘ ${stats.skipped} skipped`) +
            color.gray("  (full log → results.csv)\n")
        );
      },
    },
  });
}
