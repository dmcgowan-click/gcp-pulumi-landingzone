import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as inputs from "@pulumi/gcp/types/input";
import { Folder } from "../../modules/folder";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { OrgPolicy } from "../../modules/org-policy";
import { Project } from "../../modules/project";
import { Storage } from "../../modules/storage";
import { DnsZone } from "../../modules/dns-zone";

const config = new pulumi.Config("organisation");
const gcpConfig = new pulumi.Config("gcp");

const organisation = config.require("organisation");
const billing = config.require("billing");
const domain = config.require("domain");
const environments = config.requireObject<Array<{
    name: string;
    bindings?: { [roleId: string]: string[] };
}>>("environments");
const bindingsOrgAdmin = config.requireObject<{
    group: string;
    sa?: {
        enabled: boolean;
        name?: string;
    };
    bindings: string[];
}>("bindingsOrgAdmin");
const apisAdditional = config.getObject<string[]>("apisAdditional") || [];
const orgPolicyDisableIAMExternalOrg = config.getBoolean("orgPolicyDisableIAMExternalOrg") ?? true;
const orgPolicyDisableServiceAccountKeyCreation = config.getBoolean("orgPolicyDisableServiceAccountKeyCreation") ?? true;
const orgPolicyDisableServiceAccountKeyUpload = config.getBoolean("orgPolicyDisableServiceAccountKeyUpload") ?? true;
const automaticIamGrantsForDefaultServiceAccounts = config.getBoolean("automaticIamGrantsForDefaultServiceAccounts") ?? true;
const orgPolicySkipDefaultNetworkCreation = config.getBoolean("orgPolicySkipDefaultNetworkCreation") ?? true;
const orgPolicyAdditional = config.getObject<{
    [policyName: string]: {
        spec?: inputs.orgpolicy.PolicySpec;
        dryRunSpec?: inputs.orgpolicy.PolicyDryRunSpec;
    };
}>("orgPolicyAdditional") || {};
const userLabels = config.getObject<{ [key: string]: string }>("labels") || {};
const rootZone = config.getObject<{
    dnsName: string;
    zoneName?: string;
    description?: string;
}>("rootZone");
const region = gcpConfig.require("region");

/**
 * Creates org policies including the managed default policies and any additional policies.
 *
 * @param orgId The organisation numeric ID
 * @param disableIAMExternalOrg Whether to create the default iam.managed.allowedPolicyMembers policy (restricts IAM members to the org)
 * @param disableServiceAccountKeyCreation Whether to create the default iam.managed.disableServiceAccountKeyCreation policy
 * @param disableServiceAccountKeyUpload Whether to create the default iam.disableServiceAccountKeyUpload policy
 * @param disableAutomaticIamGrants Whether to create the default iam.automaticIamGrantsForDefaultServiceAccounts policy
 * @param skipDefaultNetworkCreation Whether to create the default compute.skipDefaultNetworkCreation policy
 * @param additional Map of additional org policies to create
 * @param opts Resource options applied to each policy (quota project provider and dependencies)
 * @returns List of policy names applied
 */
function createOrgPolicies(
    orgId: string,
    disableIAMExternalOrg: boolean,
    disableServiceAccountKeyCreation: boolean,
    disableServiceAccountKeyUpload: boolean,
    disableAutomaticIamGrants: boolean,
    skipDefaultNetworkCreation: boolean,
    additional: { [policyName: string]: { spec?: inputs.orgpolicy.PolicySpec; dryRunSpec?: inputs.orgpolicy.PolicyDryRunSpec } },
    opts: pulumi.ComponentResourceOptions,
): string[] {
    const appliedPolicies: string[] = [];
    const allowedMembersKey = "iam.managed.allowedPolicyMembers";
    const disableSaKeyKey = "iam.managed.disableServiceAccountKeyCreation";
    const disableSaKeyUploadKey = "iam.disableServiceAccountKeyUpload";
    const automaticIamGrantsKey = "iam.automaticIamGrantsForDefaultServiceAccounts";
    const skipDefaultNetworkKey = "compute.skipDefaultNetworkCreation";

    // Validate all additional entries up front.
    for (const [policyName, entry] of Object.entries(additional)) {
        if (!policyName || policyName.trim() === "") {
            throw new Error("orgPolicyAdditional key (policy name) must be non-empty.");
        }
        if (!entry.spec && !entry.dryRunSpec) {
            throw new Error(`orgPolicyAdditional entry '${policyName}' must have at least one of 'spec' or 'dryRunSpec'.`);
        }
    }

    // iam.managed.allowedPolicyMembers (external-org restriction) — list constraint.
    if (disableIAMExternalOrg) {
        // iam.managed.allowedPolicyMembers is a managed constraint. Managed
        // constraints are configured via `enforce` + a JSON `parameters` blob,
        // not classic list-constraint `values.allowedValues`.
        const allowedPrincipalSets = [`//cloudresourcemanager.googleapis.com/organizations/${orgId}`];

        const additionalEntry = additional[allowedMembersKey];
        if (additionalEntry?.spec) {
            const additionalRules = (additionalEntry.spec as inputs.orgpolicy.PolicySpec).rules;
            if (additionalRules && Array.isArray(additionalRules)) {
                for (const rule of additionalRules) {
                    const ruleObj = rule as inputs.orgpolicy.PolicySpecRule;
                    const ruleValues = ruleObj.values as inputs.orgpolicy.PolicySpecRuleValues | undefined;
                    if (ruleValues?.allowedValues) {
                        allowedPrincipalSets.push(...(ruleValues.allowedValues as string[]));
                    }
                }
            }
        }

        new OrgPolicy(`org-policy-${allowedMembersKey}`, {
            organisation: orgId,
            policyName: allowedMembersKey,
            spec: {
                rules: [{
                    enforce: "TRUE",
                    parameters: JSON.stringify({ allowedPrincipalSets }),
                }],
            },
            dryRunSpec: additionalEntry?.dryRunSpec,
        }, opts);
        appliedPolicies.push(allowedMembersKey);
    } else if (additional[allowedMembersKey]) {
        const entry = additional[allowedMembersKey];
        new OrgPolicy(`org-policy-${allowedMembersKey}`, {
            organisation: orgId,
            policyName: allowedMembersKey,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(allowedMembersKey);
    }

    // iam.managed.disableServiceAccountKeyCreation — boolean constraint (no list
    // to merge, so an additional entry overrides the default enforce spec).
    if (disableServiceAccountKeyCreation) {
        const additionalEntry = additional[disableSaKeyKey];
        new OrgPolicy(`org-policy-${disableSaKeyKey}`, {
            organisation: orgId,
            policyName: disableSaKeyKey,
            spec: additionalEntry?.spec ?? { rules: [{ enforce: "TRUE" }] },
            dryRunSpec: additionalEntry?.dryRunSpec,
        }, opts);
        appliedPolicies.push(disableSaKeyKey);
    } else if (additional[disableSaKeyKey]) {
        const entry = additional[disableSaKeyKey];
        new OrgPolicy(`org-policy-${disableSaKeyKey}`, {
            organisation: orgId,
            policyName: disableSaKeyKey,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(disableSaKeyKey);
    }

    // iam.disableServiceAccountKeyUpload — boolean constraint.
    if (disableServiceAccountKeyUpload) {
        const additionalEntry = additional[disableSaKeyUploadKey];
        new OrgPolicy(`org-policy-${disableSaKeyUploadKey}`, {
            organisation: orgId,
            policyName: disableSaKeyUploadKey,
            spec: additionalEntry?.spec ?? { rules: [{ enforce: "TRUE" }] },
            dryRunSpec: additionalEntry?.dryRunSpec,
        }, opts);
        appliedPolicies.push(disableSaKeyUploadKey);
    } else if (additional[disableSaKeyUploadKey]) {
        const entry = additional[disableSaKeyUploadKey];
        new OrgPolicy(`org-policy-${disableSaKeyUploadKey}`, {
            organisation: orgId,
            policyName: disableSaKeyUploadKey,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(disableSaKeyUploadKey);
    }

    // iam.automaticIamGrantsForDefaultServiceAccounts — boolean constraint.
    if (disableAutomaticIamGrants) {
        const additionalEntry = additional[automaticIamGrantsKey];
        new OrgPolicy(`org-policy-${automaticIamGrantsKey}`, {
            organisation: orgId,
            policyName: automaticIamGrantsKey,
            spec: additionalEntry?.spec ?? { rules: [{ enforce: "TRUE" }] },
            dryRunSpec: additionalEntry?.dryRunSpec,
        }, opts);
        appliedPolicies.push(automaticIamGrantsKey);
    } else if (additional[automaticIamGrantsKey]) {
        const entry = additional[automaticIamGrantsKey];
        new OrgPolicy(`org-policy-${automaticIamGrantsKey}`, {
            organisation: orgId,
            policyName: automaticIamGrantsKey,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(automaticIamGrantsKey);
    }

    // compute.skipDefaultNetworkCreation — boolean constraint.
    if (skipDefaultNetworkCreation) {
        const additionalEntry = additional[skipDefaultNetworkKey];
        new OrgPolicy(`org-policy-${skipDefaultNetworkKey}`, {
            organisation: orgId,
            policyName: skipDefaultNetworkKey,
            spec: additionalEntry?.spec ?? { rules: [{ enforce: "TRUE" }] },
            dryRunSpec: additionalEntry?.dryRunSpec,
        }, opts);
        appliedPolicies.push(skipDefaultNetworkKey);
    } else if (additional[skipDefaultNetworkKey]) {
        const entry = additional[skipDefaultNetworkKey];
        new OrgPolicy(`org-policy-${skipDefaultNetworkKey}`, {
            organisation: orgId,
            policyName: skipDefaultNetworkKey,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(skipDefaultNetworkKey);
    }

    for (const [policyName, entry] of Object.entries(additional)) {
        if (policyName === allowedMembersKey || policyName === disableSaKeyKey
            || policyName === disableSaKeyUploadKey || policyName === automaticIamGrantsKey
            || policyName === skipDefaultNetworkKey) {
            continue;
        }

        new OrgPolicy(`org-policy-${policyName}`, {
            organisation: orgId,
            policyName: policyName,
            spec: entry.spec,
            dryRunSpec: entry.dryRunSpec,
        }, opts);
        appliedPolicies.push(policyName);
    }

    return appliedPolicies;
}

/**
 * Creates the common folder and one folder per environment under the organisation.
 * Applies domain-wide folderViewer binding to all folders. Environment folders also
 * receive user-supplied bindings (merged with the domain binding).
 *
 * @param orgId The organisation numeric ID
 * @param domainName The Google Cloud domain for domain-wide IAM bindings
 * @param envs List of environment entries (name and optional folder IAM bindings)
 * @returns Map of folder name to Folder component
 */
function createFolders(
    orgId: string,
    domainName: string,
    envs: Array<{ name: string; bindings?: { [roleId: string]: string[] } }>,
): { [name: string]: Folder } {
    if (!envs || envs.length === 0) {
        throw new Error("At least one environment entry must be declared. 'environments' is empty or missing.");
    }

    const seen = new Set<string>();
    for (const env of envs) {
        if (!env.name || env.name.trim() === "") {
            throw new Error("Each environment entry must have a non-empty 'name'.");
        }
        if (seen.has(env.name)) {
            throw new Error(`Duplicate environment name '${env.name}'. Environment names must be unique.`);
        }
        seen.add(env.name);
    }

    const domainBinding: { [roleId: string]: pulumi.Input<string>[] } = {
        "roles/resourcemanager.folderViewer": [`domain:${domainName}`],
    };

    const folders: { [name: string]: Folder } = {};

    folders["common"] = new Folder("common", {
        organisation: orgId,
        name: "common",
        bindings: domainBinding,
    });

    for (const env of envs) {
        let mergedBindings: { [roleId: string]: pulumi.Input<string>[] } = { ...domainBinding };
        if (env.bindings) {
            for (const [role, principals] of Object.entries(env.bindings)) {
                if (mergedBindings[role]) {
                    mergedBindings[role] = [...(mergedBindings[role] as string[]), ...principals];
                } else {
                    mergedBindings[role] = principals;
                }
            }
        }

        folders[env.name] = new Folder(`env-${env.name}`, {
            organisation: orgId,
            name: env.name,
            bindings: mergedBindings,
        });
    }

    return folders;
}

/**
 * Creates the seed project under the common folder.
 *
 * @param commonFolderId The common folder numeric ID
 * @param billingAccount The billing account ID
 * @param mergedLabels Labels merged from sanitised user labels and stack defaults
 * @param additionalApis Additional APIs to enable beyond the hardcoded set
 * @param includeDnsApi Whether to enable dns.googleapis.com (required when a root DNS zone is created)
 * @returns The Project component
 */
function createSeedProject(
    commonFolderId: pulumi.Output<string>,
    billingAccount: string,
    mergedLabels: pulumi.Output<{ [key: string]: string }>,
    additionalApis: string[],
    includeDnsApi: boolean,
): Project {
    const hardcodedApis = [
        "cloudresourcemanager.googleapis.com",
        "cloudbilling.googleapis.com",
        "iam.googleapis.com",
        "orgpolicy.googleapis.com",
    ];
    if (includeDnsApi) {
        hardcodedApis.push("dns.googleapis.com");
    }
    const apis = [...new Set([...hardcodedApis, ...additionalApis])];

    return new Project("seed", {
        folder: commonFolderId,
        billing: billingAccount,
        name: "seed",
        apis: apis,
        labels: mergedLabels,
    });
}

/**
 * Creates a domain-wide IAM binding at the organisation level.
 *
 * @param orgId The organisation numeric ID
 * @param domainName The Google Cloud domain
 * @returns The Iam component
 */
function createOrgDomainBinding(orgId: string, domainName: string): Iam {
    return new Iam("iam-org-viewer", {
        organisation: orgId,
        bindings: {
            "roles/resourcemanager.organizationViewer": [`domain:${domainName}`],
        },
    });
}

/**
 * Creates IAM bindings for the org admin group (and optional service account) at the organisation level.
 *
 * @param orgId The organisation numeric ID
 * @param group The org admin group principal (must start with group:)
 * @param roles List of IAM role IDs to assign
 * @param saEmail Optional service account email to include as a principal
 * @returns The Iam component
 */
function createOrgAdminBindings(
    orgId: string,
    group: string,
    roles: string[],
    saEmail?: pulumi.Output<string>,
): Iam {
    if (!group.startsWith("group:")) {
        throw new Error(`'bindingsOrgAdmin.group' must start with 'group:' prefix. Got '${group}'.`);
    }

    const bindings: { [roleId: string]: pulumi.Input<string>[] } = {};
    for (const role of roles) {
        if (saEmail) {
            bindings[role] = [group, pulumi.interpolate`serviceAccount:${saEmail}`];
        } else {
            bindings[role] = [group];
        }
    }

    return new Iam("iam-org-admin", {
        organisation: orgId,
        bindings: bindings,
    });
}

/**
 * Creates a service account under the seed project for org-wide CI/CD bindings.
 *
 * @param seedProjectId The seed project ID
 * @param name The service account name
 * @returns The service account resource
 */
function createServiceAccount(
    seedProjectId: pulumi.Output<string>,
    name: string,
): gcp.serviceaccount.Account {
    return new gcp.serviceaccount.Account(`sa-${name}`, {
        accountId: name,
        displayName: name,
        description: `Service Account for ${name}. Org wide bindings`,
        project: seedProjectId,
    });
}

/**
 * Creates the Pulumi state storage bucket under the seed project.
 *
 * @param seedProjectId The seed project ID (output from the Project module)
 * @param location The GCP region for the bucket
 * @param mergedLabels Labels merged from sanitised user labels and stack defaults
 * @returns The Storage component
 */
function createStateBucket(
    seedProjectId: pulumi.Output<string>,
    location: string,
    mergedLabels: pulumi.Output<{ [key: string]: string }>,
): Storage {
    return new Storage("pulumi-state", {
        name: "pulumi-state-organisation",
        postfix: true,
        project: seedProjectId,
        location: location,
        labels: mergedLabels,
    });
}

/**
 * Creates the root DNS zone under the seed project.
 *
 * @param seedProjectId The seed project ID (output from the Project module)
 * @param zone The rootZone config (dnsName, optional zoneName, optional description)
 * @param mergedLabels Labels merged from sanitised user labels and stack defaults
 * @returns The DnsZone component
 */
function createRootZone(
    seedProjectId: pulumi.Output<string>,
    zone: { dnsName: string; zoneName?: string; description?: string },
    mergedLabels: pulumi.Output<{ [key: string]: string }>,
): DnsZone {
    let zoneName: string;
    if (zone.zoneName) {
        zoneName = zone.zoneName;
    } else {
        zoneName = zone.dnsName.replace(/\.$/, "").replace(/\./g, "-");
        const zoneNameRegex = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
        if (zoneName.length < 1 || zoneName.length > 63 || !zoneNameRegex.test(zoneName)) {
            throw new Error(
                `Derived 'rootZone.zoneName' ('${zoneName}') from dnsName '${zone.dnsName}' is invalid. Provide an explicit 'rootZone.zoneName' (1-63 chars, lowercase letters/digits/hyphens, starting with a letter, not ending with a hyphen).`
            );
        }
    }

    const description = zone.description || `Root zone for ${zone.dnsName}`;

    return new DnsZone("root-zone", {
        project: seedProjectId,
        zoneName: zoneName,
        dnsName: zone.dnsName,
        description: description,
        visibility: "public",
        labels: mergedLabels,
    });
}

const folders = createFolders(organisation, domain, environments);

const labelsModule = new Labels("org-labels", { labels: userLabels });
const mergedLabels = labelsModule.labels.apply((sanitised): { [key: string]: string } => ({
    ...sanitised,
    stack: "organisation",
}));

const seedProject = createSeedProject(folders["common"].folderId, billing, mergedLabels, apisAdditional, rootZone !== undefined);

// Org policy API calls with user ADC require a quota project. Use the seed
// project as the quota/billing project, ensuring it (and its enabled
// orgpolicy.googleapis.com API) is provisioned first.
const seedQuotaProvider = new gcp.Provider("seed-quota", {
    billingProject: seedProject.projectId,
    userProjectOverride: true,
}, { dependsOn: [seedProject] });

const orgPolicies = createOrgPolicies(
    organisation,
    orgPolicyDisableIAMExternalOrg,
    orgPolicyDisableServiceAccountKeyCreation,
    orgPolicyDisableServiceAccountKeyUpload,
    automaticIamGrantsForDefaultServiceAccounts,
    orgPolicySkipDefaultNetworkCreation,
    orgPolicyAdditional,
    {
        providers: [seedQuotaProvider],
        dependsOn: [seedProject],
    },
);

createOrgDomainBinding(organisation, domain);

const saEnabled = bindingsOrgAdmin.sa?.enabled === true;
const saName = bindingsOrgAdmin.sa?.name || "cicd-org";

let serviceAccountEmail: pulumi.Output<string> | undefined;
if (saEnabled) {
    const sa = createServiceAccount(seedProject.projectId, saName);
    serviceAccountEmail = sa.email;
}

const orgAdminIam = createOrgAdminBindings(
    organisation,
    bindingsOrgAdmin.group,
    bindingsOrgAdmin.bindings,
    serviceAccountEmail,
);

const stateBucket = createStateBucket(seedProject.projectId, region, mergedLabels);

const rootZoneComponent = rootZone ? createRootZone(seedProject.projectId, rootZone, mergedLabels) : undefined;

export const organisationOutput = organisation;
export const foldersOutput = pulumi.output(
    Object.fromEntries(
        Object.entries(folders).map(([name, folder]) => [name, folder.folderId])
    )
);
export const foldersBindingsOutput = pulumi.output(
    Object.fromEntries(
        Object.entries(folders).map(([name, folder]) => [name, folder.bindings])
    )
);
export const bindingsOrgAdminOutput = orgAdminIam.bindings;
export const serviceAccountEmailOutput = serviceAccountEmail ?? pulumi.output(null);
export const projectSeedName = seedProject.projectDisplayName;
export const projectSeedId = seedProject.projectId;
export const projectSeedNumber = seedProject.projectNumber;
export const storageBucketName = stateBucket.bucketName;
export const rootZoneNameOutput = rootZoneComponent ? rootZoneComponent.zoneName : pulumi.output(null);
export const rootZoneNameServersOutput = rootZoneComponent ? rootZoneComponent.nameServers : pulumi.output(null);
export const orgPoliciesOutput = orgPolicies.length > 0 ? orgPolicies : null;
