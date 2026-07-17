import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Folder } from "../../modules/folder";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { Project } from "../../modules/project";
import { Storage } from "../../modules/storage";

const config = new pulumi.Config("organisation");
const gcpConfig = new pulumi.Config("gcp");

const organisation = config.require("organisation");
const billing = config.require("billing");
const environments = config.requireObject<string[]>("environments");
const bindingsOrgAdmin = config.requireObject<{
    group: string;
    sa?: {
        enabled: boolean;
        name?: string;
    };
    bindings: string[];
}>("bindingsOrgAdmin");
const apisAdditional = config.getObject<string[]>("apisAdditional") || [];
const labels = config.getObject<{ [key: string]: string }>("labels") || {};
const region = gcpConfig.require("region");

/**
 * Creates the common folder and one folder per environment under the organisation.
 *
 * @param orgId The organisation numeric ID
 * @param envNames List of environment names to create folders for
 * @returns Map of folder name to Folder component
 */
function createFolders(
    orgId: string,
    envNames: string[],
): { [name: string]: Folder } {
    if (!envNames || envNames.length === 0) {
        throw new Error("At least one environment entry must be declared. 'environments' is empty or missing.");
    }

    const folders: { [name: string]: Folder } = {};

    folders["common"] = new Folder("common", {
        organisation: orgId,
        name: "common",
    });

    for (const env of envNames) {
        folders[env] = new Folder(`env-${env}`, {
            organisation: orgId,
            name: env,
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

const labelsModule = new Labels("org-labels", { labels });
const mergedLabels = labelsModule.labels.apply((sanitised): { [key: string]: string } => ({
    ...sanitised,
    stack: "organisation",
}));

const seedProject = createSeedProject(folders["common"].folderId, billing, mergedLabels, apisAdditional);

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
