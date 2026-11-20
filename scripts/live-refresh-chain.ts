#!/usr/bin/env bun
/**
 * Live chain verification against staging:
 *   HMAC per-org envelope -> sf-auth getTokenForChannel -> data360 extractData360
 *   (with a live Salesforce SOAP agent retrieve inside).
 *
 * getTokenForChannel is binding-only RPC, so this script stages short-lived
 * _NEXT rotation keys (additive, deleted afterwards), deploys a temporary
 * gated probe worker that runs the whole chain server-side (the Salesforce
 * token never leaves the worker), prints the result, and cleans up.
 *
 * Usage:
 *   bun tubot-sf-data360/scripts/live-refresh-chain.ts [--channel ID] [--team ID]
 *       [--org ID] [--agent NAME] [--keep]
 */
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AUTH_DIR = resolve(ROOT, "tubot-sf-auth");
const DATA360_DIR = resolve(ROOT, "tubot-sf-data360");
const PROBE_DIR = resolve(DATA360_DIR, "scripts/live-chain-probe");
const PROBE_CONFIG = resolve(PROBE_DIR, "wrangler.jsonc");
const PROBE_NAME = "tubot-live-chain-probe";

const args = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const channelId = flag("channel", "0Mjg5000000XOErCAO");
const teamId = flag("team", "d1_e2e-echo-202");
const orgId = flag("org", "00Dg500000FHRCsEAP");
const agentName = flag("agent", "");
const keep = args.includes("--keep");

function freshKey(): string {
  return (randomUUID() + randomUUID()).replaceAll("-", "");
}

async function sh(
  cmd: string[],
  opts: { cwd: string; stdin?: string; quiet?: boolean },
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const out = (stdout + stderr).trim();
  if (!opts.quiet) console.log(out);
  return { code, out };
}

async function must(cmd: string[], cwd: string, stdin?: string): Promise<string> {
  console.log(`\n$ (cd ${cwd}) ${cmd.join(" ")}`);
  const { code, out } = await sh(cmd, { cwd, stdin, quiet: true });
  console.log(out);
  if (code !== 0) throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  return out;
}

async function main(): Promise<void> {
  console.log("=== live refresh chain: staging ===");
  console.log(`channel=${channelId} team=${teamId} org=${orgId} agent=${agentName || "(auto)"}`);

  const authKey = freshKey();
  const d360Key = freshKey();
  const runKey = freshKey();

  // 1. Stage _NEXT rotation keys (verifiers try current + _NEXT; deleted after).
  await must(["wrangler", "secret", "put", "AUTH_CALLER_KEY_DATA360_NEXT", "--env", "staging"], AUTH_DIR, authKey);
  // NOTE: data360 top-level IS staging; never pass --env staging here.
  await must(["wrangler", "secret", "put", "DATA360_INTERNAL_KEY_NEXT"], DATA360_DIR, d360Key);

  // 2. Probe secrets + deploy.
  await must(["wrangler", "secret", "put", "PROBE_AUTH_KEY", "--config", PROBE_CONFIG], PROBE_DIR, authKey);
  await must(["wrangler", "secret", "put", "PROBE_D360_KEY", "--config", PROBE_CONFIG], PROBE_DIR, d360Key);
  await must(["wrangler", "secret", "put", "PROBE_RUN_KEY", "--config", PROBE_CONFIG], PROBE_DIR, runKey);
  const deployOut = await must(["wrangler", "deploy", "--config", PROBE_CONFIG], PROBE_DIR);
  const probeUrl = deployOut.match(/https:\/\/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.workers\.dev/)?.[0];
  if (!probeUrl) throw new Error("could not find probe workers.dev URL in deploy output");

  // 3. Wait until the new version+secrets serve (route 404s, then old 401s).
  console.log("\n=== waiting for probe version ===");
  for (let i = 0; i < 36; i++) {
    const probe = await fetch(`${probeUrl}/health`, { headers: { "x-probe-key": runKey } });
    await probe.text();
    if (probe.status === 200) break;
    await Bun.sleep(5000);
    if (i === 35) throw new Error("probe never served the new version+secrets");
  }

  // 4. Run the chain.
  console.log(`\n=== running chain via ${probeUrl}/run ===`);
  const started = Date.now();
  const res = await fetch(`${probeUrl}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-probe-key": runKey },
    body: JSON.stringify({ channelId, teamId, orgId, agentName }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(`HTTP ${res.status} in ${Date.now() - started}ms`);
  console.log(JSON.stringify(body, null, 2));

  // 5. Cleanup.
  if (keep) {
    console.log("\n--keep: probe worker and _NEXT keys left in place for debugging.");
    console.log(`probe: ${probeUrl}/run (x-probe-key in this terminal only)`);
    return;
  }
  console.log("\n=== cleanup ===");
  try {
    await must(["wrangler", "secret", "delete", "AUTH_CALLER_KEY_DATA360_NEXT", "--env", "staging"], AUTH_DIR, "y\n");
  } catch (err) {
    console.log(`WARN: sf-auth _NEXT cleanup failed: ${(err as Error).message}`);
  }
  try {
    await must(["wrangler", "secret", "delete", "DATA360_INTERNAL_KEY_NEXT"], DATA360_DIR, "y\n");
  } catch (err) {
    console.log(`WARN: data360 _NEXT cleanup failed: ${(err as Error).message}`);
  }
  try {
    await must(["wrangler", "delete", PROBE_NAME], PROBE_DIR);
  } catch (err) {
    console.log(`WARN: probe delete failed: ${(err as Error).message}`);
  }
  if (body.ok !== true) throw new Error("chain run did not report ok:true");
  console.log("\nLIVE CHAIN OK");
}

await main();
