import type {
  AgentArtifacts,
  Data360Metadata,
  Data360Records,
  ExportData360Options,
  ExportManifest,
  ExtractedData360Package,
  ExtractedUnstructuredFile,
  SalesforceConnection,
  BatchSubrequest,
  UserData360Result,
  MessagingSessionData360Result,
} from "./types";
import { SalesforceBatchClient } from "./batch-client";
import { AgentAnalyzer } from "./agent-analyzer";
import { ZipBuilder } from "./zip-builder";
import { DataCloudClient } from "./data-cloud-client";
import { UnstructuredExtractor } from "./unstructured-extractor";
import { B2CacheManager } from "./b2-cache-manager";
import { getAgentScripts, getCallableToolUrlsForChannel } from "../../tubot-sf-auth/src/agent-script";

export class Data360Extractor {
  constructor(
    private readonly batchClient = new SalesforceBatchClient(),
    private readonly agentAnalyzer = new AgentAnalyzer(batchClient),
    private readonly unstructuredExtractor = new UnstructuredExtractor(),
    private readonly b2CacheManager?: B2CacheManager
  ) {}

  /**
   * Main pipeline to extract Data 360 data, schemas, and agent definitions,
   * returning an assembled and zipped package.
   */
  async extractData360(
    conn: SalesforceConnection,
    options: ExportData360Options
  ): Promise<ExtractedData360Package> {
    const apiVersion = options.apiVersion || SalesforceBatchClient.DEFAULT_API_VERSION;
    const maxRecords = options.maxRecords || 500;
    const warnings: string[] = [];
    let totalBatchRequests = 0;
    let totalSubrequests = 0;

    const targetIdentifier = options.channelId || options.agentName;
    if (!targetIdentifier) {
      throw new Error("Either channelId or agentName must be specified for Data 360 extraction.");
    }

    // Step 1: Resolve Channel and Agent Name
    const resolved = await this.agentAnalyzer.resolveChannelAndAgent(conn, targetIdentifier, apiVersion);
    const agentName = resolved.agentName;
    const channelRecord = resolved.channelRecord;
    const channelDeveloperName = resolved.channelDeveloperName;

    // Step 2: Retrieve Agent Scripts and Metadata (SOAP retrieve)
    let agentArtifacts: AgentArtifacts = {
      agentName,
      channelName: channelDeveloperName || options.channelId,
    };

    try {
      const retrieveResult = await getAgentScripts(conn, {
        agentNames: [agentName],
        channelNames: channelDeveloperName ? [channelDeveloperName] : undefined,
        apiVersion: apiVersion.replace(/^v/, ""),
        maxPollAttempts: 3,
        pollIntervalMs: 800,
      });

      if (retrieveResult.ok && retrieveResult.scripts[agentName]) {
        const s = retrieveResult.scripts[agentName];
        agentArtifacts = {
          ...agentArtifacts,
          script: s.script,
          bundleMetaXml: s.bundleMetaXml,
          botXml: s.botXml,
          format: s.format,
          promptTemplates: s.promptTemplates,
          agentGraph: s.agentGraph,
          localActions: s.localActions,
          rawFiles: s.rawFiles,
        };
      }
    } catch (err: unknown) {
      warnings.push(`Agent script retrieve encountered an issue: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Retrieve callable tools if channel is known and tools are requested
    if (options.includeTools !== false && (options.channelId || channelRecord?.Id)) {
      try {
        const channelLookupId = channelRecord?.Id || options.channelId!;
        const toolUrls = await getCallableToolUrlsForChannel(channelLookupId, {
          conn,
          apiVersion: apiVersion.replace(/^v/, ""),
          maxPollAttempts: 15,
          pollIntervalMs: 1000,
        });

        if (Array.isArray(toolUrls) && toolUrls.length > 0) {
          agentArtifacts.callableTools = toolUrls.map((url) => ({ url }));
        }
      } catch (err: unknown) {
        warnings.push(`Callable tools lookup skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 3: Discover Data 360 DMOs, Segments, and Actions from Script
    const discovered = this.agentAnalyzer.analyzeAgentScript(
      agentArtifacts.script || "",
      agentArtifacts.promptTemplates
    );

    const dataCloudClient = new DataCloudClient(conn, apiVersion);
    const catalog = options.includeMetadata !== false || options.includeDataCloudRecords !== false
      ? await dataCloudClient.discover()
      : { dataSpaces: [], objects: [], identityResolutions: [], warnings: [] };
    warnings.push(...catalog.warnings);
    const models = catalog.objects.filter(o => ["dmo", "unified-dmo", "link-dmo", "udmo"].includes(o.family));
    const allDmoNames = [...new Set(models.map(o => o.name))];

    // Step 4: Batched Metadata Retrieval
    const metadata: Data360Metadata = {
      channel: channelRecord,
      dataSpaces: options.includeMetadata !== false ? catalog.dataSpaces : [],
      dataStreams: [],
      dataLakeMappings: [],
      marketSegments: [],
      calculatedInsights: catalog.objects.filter(o => o.family === "calculated-insight").map(o => o.metadata),
      dataLakeObjects: catalog.objects.filter(o => o.family === "dlo").map(o => o.metadata),
      dataModelObjects: models.map(o => o.metadata),
      dataGraphs: catalog.objects.filter(o => o.family === "data-graph").map(o => o.metadata),
      dataCloudObjects: catalog.objects,
      identityResolutionRules: catalog.identityResolutions,
      dmoDescribes: Object.fromEntries(models.filter(o => o.metadata.isEnabled !== false).map(o => [o.storageKey, o.metadata])),
      dmoCatalog: models.map(({ name, dataSpace, family, storageKey }) => ({ name, dataSpace, family, storageKey })),
    };

    if (options.includeMetadata !== false) {
      const metadataSubrequests: BatchSubrequest[] = [
        // 0: DataSpace
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, Description, CreatedDate FROM DataSpace LIMIT 50")}`,
        },
        // 1: MarketSegment
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, Description, IncludeCriteria, ExcludeCriteria, SegmentStatus, LastSegmentMemberCount, MarketSegmentType, PublishType, DataSpaceId, SegmentMembershipTable, CreatedDate, LastModifiedDate FROM MarketSegment LIMIT 100")}`,
        },
        // 2: CalculatedInsight
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, CalculatedInsightStatus, LastRunStatus FROM MktCalculatedInsight LIMIT 50")}`,
        },
        // 3: IdentityResolutionRuleset
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, Status, LastRunStatus FROM IdentityResolution LIMIT 50")}`,
        },
        // 4: DataStream
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, DataStreamStatus, StreamType, ImportRunStatus FROM DataStream LIMIT 50")}`,
        },
        // 5: MktDataLakeMapping
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, SourceObject, TargetObject FROM MktDataLakeMapping LIMIT 50")}`,
        },
      ];

      totalSubrequests += metadataSubrequests.length;
      totalBatchRequests += Math.ceil(metadataSubrequests.length / SalesforceBatchClient.MAX_BATCH_SIZE);

      const metaResponses = await this.batchClient.executeBatch(conn, metadataSubrequests, apiVersion);

      // Process DataSpace
      if (metaResponses[0]?.statusCode === 200 && Array.isArray(metaResponses[0].result?.records)) {
        metadata.dataSpaces = metaResponses[0].result.records;
      }

      // Process MarketSegment
      if (metaResponses[1]?.statusCode === 200 && Array.isArray(metaResponses[1].result?.records)) {
        metadata.marketSegments = metaResponses[1].result.records;
      }

      // Process IdentityResolutionRuleset
      if (metaResponses[3]?.statusCode === 200 && Array.isArray(metaResponses[3].result?.records)) {
        metadata.identityResolutionRules = metaResponses[3].result.records;
      }

      // Process DataStream
      if (metaResponses[4]?.statusCode === 200 && Array.isArray(metaResponses[4].result?.records)) {
        metadata.dataStreams = metaResponses[4].result.records;
      }

      // Process MktDataLakeMapping
      if (metaResponses[5]?.statusCode === 200 && Array.isArray(metaResponses[5].result?.records)) {
        metadata.dataLakeMappings = metaResponses[5].result.records;
      }

    }

    // Step 5: Batched Customer 360 Records Retrieval
    const records: Data360Records = {
      crm: {
        individuals: [],
        contactPointEmails: [],
        contactPointPhones: [],
        orders: [],
        orderItems: [],
        leads: [],
        accounts: [],
        messagingSessions: [],
      },
      dataCloud: {},
    };

    if (options.includeCrmRecords !== false) {
      const channelIdFilter = channelRecord?.Id || (options.channelId && options.channelId.startsWith("0Mj") ? options.channelId : "");

      const crmSubrequests: BatchSubrequest[] = [
        // 0: Individual
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, FirstName, LastName, Salutation, CreatedDate FROM Individual LIMIT ${maxRecords}`)}`,
        },
        // 1: ContactPointEmail
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, ParentId, EmailAddress, IsPrimary, CreatedDate FROM ContactPointEmail LIMIT ${maxRecords}`)}`,
        },
        // 2: ContactPointPhone
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, ParentId, TelephoneNumber, FormattedInternationalPhoneNumber, IsPrimary, CreatedDate FROM ContactPointPhone LIMIT ${maxRecords}`)}`,
        },
        // 3: Order
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, AccountId, Status, TotalAmount, EffectiveDate, CreatedDate FROM Order LIMIT ${maxRecords}`)}`,
        },
        // 4: OrderItem
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, OrderId, Product2Id, Quantity, UnitPrice, TotalPrice FROM OrderItem LIMIT ${maxRecords}`)}`,
        },
        // 5: Lead
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, Name, Company, Email, Phone, City, Country, Status, CreatedDate FROM Lead LIMIT ${maxRecords}`)}`,
        },
        // 6: Account
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(`SELECT Id, Name, Type, Phone, CreatedDate FROM Account LIMIT ${maxRecords}`)}`,
        },
        // 7: MessagingSession (if channel filter available)
        {
          method: "GET",
          url: `${apiVersion}/query?q=${encodeURIComponent(
            channelIdFilter
              ? `SELECT Id, ChannelName, ChannelType, Status, CreatedDate FROM MessagingSession WHERE MessagingChannelId = '${channelIdFilter}' LIMIT 200`
              : `SELECT Id, ChannelName, ChannelType, Status, CreatedDate FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 100`
          )}`,
        },
      ];

      totalSubrequests += crmSubrequests.length;
      totalBatchRequests += Math.ceil(crmSubrequests.length / SalesforceBatchClient.MAX_BATCH_SIZE);

      const crmResponses = await this.batchClient.executeBatch(conn, crmSubrequests, apiVersion);

      if (crmResponses[0]?.statusCode === 200) records.crm.individuals = crmResponses[0].result?.records || [];
      if (crmResponses[1]?.statusCode === 200) records.crm.contactPointEmails = crmResponses[1].result?.records || [];
      if (crmResponses[2]?.statusCode === 200) records.crm.contactPointPhones = crmResponses[2].result?.records || [];
      if (crmResponses[3]?.statusCode === 200) records.crm.orders = crmResponses[3].result?.records || [];
      if (crmResponses[4]?.statusCode === 200) records.crm.orderItems = crmResponses[4].result?.records || [];
      if (crmResponses[5]?.statusCode === 200) records.crm.leads = crmResponses[5].result?.records || [];
      if (crmResponses[6]?.statusCode === 200) records.crm.accounts = crmResponses[6].result?.records || [];
      if (crmResponses[7]?.statusCode === 200) records.crm.messagingSessions = crmResponses[7].result?.records || [];
    }

    // Data 360 retrieval is owned by the worker, including B2-bound snapshots.
    if (options.includeDataCloudRecords !== false) {
      const retrieved = await dataCloudClient.retrieve(catalog.objects, discovered.dmoNames, maxRecords);
      records.dataCloud = retrieved.dataCloud;
      records.dataGraphs = retrieved.dataGraphs;
      warnings.push(...retrieved.warnings);
    }

    // Step 7: Unstructured Files Extraction (PDF, images, documents, text, static resources)
    let unstructuredFiles: ExtractedUnstructuredFile[] = [];
    if (options.includeUnstructuredFiles !== false) {
      try {
        unstructuredFiles = await this.unstructuredExtractor.extractAllFiles(conn, {
          maxFiles: options.maxUnstructuredFiles ?? 15,
          apiVersion,
        });
      } catch (err: unknown) {
        warnings.push(`Unstructured files extraction encountered an issue: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 8: Build Manifest
    let fileCount = 1; // manifest.json
    if (options.includeAgentScript && agentArtifacts.script) fileCount++;
    if (options.includeAgentXml && agentArtifacts.bundleMetaXml) fileCount++;
    if (options.includeAgentXml && agentArtifacts.botXml) fileCount++;
    if (options.includeAgentXml && agentArtifacts.promptTemplates) fileCount += Object.keys(agentArtifacts.promptTemplates).length;
    if (options.includeTools !== false && agentArtifacts.callableTools?.length) fileCount++;
    if (metadata.channel) fileCount++;
    fileCount += 4; // dataSpaces, marketSegments, calculatedInsights, identityResolution
    if (metadata.dataStreams?.length) fileCount++;
    if (metadata.dataLakeMappings?.length) fileCount++;
    fileCount += Object.keys(metadata.dmoDescribes).length;
    fileCount += 8; // crm records
    fileCount += Object.keys(records.dataCloud).length;
    if (unstructuredFiles.length > 0) {
      fileCount += unstructuredFiles.length + 1; // +1 for files-manifest.json
    }

    const unstructuredFileCounts = {
      total: unstructuredFiles.length,
      pdf: unstructuredFiles.filter((f) => f.category === "pdf").length,
      image: unstructuredFiles.filter((f) => f.category === "image").length,
      document: unstructuredFiles.filter((f) => f.category === "document").length,
      text: unstructuredFiles.filter((f) => f.category === "text").length,
      other: unstructuredFiles.filter((f) => !["pdf", "image", "document", "text"].includes(f.category)).length,
      totalBytes: unstructuredFiles.reduce((sum, f) => sum + (f.contentSize || 0), 0),
    };

    const manifest: ExportManifest = {
      version: "2.0.0",
      exportTimestamp: new Date().toISOString(),
      target: {
        channelId: options.channelId,
        channelDeveloperName,
        agentName,
      },
      salesforce: {
        instanceUrl: conn.instanceUrl,
        apiVersion,
        orgId: conn.orgId,
      },
      summary: {
        agentFormat: agentArtifacts.format || "unknown",
        dmoCount: allDmoNames.length,
        dmos: allDmoNames,
        marketSegmentCount: metadata.marketSegments.length,
        dataSpaceCount: metadata.dataSpaces.length,
        dataStreamCount: metadata.dataStreams?.length || 0,
        crmRecordCounts: {
          individuals: records.crm.individuals.length,
          contactPointEmails: records.crm.contactPointEmails.length,
          contactPointPhones: records.crm.contactPointPhones.length,
          orders: records.crm.orders.length,
          orderItems: records.crm.orderItems.length,
          leads: records.crm.leads.length,
          accounts: records.crm.accounts.length,
          messagingSessions: records.crm.messagingSessions.length,
        },
        dataGraphRecordCounts: Object.fromEntries(Object.entries(records.dataGraphs ?? {}).map(([name, rows]) => [name, rows.length])),
        dataCloudRecordCounts: Object.fromEntries(
          Object.entries(records.dataCloud).map(([k, v]) => [k, v.length])
        ),
        unstructuredFileCounts,
        totalBatchRequests,
        totalSubrequests,
        fileCount,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    const pkg: ExtractedData360Package = {
      manifest,
      agent: agentArtifacts,
      metadata,
      records,
      unstructuredFiles,
    };

    // Step 9: Build ZIP if format is zip (default)
    if (options.format !== "json") {
      pkg.zipBytes = ZipBuilder.buildZip(pkg, options);
    }

    // Step 10: Cache to Backblaze B2 Private Bucket (if requested)
    if (options.cacheToB2) {
      try {
        const cacheMgr = this.b2CacheManager || new B2CacheManager();
        const b2Meta = await cacheMgr.savePackage(pkg, {
          ttlSeconds: options.cacheTtlSeconds,
        });
        pkg.b2Cache = b2Meta;
        manifest.b2Cache = b2Meta;
      } catch (err: unknown) {
        throw new Error(`B2 snapshot storage failed: ${err instanceof Error ? err.message : "upstream storage error"}`);
      }
    }

    return pkg;
  }

  /**
   * Extracts Data 360 profile for a specific user ID across Individual, Contact, Lead,
   * ContactPointEmail, ContactPointPhone, and Data Cloud Unified Individual DMOs.
   */
  async extractUserData360(
    conn: SalesforceConnection,
    userId: string,
    options?: { apiVersion?: string; orgId?: string }
  ): Promise<UserData360Result> {
    const apiVersion = options?.apiVersion || SalesforceBatchClient.DEFAULT_API_VERSION;
    const cleanUserId = userId.trim();

    // 1. Batch query CRM records: Individual, Contact, Lead, ContactPointEmail, ContactPointPhone
    const crmQueries = [
      // 0: Individual
      `SELECT Id, FirstName, LastName, Salutation, CreatedDate FROM Individual WHERE Id = '${cleanUserId}'`,
      // 1: Contact
      `SELECT Id, FirstName, LastName, Email, Phone, AccountId, IndividualId, CreatedDate FROM Contact WHERE Id = '${cleanUserId}' OR IndividualId = '${cleanUserId}'`,
      // 2: Lead
      `SELECT Id, FirstName, LastName, Company, Email, Phone, Status, IndividualId, CreatedDate FROM Lead WHERE Id = '${cleanUserId}' OR IndividualId = '${cleanUserId}'`,
      // 3: ContactPointEmail
      `SELECT Id, ParentId, EmailAddress, IsPrimary, CreatedDate FROM ContactPointEmail WHERE ParentId = '${cleanUserId}' OR Id = '${cleanUserId}'`,
      // 4: ContactPointPhone
      `SELECT Id, ParentId, TelephoneNumber, FormattedInternationalPhoneNumber, IsPrimary, CreatedDate FROM ContactPointPhone WHERE ParentId = '${cleanUserId}' OR Id = '${cleanUserId}'`,
    ];

    const queryResults = await this.batchClient.batchQueries(conn, crmQueries, apiVersion);

    let individual = queryResults[0]?.records?.[0] || null;
    let contact = queryResults[1]?.records?.[0] || null;
    let lead = queryResults[2]?.records?.[0] || null;
    let contactPointEmails = queryResults[3]?.records || [];
    let contactPointPhones = queryResults[4]?.records || [];

    // If individual was not directly matched by Id, but Contact/Lead has an IndividualId, look that up
    const linkedIndividualId = contact?.IndividualId || lead?.IndividualId;
    if (!individual && linkedIndividualId && linkedIndividualId !== cleanUserId) {
      try {
        const indQueries = [
          `SELECT Id, FirstName, LastName, Salutation, CreatedDate FROM Individual WHERE Id = '${linkedIndividualId}'`,
          `SELECT Id, ParentId, EmailAddress, IsPrimary, CreatedDate FROM ContactPointEmail WHERE ParentId = '${linkedIndividualId}'`,
          `SELECT Id, ParentId, TelephoneNumber, FormattedInternationalPhoneNumber, IsPrimary, CreatedDate FROM ContactPointPhone WHERE ParentId = '${linkedIndividualId}'`,
        ];
        const indResults = await this.batchClient.batchQueries(conn, indQueries, apiVersion);
        if (indResults[0]?.records?.[0]) {
          individual = indResults[0].records[0];
        }
        if (indResults[1]?.records?.length) {
          contactPointEmails = [...contactPointEmails, ...indResults[1].records];
        }
        if (indResults[2]?.records?.length) {
          contactPointPhones = [...contactPointPhones, ...indResults[2].records];
        }
      } catch {}
    }

    // 2. Query Data Cloud Unified Individual (ssot__Individual__dlm / UnifiedIndividual__dlm)
    const unifiedIndividual: any[] = [];
    const dmoCandidates = ["ssot__Individual__dlm", "UnifiedIndividual__dlm"];

    for (const dmo of dmoCandidates) {
      try {
        const sqlRes = await fetch(`${conn.instanceUrl}/services/data/${apiVersion}/ssot/queryv2`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${conn.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            sql: `SELECT * FROM ${dmo} WHERE ssot__Id__c = '${cleanUserId}' OR Id__c = '${cleanUserId}' LIMIT 10`,
          }),
        });

        if (sqlRes.ok) {
          const sqlData = (await sqlRes.json()) as any;
          if (Array.isArray(sqlData?.data) && sqlData.data.length > 0) {
            unifiedIndividual.push(...sqlData.data);
          }
        }
      } catch {}
    }

    return {
      userId: cleanUserId,
      individual,
      contact,
      lead,
      contactPointEmails,
      contactPointPhones,
      unifiedIndividual,
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Extracts MessagingSession details, conversation transcript entries,
   * and links associated customer 360 data.
   */
  async extractMessagingSessionData360(
    conn: SalesforceConnection,
    sessionId: string,
    options?: { apiVersion?: string; orgId?: string }
  ): Promise<MessagingSessionData360Result> {
    const apiVersion = options?.apiVersion || SalesforceBatchClient.DEFAULT_API_VERSION;
    const cleanSessionId = sessionId.trim();

    // 1. Query MessagingSession and ConversationEntry (transcripts)
    const queries = [
      `SELECT Id, ChannelName, ChannelType, Status, StartTime, EndTime, EndTimeReason, MessagingEndUserId, ContactId, LeadId, CaseId FROM MessagingSession WHERE Id = '${cleanSessionId}'`,
      `SELECT Id, ConversationId, EntryType, MessageText, ActorType, ActorName, ClientTimestamp, CreatedDate FROM ConversationEntry WHERE ConversationId = '${cleanSessionId}' ORDER BY CreatedDate ASC`,
    ];

    const results = await this.batchClient.batchQueries(conn, queries, apiVersion);

    const session = results[0]?.records?.[0] || null;
    const transcripts = results[1]?.records || [];

    // 2. Link Customer 360 data
    let customer360: UserData360Result | null = null;
    if (session) {
      // Check if MessagingEndUser can resolve ContactId or LeadId if missing
      if (!session.ContactId && !session.LeadId && session.MessagingEndUserId) {
        try {
          const meuRecords = await this.batchClient.querySingle(
            conn,
            `SELECT Id, Name, ContactId, LeadId, MessageType FROM MessagingEndUser WHERE Id = '${session.MessagingEndUserId}'`,
            apiVersion
          );
          if (meuRecords[0]?.ContactId) session.ContactId = meuRecords[0].ContactId;
          if (meuRecords[0]?.LeadId) session.LeadId = meuRecords[0].LeadId;
        } catch {}
      }

      const targetUserId = session.ContactId || session.LeadId || session.MessagingEndUserId;
      if (targetUserId) {
        try {
          customer360 = await this.extractUserData360(conn, targetUserId, options);
        } catch (err) {
          console.warn(`Failed to extract customer360 for session ${cleanSessionId}:`, err);
        }
      }
    }

    return {
      sessionId: cleanSessionId,
      session,
      transcripts,
      customer360,
      extractedAt: new Date().toISOString(),
    };
  }
}
