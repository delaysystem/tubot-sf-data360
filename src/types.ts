import type { RpcSignedEnvelope } from "./rpc-sign";

export interface SalesforceConnection {
  instanceUrl: string;
  accessToken: string;
  orgId?: string;
}

export interface Data360Env {
  SF_AUTH_CALLER_KEY?: string;
  TUBOT_SF_AUTH?: {
    getTokenForChannel?(channelId: string, options?: { teamId: string; orgId: string }, signed?: RpcSignedEnvelope): Promise<any>;
    getCallableToolUrlsForChannel?(channelId: string, options?: { teamId: string; orgId: string }, signed?: RpcSignedEnvelope): Promise<string[]>;
    getUserConversationHistory?(userId: string, options?: {
      teamId: string; orgId: string; channelId?: string; currentSessionId?: string; limit?: number;
    }, signed?: RpcSignedEnvelope): Promise<any>;
  };
  TUBOT_SF_PARSER?: {
    translateToCel?(content: string, options?: any): Promise<any>;
    fetch?(input: any, init?: any): Promise<Response>;
  };
  DB?: D1Database;
  DATA360_INTERNAL_KEY?: string;
  DATA360_INTERNAL_KEY_NEXT?: string;
  SF_CREDENTIAL_ENCRYPTION_KEY?: string;
  PARSER_SERVICE_URL?: string;
  BACKBLAZE_APPLICATION_KEY?: string;
  BACKBLAZE_KEY_ID?: string;
  BACKBLAZE_BUCKET_ID?: string;
  BACKBLAZE_BUCKET_NAME?: string;
  BACKBLAZE_ENDPOINT?: string;
  DATA360_PATH_PREFIX?: string;
  CACHE_TO_B2_BY_DEFAULT?: string;
}


export interface ConversationMessageEntry {
  id?: string;
  senderType: "user" | "agent" | "bot" | "system";
  message: string;
  timestamp: string;
  actorId?: string;
  actorName?: string;
  metadata?: Record<string, any>;
}

export interface UserSessionConversation {
  sessionId: string;
  channelId?: string;
  startTime: string;
  endTime?: string;
  status?: string;
  messages: ConversationMessageEntry[];
  metadata?: Record<string, any>;
}

export interface UserConversationHistory {
  userId: string;
  sessions: UserSessionConversation[];
  totalSessions: number;
  totalMessages: number;
  lastActiveAt?: string;
  extractedAt: string;
}

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Context: Non-negotiable requirements for tubot-agentcode to run.
 * tubot-sf-data360 provides and smartly caches all 5 components:
 * 1. precompiledAgent: compiled Google CEL AST & rules from tubot-sf-parser
 * 2. customerData: customer 360 profile / variables
 * 3. conversationHistory: customer multi-turn messages
 * 4. globalData: org/channel level config & data cloud schema
 * 5. toolCallUrls: verified callable tool proxy URLs from tubot-sf-auth / retrieve64
 */
export interface Context {
  precompiledAgent: any;
  customerData: Record<string, any>;
  conversationHistory: ContextMessage[];
  globalData: Record<string, any>;
  toolCallUrls: string[];
  currentTopic?: string;
  actionOutputs?: Record<string, any>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GetContextOptions extends ExportData360Options {
  userId: string;
  channelId?: string;
  agentName?: string;
  sessionId?: string;
  agentScript?: string;
  agentXml?: string;
  bypassCache?: boolean;
  bypassAgentCache?: boolean;
  bypassToolUrlsCache?: boolean;
  bypassUserCache?: boolean;
  bypassConversationCache?: boolean;
  bypassGlobalCache?: boolean;
  conversationLimit?: number;
}

export interface ContextResult {
  ok: boolean;
  context: Context;
  compositeETag: string;
  cacheBreakdown: {
    precompiledAgent: { cached: boolean; etag: string; source: "d1" | "parser" | "provided" };
    customerData: { cached: boolean; etag: string; source: "d1" | "salesforce" };
    conversationHistory: { cached: boolean; etag: string; source: "d1" | "auth_service" | "salesforce" };
    globalData: { cached: boolean; etag: string; source: "d1" | "b2" | "salesforce" };
    toolCallUrls: { cached: boolean; etag: string; source: "d1" | "auth_service" | "retrieve64" };
  };
  timestamp: string;
}


export interface CorrespondingDataOptions extends ExportData360Options {
  userId: string;
  channelId?: string;
  sessionId?: string;
  bypassCache?: boolean;
  bypassGlobalCache?: boolean;
  bypassIndividualCache?: boolean;
  bypassUserCache?: boolean;
  bypassConversationCache?: boolean;
  conversationLimit?: number;
}

export interface CorrespondingDataResult {
  ok: boolean;
  userId: string;
  channelId: string;
  sessionId?: string;
  compositeETag: string;
  cacheBreakdown: {
    globalData360: { cached: boolean; etag: string; source: "d1" | "b2" | "salesforce" };
    individualData360: { cached: boolean; etag: string; source: "d1" | "salesforce" };
    conversationHistory: { cached: boolean; etag: string; source: "d1" | "auth_service" | "salesforce"; sessionCount: number; totalMessages: number };
  };
  globalData360: any;
  individualData360: UserData360Result | null;
  conversationHistory: UserConversationHistory | null;
  timestamp: string;
}

export interface ExportData360Options {
  channelId?: string;
  agentName?: string;
  teamId?: string;
  orgId?: string;
  accessToken?: string;
  instanceUrl?: string;
  apiVersion?: string;
  maxRecords?: number;
  includeCrmRecords?: boolean;
  includeDataCloudRecords?: boolean;
  includeMetadata?: boolean;
  includeTools?: boolean;
  includeAgentScript?: boolean;
  includeAgentXml?: boolean;
  includeUnstructuredFiles?: boolean;
  maxUnstructuredFiles?: number;
  cacheToB2?: boolean;
  cacheTtlSeconds?: number;
  cacheKey?: string;
  format?: "zip" | "json";
}

export interface BatchSubrequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  richInput?: any;
  binaryPartName?: string;
  binaryPartNameAlias?: string;
}

export interface BatchSubresponse {
  statusCode: number;
  result: any;
}

export interface CompositeBatchResponse {
  hasErrors: boolean;
  results: BatchSubresponse[];
}

export interface AgentArtifacts {
  agentName: string;
  channelName?: string;
  script?: string;
  bundleMetaXml?: string;
  botXml?: string;
  format?: string;
  promptTemplates?: Record<string, string>;
  agentGraph?: Record<string, unknown>;
  localActions?: Record<string, unknown>;
  rawFiles?: Record<string, string>;
  callableTools?: Array<{
    url?: string;
    id?: string;
    source?: string;
    target?: string;
    route?: string;
    schema?: any;
  }>;
}

export interface Data360DiscoveredElements {
  dmoNames: string[];
  referencedSegmentIds: string[];
  referencedSegmentNames: string[];
  actions: string[];
  promptTemplateNames: string[];
}

export interface ExtractedUnstructuredFile {
  id: string;
  sourceObject: "ContentVersion" | "Document" | "StaticResource" | "Attachment";
  title: string;
  filename: string;
  category: "pdf" | "image" | "document" | "text" | "data" | "archive" | "other";
  fileType: string;
  fileExtension?: string;
  contentType?: string;
  contentSize: number;
  description?: string;
  data: Uint8Array;
}

export interface Data360Metadata {
  dataLakeObjects?: any[];
  dataModelObjects?: any[];
  dataGraphs?: any[];
  dataCloudObjects?: DataCloudObject[];
  channel?: Record<string, any>;
  dataSpaces: any[];
  dataStreams?: any[];
  dataLakeMappings?: any[];
  marketSegments: any[];
  calculatedInsights: any[];
  identityResolutionRules: any[];
  dmoDescribes: Record<string, any>;
  dmoCatalog: any[];
  unstructuredSearchIndexes?: any[];
}

export interface Data360Records {
  dataGraphs?: Record<string, any[]>;
  crm: {
    individuals: any[];
    contactPointEmails: any[];
    contactPointPhones: any[];
    orders: any[];
    orderItems: any[];
    leads: any[];
    accounts: any[];
    messagingSessions: any[];
  };
  dataCloud: Record<string, any[]>;
}

export const DATA_CLOUD_FAMILIES = ["dlo", "dmo", "unified-dmo", "link-dmo", "udmo", "data-graph", "calculated-insight"] as const;
export type DataCloudFamily = typeof DATA_CLOUD_FAMILIES[number];
export interface DataCloudObject {
  name: string;
  dataSpace: string;
  family: DataCloudFamily;
  storageKey: string;
  metadata: Record<string, any>;
}

export interface ExportManifest {
  storage?: {
    layoutVersion: 2;
    objectFamilies: Record<string, DataCloudFamily>;
    objectDataSpaces?: Record<string, string>;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  version: string;
  exportTimestamp: string;
  target: {
    channelId?: string;
    channelDeveloperName?: string;
    agentName?: string;
  };
  salesforce: {
    instanceUrl: string;
    apiVersion: string;
    orgId?: string;
  };
  summary: {
    agentFormat?: string;
    dmoCount: number;
    dmos: string[];
    marketSegmentCount: number;
    dataSpaceCount: number;
    dataStreamCount?: number;
    crmRecordCounts: Record<string, number>;
    dataCloudRecordCounts: Record<string, number>;
    dataGraphRecordCounts?: Record<string, number>;
    unstructuredFileCounts?: {
      total: number;
      pdf: number;
      image: number;
      document: number;
      text: number;
      other: number;
      totalBytes: number;
    };
    totalBatchRequests: number;
    totalSubrequests: number;
    fileCount: number;
  };
  b2Cache?: B2CacheMetadata;
  warnings?: string[];
}

export interface B2Config {
  keyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName?: string;
  endpoint?: string;
  /** B2 key root isolating environments sharing one bucket (default "data360"). */
  pathPrefix?: string;
}

export interface B2CacheMetadata {
  stored: boolean;
  bucketName: string;
  bucketId: string;
  snapshotId: string;
  basePath: string;
  cachedAt: string;
  expiresAt?: string;
  bandwidthAlliance: boolean;
  totalBytes: number;
  fileCount: number;
  zipUrl?: string;
}

export interface B2SnapshotSummary {
  snapshotId: string;
  timestamp: string;
  orgId: string;
  targetId: string;
  manifest: ExportManifest;
  zipFileName?: string;
  totalBytes: number;
  fileCount: number;
}

export interface ExtractedData360Package {
  manifest: ExportManifest;
  agent: AgentArtifacts;
  metadata: Data360Metadata;
  records: Data360Records;
  unstructuredFiles?: ExtractedUnstructuredFile[];
  zipBytes?: Uint8Array;
  b2Cache?: B2CacheMetadata;
}

export interface UserData360Result {
  userId: string;
  individual?: any;
  contact?: any;
  lead?: any;
  contactPointEmails: any[];
  contactPointPhones: any[];
  unifiedIndividual: any[];
  extractedAt: string;
}

export interface MessagingSessionData360Result {
  sessionId: string;
  session: any | null;
  transcripts: any[];
  customer360?: UserData360Result | null;
  extractedAt: string;
}

export interface CorrespondingDataResult {
  ok: boolean;
  userId: string;
  channelId: string;
  sessionId?: string;
  compositeETag: string;
  cacheBreakdown: {
    globalData360: { cached: boolean; etag: string; source: "d1" | "b2" | "salesforce" };
    individualData360: { cached: boolean; etag: string; source: "d1" | "salesforce" };
    conversationHistory: { cached: boolean; etag: string; source: "d1" | "auth_service" | "salesforce"; sessionCount: number; totalMessages: number };
  };
  globalData360: any;
  individualData360: UserData360Result | null;
  conversationHistory: UserConversationHistory | null;
  timestamp: string;
}

