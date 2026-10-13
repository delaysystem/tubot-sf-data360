import type { Data360Env, ExportData360Options, SalesforceConnection } from "./types";

export interface ResolvedAuthResult {
  connection: SalesforceConnection;
  channelId?: string;
  orgId?: string;
  teamId?: string;
}

export class SalesforceAuthBridge {
  constructor(private readonly env: Data360Env) {}

  async resolveToken(options: ExportData360Options): Promise<ResolvedAuthResult> {
    if (options.accessToken && options.instanceUrl) {
      const accessToken = options.accessToken.replace(/^Bearer\s+/i, "").trim();
      const instanceUrl = options.instanceUrl.replace(/\/+$/, "").trim();
      const response = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error(`Explicit Salesforce token failed authorization (${response.status}).`);
      return {
        connection: { accessToken, instanceUrl, orgId: options.orgId },
        channelId: options.channelId,
        orgId: options.orgId,
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
    const token = await auth.getTokenForChannel(channelId, { teamId: options.teamId, orgId: options.orgId });
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
    return auth.getUserConversationHistory(userId, options);
  }

  async getCallableToolUrls(
    channelId: string,
    options?: { orgId?: string; teamId?: string },
  ): Promise<string[]> {
    if (!channelId) return [];
    if (!options?.teamId || !options.orgId) throw new Error("A complete tenant scope is required for callable tools.");
    const auth = this.env.TUBOT_SF_AUTH;
    if (!auth?.getCallableToolUrlsForChannel) throw new Error("The tubot-sf-auth callable-tool RPC is unavailable.");
    const urls = await auth.getCallableToolUrlsForChannel(channelId, options);
    if (!Array.isArray(urls)) throw new Error("tubot-sf-auth returned an invalid callable-tool response.");
    return urls;
  }
}
