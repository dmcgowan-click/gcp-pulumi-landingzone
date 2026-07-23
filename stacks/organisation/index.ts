import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as inputs from "@pulumi/gcp/types/input";
import { Folder } from "../../modules/folder";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { OrgPolicy } from "../../modules/org-policy";
import { Project } from "../../modules/project";
import { Storage } from "../../modules/storage";

const config = new pulumi.Config("organisation");
const gcpConfig = new pulumi.Config("gcp");

const organisation = config.require("organisation");
const billing = config.require("billing");
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
const orgPolicyAdditional = config.getObject<{
    [policyName: string]: {
        spec?: inputs.orgpolicy.PolicySpec;
        dryRunSpec?: inputs.orgpolicy.PolicyDryRunSpec;
    };
}>("orgPolicyAdditional") || {};
const userLabels = config.getObject<{ [key: string]: string }>("labels") || {};
const region = gcpConfig.require("region");

/**
 * Creates org policies including the managed default policies and any additional policies.
 *
 * @param orgId The organisation numeric ID
 * @param disableIAMExternalOrg Whether to create the default iam.managed.allowedPolicyMembers policy (restricts IAM members to the org)
 * @param disableServiceAccountKeyCreation Whether to create the default iam.managed.disableServiceAccountKeyCreation policy
 * @param additional Map of additional org policies to create
 * @param opts Resource options applied to each policy (quota project provider and dependencies)
 * @returns List of policy names applied
 */
function createOrgPolicies(
    orgId: string,
    disableIAMExternalOrg: boolean,
    disableServiceAccountKeyCreation: boolean,
    additional: { [policyName: string]: { spec?: inputs.orgpolicy.PolicySpec; dryRunSpec?: inputs.orgpolicy.PolicyDryRunSpec } },
    opts: pulumi.ComponentResourceOptions,
): string[] {
    const appliedPolicies: string[] = [];
    const allowedMembersKey = "iam.managed.allowedPolicyMembers";
    const disableSaKeyKey = "iam.managed.disableServiceAccountKeyCreation";

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

    for (const [policyName, entry] of Object.entries(additional)) {
        if (policyName === allowedMembersKey || policyName === disableSaKeyKey) {
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
 *
 * @param orgId The organisation numeric ID
 * @param envs List of environment entries (name and optional folder IAM bindings)
 * @returns Map of folder name to Folder component
 */
function createFolders(
    orgId: string,
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

    const folders: { [name: string]: Folder } = {};

    folders["common"] = new Folder("common", {
        organisation: orgId,
        name: "common",
    });

    for (const env of envs) {
        folders[env.name] = new Folder(`env-${env.name}`, {
            organisation: orgId,
            name: env.name,
            bindings: env.bindings,
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
 * @returns The Project component
 */
function createSeedProject(
    commonFolderId: pulumi.Output<string>,
    billingAccount: string,
    mergedLabels: pulumi.Output<{ [key: string]: string }>,
    additionalApis: string[],
): Project {
    const hardcodedApis = [
        "cloudresourcemanager.googleapis.com",
        "cloudbilling.googleapis.com",
        "iam.googleapis.com",
        "orgpolicy.googleapis.com",
    ];
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

    return new Iam("org-admin-bindings", {
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

const folders = createFolders(organisation, environments);

const labelsModule = new Labels("org-labels", { labels: userLabels });
const mergedLabels = labelsModule.labels.apply((sanitised): { [key: string]: string } => ({
    ...sanitised,
    stack: "organisation",
}));

const seedProject = createSeedProject(folders["common"].folderId, billing, mergedLabels, apisAdditional);

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
    orgPolicyAdditional,
    {
        providers: [seedQuotaProvider],
        dependsOn: [seedProject],
    },
);

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

export const organisationOutput = organisation;
export const foldersOutput = pulumi.output(
    Object.fromEntries(
        Object.entries(folders).map(([name, folder]) => [
            name,
            {
                id: folder.folderId,
                bindings: folder.bindings,
            },
        ])
    )
);
export const bindingsOrgAdminOutput = orgAdminIam.bindings;
export const serviceAccountEmailOutput = serviceAccountEmail ?? pulumi.output(null);
export const projectSeedName = seedProject.projectDisplayName;
export const projectSeedId = seedProject.projectId;
export const projectSeedNumericIdentifier = seedProject.projectNumber;
export const storageBucketName = stateBucket.bucketName;
export const orgPoliciesOutput = orgPolicies.length > 0 ? orgPolicies : null;
