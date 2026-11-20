import { argument, args, blindRest, blindRows, connection, report, waitUntil } from "./common";
import { DATA_CLOUD_FAMILIES } from "../../src/types";

async function main() {
  const { target, conn, apiVersion, client } = await connection();
  const phase = argument("--phase") ?? "all";
  const seconds = Number(argument("--timeout-seconds") ?? "900");
  if (!Number.isFinite(seconds) || seconds <= 0) throw Error("--timeout-seconds must be positive");
  report({ stage: "discover", target });
  if (!["all", "identity"].includes(phase)) throw Error("Supported seed phases: all, identity. Streaming Insight is deferred.");
  // Identity seeding reads per-object `fields` schemas, so it opts out of slim catalog metadata.
  const catalog = await client.discover((family, count) => report({ catalog: family, count }), { includeObjectSchemas: true });
  const prefix = argument("--asset-prefix") ?? "Data360 verification";
  async function mutate(path: string, body: unknown) {
    const response = await fetch(`${conn.instanceUrl}/services/data/${apiVersion}/ssot/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${conn.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (response.ok && (result.success === false || (Array.isArray(result) && result.some(e => e.errorCode)))) {
      throw Error(`Salesforce seed ${path.split("?")[0]} returned an unsuccessful operation`);
    }
    if (!response.ok) {
      const errors = Array.isArray(result) ? result : [result];
      const codes = errors.map(e => `${e.errorCode ?? e.error ?? "REFUSED"}: ${e.message ?? "Native seed operation refused"}`).join("; ");
      throw Error(`Salesforce seed ${path.split("?")[0]} HTTP ${response.status}: ${codes.replaceAll(conn.accessToken, "[redacted]").slice(0, 1200)}`);
    }
    return result;
  }
  const populated = async (family: string) => {
    for (const object of catalog.objects.filter(o => o.family === family && o.metadata.isEnabled !== false && o.metadata.creationType !== "Adg")) {
      try { if ((await client.read(object, 1)).length) return object; } catch (error) { report({ family, object: object.name, readError: String(error) }); }
    }
    return undefined;
  };
  if (args.includes("--check")) {
    const rows: Record<string, boolean> = {};
    for (const family of DATA_CLOUD_FAMILIES) rows[family] = Boolean(await populated(family));
    report({ stage: "readiness", populated: rows });
    if (Object.values(rows).some(value => !value)) throw Error("Target is not yet populated for every Data 360 family");
    return;
  }
  if (phase === "all" || phase === "identity") {
    const individual = catalog.objects.find(o => o.family === "dmo" && o.metadata.isEnabled === true && String(o.metadata.label).toLowerCase() === "individual");
    if (!individual || !(await client.read(individual, 1)).length) throw Error("A populated Individual DMO mapped from real source data is required for Identity Resolution");
    const primary = individual.metadata.fields?.find((f: any) => f.isPrimaryKey === true);
    if (!primary) throw Error("The live Individual DMO has no primary key");
    const email = catalog.objects.find(o => o.family === "dmo" && String(o.metadata.label).toLowerCase() === "contact point email");
    if (!email) throw Error("The target exposes no Contact Point Email DMO for required Identity Resolution mappings");
    const emailKey = email.metadata.fields.find((f: any) => f.isPrimaryKey === true);
    const emailAddress = email.metadata.fields.find((f: any) => /^email address$/i.test(f.label));
    const party = email.metadata.fields.find((f: any) => /PartyId__c$/.test(f.name));
    const firstName = individual.metadata.fields.find((f: any) => /^first name$/i.test(f.label));
    const lastName = individual.metadata.fields.find((f: any) => /^last name$/i.test(f.label));
    if (!emailKey || !emailAddress || !party || !firstName || !lastName) throw Error("The live party-area schema lacks required email/name/party fields");
    const modelMaps = await client.request(`data-model-object-mappings?${new URLSearchParams({ dataspace: individual.dataSpace, dmoDeveloperName: individual.name })}`);
    const maps = modelMaps.objectSourceTargetMaps ?? [];
    let emailMapped = false;
    for (const mapping of maps) {
      const source = catalog.objects.find(o => o.family === "dlo" && o.name === mapping.sourceEntityDeveloperName);
      const idMap = mapping.fieldMappings?.find((f: any) => f.targetFieldDeveloperName === primary.name);
      const sourceEmail = source?.metadata.fields?.find((f: any) => /^email( address)?$/i.test(f.label));
      if (!source || !idMap || !sourceEmail) continue;
      if (!(await client.read(source, 1)).length) continue;
      const sourceQualifier = source.metadata.fields.find((f: any) => f.name === `KQ_${idMap.sourceFieldDeveloperName}`);
      const partyQualifier = email.metadata.fields.find((f: any) => /^KQ_PartyId__c$/.test(f.name));
      const emailMappingsPath = `data-model-object-mappings?${new URLSearchParams({ dataspace: email.dataSpace, dmoDeveloperName: email.name, dloDeveloperName: source.name })}`;
      let existing: any;
      try { existing = await client.request(emailMappingsPath); }
      catch (error) {
        if (!/HTTP 404/.test(String(error))) throw error;
        existing = { objectSourceTargetMaps: [] };
      }
      if (!(existing.objectSourceTargetMaps ?? []).length) {
        await mutate(`data-model-object-mappings?dataspace=${encodeURIComponent(email.dataSpace)}`, {
          sourceEntityDeveloperName: source.name, targetEntityDeveloperName: email.name,
          fieldMapping: [
            { sourceFieldDeveloperName: idMap.sourceFieldDeveloperName, targetFieldDeveloperName: emailKey.name },
            { sourceFieldDeveloperName: sourceEmail.name, targetFieldDeveloperName: emailAddress.name },
            { sourceFieldDeveloperName: idMap.sourceFieldDeveloperName, targetFieldDeveloperName: party.name },
            ...(sourceQualifier && partyQualifier ? [{ sourceFieldDeveloperName: sourceQualifier.name, targetFieldDeveloperName: partyQualifier.name }] : []),
          ],
        });
        const checked = await blindRest(target, apiVersion, emailMappingsPath);
        if (!(checked.objectSourceTargetMaps ?? []).some((m: any) => m.targetEntityDeveloperName === email.name)) throw Error("Blind Contact Point Email mapping check failed");
        report({ seeded: "required-contact-point-email-mapping", verifiedBy: "independent Salesforce CLI" });
      }
      await waitUntil(() => client.read(email, 1), rows => rows.length > 0, seconds);
      await blindRows(target, apiVersion, email.name, email.dataSpace);
      emailMapped = true;
      break;
    }
    if (!emailMapped) throw Error("No real Individual source has the required email field; provision its contact-point mapping before unification");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${individual.dataSpace}/${individual.name}`)));
    const rulesetId = `v${Array.from(digest, b => b.toString(16).padStart(2, "0")).join("").slice(0, 3)}`;
    const label = `${prefix} ${rulesetId}`;
    let ruleset = catalog.identityResolutions.find(r => r.label === label) ?? catalog.identityResolutions.find(r => String(r.configurationType).toLowerCase() === "individual");
    if (!ruleset) {
      ruleset = await mutate(`identity-resolutions?dataspace=${encodeURIComponent(individual.dataSpace)}`, {
        label, description: "Verification ruleset over existing real source profiles; real email and name matching.",
        configurationType: "individual", dataSpaceName: individual.dataSpace, rulesetId, doesRunAutomatically: false,
        matchRules: [{ label: "Real email and name", criteria: [
          { entityName: email.name, fieldName: emailAddress.name, matchMethodType: "exactnormalized", shouldMatchOnBlank: false },
          { entityName: individual.name, fieldName: firstName.name, matchMethodType: "exact", shouldMatchOnBlank: false },
          { entityName: individual.name, fieldName: lastName.name, matchMethodType: "exact", shouldMatchOnBlank: false },
        ] }],
        reconciliationRules: [individual, email].map(o => ({ entityName: o.name, ruleType: "mostfrequent", shouldIgnoreEmptyValue: true })),
      });
      const checked = await blindRest(target, apiVersion, `identity-resolutions/${encodeURIComponent(ruleset.id)}`);
      if (checked.label !== label) throw Error("Blind Identity Resolution creation check failed");
      report({ seeded: "identity-resolution", verifiedBy: "independent Salesforce CLI" });
    }
    const id = ruleset.id;
    if (!id) throw Error("Identity Resolution returned no identifier");
    const published = await waitUntil(
      () => blindRest(target, apiVersion, `identity-resolutions/${encodeURIComponent(id)}`),
      state => String(state.rulesetStatus).toUpperCase() === "PUBLISHED",
      seconds,
    );
    if (!/success/i.test(String(published.lastJobStatus)) || Number(published.totalUnifiedProfiles) < 1) {
      await mutate(`identity-resolutions/${encodeURIComponent(id)}/actions/run-now`, {});
    }
    const settled = await waitUntil(async () => {
      const state = await blindRest(target, apiVersion, `identity-resolutions/${encodeURIComponent(id)}`);
      report({ identityStatus: state.lastJobStatus, unifiedProfiles: state.totalUnifiedProfiles ?? 0 });
      if (/fail|error/i.test(String(state.lastJobStatus))) throw Error("Identity Resolution failed in the target org");
      return state;
    }, state => /success/i.test(String(state.lastJobStatus)) && Number(state.totalUnifiedProfiles) > 0, seconds);
    for (const rule of (settled.reconciliationRules ?? []).filter((rule: any) => rule.entityName === individual.name)) {
      for (const name of [rule.unifiedDmoName, rule.linkDmoName]) {
        if (!name) continue;
        await waitUntil(async () => client.query(`SELECT * FROM "${name}" LIMIT 1`, individual.dataSpace), rows => rows.length > 0, seconds);
        await blindRows(target, apiVersion, name, individual.dataSpace);
        report({ seeded: name, rowsVerified: true, verifiedBy: "independent Salesforce CLI" });
      }
    }
    if (phase === "identity") return;
  }
  catalog.objects = (await client.discover()).objects;
  const readiness: Record<string, boolean> = {};
  for (const family of DATA_CLOUD_FAMILIES) readiness[family] = Boolean(await populated(family));
  report({ stage: "readiness", populated: readiness, deferred: ["streaming-insight"] });
  if (Object.values(readiness).some(value => !value)) throw Error("Target lacks populated objects for the seven supported Data 360 families");
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Seed failed" })); process.exitCode = 1; });
