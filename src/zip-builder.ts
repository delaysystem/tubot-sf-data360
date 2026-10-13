import { zipSync, strToU8 } from "fflate";
import type {
  ExportData360Options,
  ExtractedData360Package,
  ExtractedUnstructuredFile,
} from "./types";

export class ZipBuilder {
  /**
   * Compresses the extracted Data 360 package into a structured ZIP file buffer.
   * By default, agent scripts (.agent) and agent XML files (.bundle-meta.xml, .bot)
   * are excluded from the zip payload.
   */
  static buildZip(pkg: ExtractedData360Package, options?: ExportData360Options): Uint8Array {
    const files: Record<string, Uint8Array> = {};

    function addJson(path: string, obj: unknown) {
      if (obj === undefined) return;
      const jsonStr = JSON.stringify(obj, null, 2);
      files[path] = strToU8(jsonStr);
    }

    function addText(path: string, text: string | undefined) {
      if (!text) return;
      files[path] = strToU8(text);
    }

    // 1. Manifest
    addJson("manifest.json", pkg.manifest);

    // 2. Agent Definition / XML Artifacts (only if explicitly opted-in; default: false)
    if (pkg.agent) {
      if (options?.includeAgentScript && pkg.agent.script) {
        addText("agent/agent-script.agent", pkg.agent.script);
      }
      if (options?.includeAgentXml && pkg.agent.bundleMetaXml) {
        addText("agent/bundle-meta.xml", pkg.agent.bundleMetaXml);
      }
      if (options?.includeAgentXml && pkg.agent.botXml) {
        addText("agent/bot.xml", pkg.agent.botXml);
      }
      if (options?.includeAgentXml && pkg.agent.promptTemplates) {
        for (const [tplName, tplXml] of Object.entries(pkg.agent.promptTemplates)) {
          addText(`agent/prompt-templates/${tplName}.genAiPromptTemplate`, tplXml);
        }
      }
      if (pkg.agent.callableTools && pkg.agent.callableTools.length > 0) {
        addJson("metadata/callable-tools.json", pkg.agent.callableTools);
      }
      if (pkg.agent.localActions && Object.keys(pkg.agent.localActions).length > 0) {
        addJson("metadata/local-actions.json", pkg.agent.localActions);
      }
      if (options?.includeAgentScript && pkg.agent.agentGraph) {
        addJson("agent/agent-graph.json", pkg.agent.agentGraph);
      }
    }

    // 3. Metadata
    if (pkg.metadata) {
      if (pkg.metadata.channel) {
        addJson("metadata/channel.json", pkg.metadata.channel);
      }
      addJson("metadata/data-spaces.json", pkg.metadata.dataSpaces);
      addJson("metadata/segments.json", pkg.metadata.marketSegments);
      addJson("metadata/calculated-insights.json", pkg.metadata.calculatedInsights);
      addJson("metadata/identity-resolution.json", pkg.metadata.identityResolutionRules);

      if (pkg.metadata.dataStreams && pkg.metadata.dataStreams.length > 0) {
        addJson("metadata/data-streams.json", pkg.metadata.dataStreams);
      }
      if (pkg.metadata.dataLakeMappings && pkg.metadata.dataLakeMappings.length > 0) {
        addJson("metadata/data-lake-mappings.json", pkg.metadata.dataLakeMappings);
      }
      if (pkg.metadata.unstructuredSearchIndexes && pkg.metadata.unstructuredSearchIndexes.length > 0) {
        addJson("metadata/search-indexes.json", pkg.metadata.unstructuredSearchIndexes);
      }

      if (pkg.metadata.dmoDescribes) {
        for (const [dmoName, describeObj] of Object.entries(pkg.metadata.dmoDescribes)) {
          addJson(`metadata/dmos/${dmoName}.json`, describeObj);
        }
      }
    }

    // 4. Data Records
    if (pkg.records) {
      // 4a. Core CRM Customer 360 Records
      if (pkg.records.crm) {
        addJson("data/crm/Individual.json", pkg.records.crm.individuals);
        addJson("data/crm/ContactPointEmail.json", pkg.records.crm.contactPointEmails);
        addJson("data/crm/ContactPointPhone.json", pkg.records.crm.contactPointPhones);
        addJson("data/crm/Order.json", pkg.records.crm.orders);
        addJson("data/crm/OrderItem.json", pkg.records.crm.orderItems);
        addJson("data/crm/Lead.json", pkg.records.crm.leads);
        addJson("data/crm/Account.json", pkg.records.crm.accounts);
        addJson("data/crm/MessagingSession.json", pkg.records.crm.messagingSessions);
      }

      // 4b. Data Cloud DMO SQL Query Records
      if (pkg.records.dataCloud) {
        for (const [dmoName, records] of Object.entries(pkg.records.dataCloud)) {
          addJson(`data/data-cloud/${dmoName}.json`, records);
        }
      }
    }

    // 5. Unstructured Files & Manifest
    if (pkg.unstructuredFiles) {
      const fileManifest = pkg.unstructuredFiles.map((file: ExtractedUnstructuredFile) => {
        let categoryDir: string;
        switch (file.category) {
          case "pdf":
            categoryDir = "pdf";
            break;
          case "image":
            categoryDir = "images";
            break;
          case "document":
            categoryDir = "documents";
            break;
          case "text":
            categoryDir = "text";
            break;
          case "other":
          default:
            categoryDir = "other";
            break;
        }

        const pathInZip = `data/files/${categoryDir}/${file.filename}`;
        if (file.data) {
          files[pathInZip] = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
        }

        return {
          id: file.id,
          sourceObject: file.sourceObject,
          title: file.title,
          filename: file.filename,
          category: file.category,
          fileType: file.fileType,
          fileExtension: file.fileExtension,
          contentType: file.contentType,
          contentSize: file.contentSize,
          description: file.description,
          pathInZip,
        };
      });

      addJson("metadata/files-manifest.json", fileManifest);
    }

    // Compress in-memory to standard ZIP
    return zipSync(files, { level: 6 });
  }
}
