import type { Data360Env, ExportData360Options, SalesforceConnection } from "./types";
import { RPC_SIGNER_CALLER_ID, resolveCallerKey, signRpcEnvelope, type RpcSignedEnvelope } from "./rpc-sign";

export interface ResolvedAuthResult {
  connection: SalesforceConnection;
  channelId?: string;
  orgId?: string;
  teamId?: string;
}

export class SalesforceAuthorizationError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); }
}

export class SalesforceAuthBridge {
  constructor(private readonly env: Data360Env) {}

  // Central signer for every TUBOT_SF_AUTH RPC: appends a trailing `signed`
  // envelope (caller "data360", per-org key). Fail-fast when SF_AUTH_CALLER_KEY
  // is missing/short or the org is malformed: never sends unsigned.
  private sign(org: string, method: string, businessArgs: unknown[]): Promise<RpcSignedEnvelope> {
    const callerKey = resolveCallerKey(this.env);
    return signRpcEnvelope({ caller: RPC_SIGNER_CALLER_ID, callerKey, org, method, businessArgs });
  }

  async resolveToken(options: ExportData360Options): Promise<ResolvedAuthResult> {
    if (options.accessToken && options.instanceUrl) {
      const accessToken = options.accessToken.replace(/^Bearer\s+/i, "").trim();
      const instanceUrl = options.instanceUrl.replace(/\/+$/, "").trim();
      const instance = new URL(instanceUrl);
      if (instance.protocol !== "https:" || instance.username || instance.password ||
        !["salesforce.com", "force.com", "salesforce.mil"].some(domain => instance.hostname.endsWith(`.${domain}`))) {
        throw new SalesforceAuthorizationError(401, "A Salesforce HTTPS instance URL is required.");
      }
      const response = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new SalesforceAuthorizationError(401, "Explicit Salesforce token failed authorization.");
      const identity = await response.json() as { organization_id?: string };
      const orgId = identity.organization_id;
      if (!orgId || !/^[A-Za-z0-9]{15,18}$/.test(orgId)) throw new SalesforceAuthorizationError(401, "Salesforce did not identify the token organization.");
      if (options.orgId && options.orgId.slice(0, 15) !== orgId.slice(0, 15)) throw new SalesforceAuthorizationError(403, "Salesforce token does not authorize the requested organization.");
      return {
        connection: { accessToken, instanceUrl, orgId },
        channelId: options.channelId,
        orgId,
        teamId: options.teamId,
      };
    }

    const channelId = (options.channelId || options.agentName)?.trim();
    if (!channelId) throw new Error("A Salesforce channelId is required.");
    if (!options.teamId || !options.orgId) {
      throw new Error("A teamId and orgId are required to resolve a Salesforce channel.");
    }
    const auth = this.env.TUBOT_SF_AUTH;
    if (!auth?.getTokenForChannel) throw new Error("The tubot-sf-auth service binding is unavailable.");
    const scope = { teamId: options.teamId, orgId: options.orgId };
    const token = await auth.getTokenForChannel(channelId, scope, await this.sign(scope.orgId, "getTokenForChannel", [channelId, scope]));
    if (!token?.accessToken || !token.instanceUrl || token.orgId !== options.orgId || token.teamId !== options.teamId) {
      throw new Error("tubot-sf-auth did not return a token for the requested tenant scope.");
    }
    return {
      connection: {
        accessToken: token.accessToken,
        instanceUrl: token.instanceUrl.replace(/\/+$/, ""),
        orgId: token.orgId,
      },
      channelId,
      orgId: token.orgId,
      teamId: token.teamId,
    };
  }

  async getUserConversationHistory(
    userId: string,
    options?: { channelId?: string; currentSessionId?: string; limit?: number; teamId?: string; orgId?: string },
  ): Promise<any> {
    if (!options?.teamId || !options.orgId) {
      throw new Error("A teamId and orgId are required to resolve Salesforce conversation history.");
    }
    const auth = this.env.TUBOT_SF_AUTH;
    if (!auth?.getUserConversationHistory) throw new Error("The tubot-sf-auth RPC is unavailable.");
    const scoped = options as { teamId: string; orgId: string; channelId?: string; currentSessionId?: string; limit?: number };
    return auth.getUserConversationHistory(userId, scoped,
      await this.sign(scoped.orgId, "getUserConversationHistory", [userId, scoped]));
  }

  async getCallableToolUrls(
    channelId: string,
    options?: { orgId?: string; teamId?: string },
  ): Promise<string[]> {
    if (!channelId) return [];
    if (!options?.teamId || !options.orgId) throw new Error("A complete tenant scope is required for callable tools.");
    const auth = this.env.TUBOT_SF_AUTH;
    if (!auth?.getCallableToolUrlsForChannel) throw new Error("The tubot-sf-auth callable-tool RPC is unavailable.");
    const scoped = options as { teamId: string; orgId: string };
    const urls = await auth.getCallableToolUrlsForChannel(channelId, scoped,
      await this.sign(scoped.orgId, "getCallableToolUrlsForChannel", [channelId, scoped]));
    if (!Array.isArray(urls)) throw new Error("tubot-sf-auth returned an invalid callable-tool response.");
    return urls;
  }
}
