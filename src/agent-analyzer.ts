import type {
  Data360DiscoveredElements,
  SalesforceConnection,
} from "./types";
import { SalesforceBatchClient } from "./batch-client";

export class AgentAnalyzer {
  constructor(private readonly batchClient = new SalesforceBatchClient()) {}

  /**
   * Resolves the agent developer name and messaging channel record from a channel ID or agent name.
   */
  async resolveChannelAndAgent(
    conn: SalesforceConnection,
    identifier: string,
    apiVersion: string = SalesforceBatchClient.DEFAULT_API_VERSION
  ): Promise<{
    agentName: string;
    channelRecord?: any;
    channelDeveloperName?: string;
  }> {
    const clean = identifier.trim();
    if (!clean) {
      throw new Error("Target identifier cannot be empty.");
    }

    const esc = clean.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const isId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(clean);
    const idClause = isId ? ` OR Id = '${esc}'` : "";

    // 1. Run batched queries across MessagingChannel, BotDefinition, and Custom Settings
    const queries = [
      `SELECT Id, DeveloperName, MasterLabel, SessionHandlerId, MessageType, TargetType FROM MessagingChannel WHERE DeveloperName = '${esc}' OR MasterLabel = '${esc}'${idClause} LIMIT 1`,
      `SELECT Id, DeveloperName, MasterLabel FROM BotDefinition WHERE DeveloperName = '${esc}' OR MasterLabel = '${esc}'${idClause} LIMIT 1`,
      `SELECT Id, Name, tubot__Agent_Name__c FROM tubot__Agentforce_Agent_Select__c WHERE Name = '${esc}' OR tubot__Deployment_Label__c = '${esc}' LIMIT 1`,
      `SELECT Id, Name, Agent_Name__c FROM Agentforce_Agent_Select__c WHERE Name = '${esc}' OR Deployment_Label__c = '${esc}' LIMIT 1`,
    ];

    const results = await this.batchClient.batchQueries(conn, queries, apiVersion);
    const channelRecords = results[0]?.records || [];
    const botRecords = results[1]?.records || [];
    const namespacedSelects = results[2]?.records || [];
    const unnamespacedSelects = results[3]?.records || [];

    // Case A: Found a MessagingChannel
    if (channelRecords.length > 0) {
      const channel = channelRecords[0];
      const sessionHandlerId = channel.SessionHandlerId;

      // Check if sessionHandlerId points to a BotDefinition (0Xx prefix)
      if (sessionHandlerId && typeof sessionHandlerId === "string" && sessionHandlerId.startsWith("0Xx")) {
        try {
          const bots = await this.batchClient.querySingle(
            conn,
            `SELECT Id, DeveloperName FROM BotDefinition WHERE Id = '${sessionHandlerId}' LIMIT 1`,
            apiVersion
          );
          if (bots.length > 0 && bots[0].DeveloperName) {
            return {
              agentName: bots[0].DeveloperName,
              channelRecord: channel,
              channelDeveloperName: channel.DeveloperName,
            };
          }
        } catch {}
      }

      // Check custom setting for channel mapping
      const channelName = channel.DeveloperName || channel.MasterLabel;
      const matchedSelect =
        namespacedSelects.find((s) => s.Name === channelName || s.Name === clean) ||
        unnamespacedSelects.find((s) => s.Name === channelName || s.Name === clean);

      const agentFromSetting = matchedSelect?.tubot__Agent_Name__c || matchedSelect?.Agent_Name__c;
      if (agentFromSetting) {
        return {
          agentName: agentFromSetting,
          channelRecord: channel,
          channelDeveloperName: channel.DeveloperName,
        };
      }

      // If no handler matched directly, default to channel name as candidate
      return {
        agentName: channel.DeveloperName || clean,
        channelRecord: channel,
        channelDeveloperName: channel.DeveloperName,
      };
    }

    // Case B: Found a BotDefinition directly
    if (botRecords.length > 0 && botRecords[0].DeveloperName) {
      return {
        agentName: botRecords[0].DeveloperName,
      };
    }

    // Case C: Matched custom setting directly
    const directSetting = namespacedSelects[0] || unnamespacedSelects[0];
    const directAgent = directSetting?.tubot__Agent_Name__c || directSetting?.Agent_Name__c;
    if (directAgent) {
      return { agentName: directAgent };
    }

    // Fallback: Return raw identifier as agent name
    return { agentName: clean };
  }

  /**
   * Analyzes an Agent Script and associated prompt templates to discover
   * referenced Data 360 DMOs, Market Segments, actions, and prompt templates.
   */
  analyzeAgentScript(
    script: string,
    promptTemplates?: Record<string, string>
  ): Data360DiscoveredElements {
    const dmoNames = new Set<string>();
    const referencedSegmentIds = new Set<string>();
    const referencedSegmentNames = new Set<string>();
    const actions = new Set<string>();
    const promptTemplateNames = new Set<string>();

    // Standard Data 360 Core DMOs
    const defaultCoreDmos = [
      "ssot__Individual__dlm",
      "ssot__ContactPointEmail__dlm",
      "ssot__ContactPointPhone__dlm",
      "ssot__SalesOrder__dlm",
      "ssot__SalesOrderProduct__dlm",
    ];
    defaultCoreDmos.forEach((d) => dmoNames.add(d));

    if (!script) {
      return {
        dmoNames: Array.from(dmoNames),
        referencedSegmentIds: [],
        referencedSegmentNames: [],
        actions: [],
        promptTemplateNames: [],
      };
    }

    // 1. Discover DMOs via regex: ssot__*__dlm, *__dlm, *__dlo
    const dmoMatches = script.matchAll(/\b([a-zA-Z0-9_]+__(?:dlm|dlo))\b/g);
    for (const match of dmoMatches) {
      if (match[1]) dmoNames.add(match[1]);
    }

    // 2. Discover segment_on_entity variable
    const segOnMatch = script.match(/segment_on_entity(?:\s*:\s*mutable\s*string\s*=\s*["']([^"']+)["']|\s*=\s*["']([^"']+)["'])/i);
    if (segOnMatch) {
      const foundEntity = segOnMatch[1] || segOnMatch[2];
      if (foundEntity && foundEntity.trim()) {
        dmoNames.add(foundEntity.trim());
      }
    }

    // 3. Discover MarketSegment IDs: 1sg prefix followed by 12 or 15 alphanumerics
    const segmentIdMatches = script.matchAll(/\b(1sg[a-zA-Z0-9]{12,15})\b/g);
    for (const match of segmentIdMatches) {
      if (match[1]) referencedSegmentIds.add(match[1]);
    }

    // 4. Discover segmentId variable default
    const segVarMatch = script.match(/segmentId(?:\s*:\s*mutable\s*string\s*=\s*["']([^"']+)["']|\s*=\s*["']([^"']+)["'])/i);
    if (segVarMatch) {
      const foundId = segVarMatch[1] || segVarMatch[2];
      if (foundId && foundId.trim()) {
        referencedSegmentIds.add(foundId.trim());
      }
    }

    // 5. Discover Data Cloud and CDP actions
    const actionMatches = script.matchAll(/(?:target|source)\s*:\s*["']([^"']+)["']/g);
    for (const match of actionMatches) {
      const val = match[1];
      if (
        val.toLowerCase().includes("cdp") ||
        val.toLowerCase().includes("datacloud") ||
        val.toLowerCase().includes("segment")
      ) {
        actions.add(val);
      }
    }

    // 6. Discover prompt templates referenced: @promptTemplates.<Name>
    const ptMatches = script.matchAll(/@promptTemplates\.([a-zA-Z0-9_]+)/g);
    for (const match of ptMatches) {
      if (match[1]) promptTemplateNames.add(match[1]);
    }

    // Also include any prompt templates passed in the map
    if (promptTemplates) {
      for (const name of Object.keys(promptTemplates)) {
        promptTemplateNames.add(name);
      }
    }

    return {
      dmoNames: Array.from(dmoNames),
      referencedSegmentIds: Array.from(referencedSegmentIds),
      referencedSegmentNames: Array.from(referencedSegmentNames),
      actions: Array.from(actions),
      promptTemplateNames: Array.from(promptTemplateNames),
    };
  }
}
