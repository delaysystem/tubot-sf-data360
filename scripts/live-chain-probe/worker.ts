/**
 * Temporary live-chain probe: exercises the real staging path
 *   signRpcEnvelope -> getTokenForChannel -> extractData360 (live SOAP retrieve)
 * server-side, so the Salesforce token never leaves the worker.
 *
 * Deployed/deleted by ../live-refresh-chain.ts with staged _NEXT rotation keys.
 * Gated by the x-probe-key header (PROBE_RUN_KEY secret, random per run).
 */
import { signRpcEnvelope } from "../../src/rpc-sign";
import { signRpcEnvelope as signData360Envelope } from "../../../tubot-new-panel/worker/service-signer";
import { discoverAgents } from "../../../tubot-sf-auth/src/agent-snapshot";

interface ProbeEnv {
  AUTH: {
    getTokenForChannel(
      channelId: string,
      options: { teamId: string; orgId: string },
      signed: unknown,
    ): Promise<{ accessToken: string; instanceUrl: string; expiresAt: string }>;
  };
  DATA360: {
    extractData360(options: Record<string, unknown>, auth: unknown): Promise<any>;
  };
  PROBE_AUTH_KEY: string;
  PROBE_D360_KEY: string;
  PROBE_RUN_KEY: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function summarizePackage(pkg: any): Record<string, unknown> {
  const agent = pkg?.agent ?? {};
  const manifest = pkg?.manifest ?? pkg?.exportManifest ?? {};
  return {
    agentName: agent.agentName ?? manifest?.target?.agentName ?? null,
    channelName: agent.channelName ?? manifest?.target?.channelDeveloperName ?? null,
    agentFormat: agent.agentFormat ?? agent.format ?? manifest?.summary?.agentFormat ?? null,
    scriptChars: typeof agent.script === "string" ? agent.script.length : 0,
    scriptPreview: typeof agent.script === "string" ? agent.script.slice(0, 300) : null,
    bundleMetaXmlChars: typeof agent.bundleMetaXml === "string" ? agent.bundleMetaXml.length : 0,
    botXmlChars: typeof agent.botXml === "string" ? agent.botXml.length : 0,
    promptTemplates: agent.promptTemplates ? Object.keys(agent.promptTemplates) : [],
    rawFiles: agent.rawFiles ? Object.keys(agent.rawFiles) : [],
    callableTools: Array.isArray(agent.callableTools) ? agent.callableTools.length : 0,
    manifestTarget: manifest?.target ?? null,
    manifestSummary: manifest?.summary ? {
      ...manifest.summary,
      dmos: Array.isArray(manifest.summary.dmos) ? manifest.summary.dmos.slice(0, 5) : manifest.summary.dmos,
    } : null,
    agentBlob: manifest?.agentBlob ?? null,
    pendingAgentRetrieve: manifest?.pendingAgentRetrieve ?? null,
    warnings: Array.isArray(manifest?.warnings) ? manifest.warnings.slice(0, 10) : [],
  };
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const runKey = request.headers.get("x-probe-key");
    if (!env.PROBE_RUN_KEY || runKey !== env.PROBE_RUN_KEY) {
      return json({ error: "probe_unauthorized" }, 401);
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, at: new Date().toISOString() });
    if (url.pathname !== "/run") return json({ error: "not_found" }, 404);

    let params: Record<string, string> = {};
    if (request.method === "POST") {
      try {
        params = (await request.json()) as Record<string, string>;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    } else {
      url.searchParams.forEach((v, k) => { params[k] = v; });
    }
    const channelId = (params.channelId ?? "").trim();
    const teamId = (params.teamId ?? "").trim();
    const orgId = (params.orgId ?? "").trim();
    const wantAgent = (params.agentName ?? "").trim();
    if (!channelId || !teamId || !orgId) {
      return json({ error: "channelId, teamId and orgId are required" }, 400);
    }

    const started = Date.now();
    try {
      // Step 1: HMAC per-org envelope -> sf-auth token RPC (the hop the HMAC buys).
      const t0 = Date.now();
      const signed = await signRpcEnvelope({
        caller: "data360",
        callerKey: env.PROBE_AUTH_KEY,
        org: orgId,
        method: "getTokenForChannel",
        businessArgs: [channelId, { teamId, orgId }],
      });
      const token = await env.AUTH.getTokenForChannel(channelId, { teamId, orgId }, signed);
      const tokenMs = Date.now() - t0;
      const host = new URL(token.instanceUrl).hostname;

      // Step 2: live discovery over SOAP with the minted token.
      const t1 = Date.now();
      const conn = { instanceUrl: token.instanceUrl, accessToken: token.accessToken };
      const inventory = await discoverAgents(conn);
      const discoveryMs = Date.now() - t1;
      const agents = inventory.agents.map((a) => ({ name: a.name, type: a.type }));
      const agentName = wantAgent
        || inventory.agents.find((a) => a.type === "AiAgentDefinition")?.name
        || inventory.agents[0]?.name;
      if (!agentName) {
        return json({
          ok: false,
          token: { host, expiresAt: token.expiresAt, ms: tokenMs },
          discovery: { agents, ms: discoveryMs },
          error: "no_agents_in_org",
        });
      }

      // Step 3: full data360 extraction (live agent script/XML retrieve inside).
      // NOTE: agentName only -- the extractor prefers channelId when both are set.
      const t2 = Date.now();
      const options: Record<string, unknown> = {
        accessToken: token.accessToken,
        instanceUrl: token.instanceUrl,
        orgId,
        teamId,
        agentName,
        includeAgentScript: true,
        includeAgentXml: true,
        includeTools: false,
        maxRecords: 5,
      };
      const auth = await signData360Envelope(env.PROBE_D360_KEY, "extractData360", [options]);
      const pkg = await env.DATA360.extractData360(options, auth);
      const extractMs = Date.now() - t2;

      return json({
        ok: true,
        token: { host, expiresAt: token.expiresAt, ms: tokenMs },
        discovery: { agents, picked: agentName, ms: discoveryMs },
        extract: { ...summarizePackage(pkg), ms: extractMs },
        totalMs: Date.now() - started,
      });
    } catch (err) {
      return json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        totalMs: Date.now() - started,
      }, 502);
    }
  },
};
