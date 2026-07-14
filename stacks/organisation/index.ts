import * as pulumi from "@pulumi/pulumi";
import { Folder } from "../../modules/folder";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { Project } from "../../modules/project";

const config = new pulumi.Config("organisation");

const organisation = config.require("organisation");
const billing = config.require("billing");
const environments = config.requireObject<string[]>("environments");
const bindingsSuperAdmin = config.requireObject<{
    group: string;
    bindings: string[];
}>("bindingsSuperAdmin");
const labels = config.getObject<{ [key: string]: string }>("labels") || {};

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
 * Creates IAM bindings for the super admin group at the organisation level.
 *
 * @param orgId The organisation numeric ID
 * @param group The super admin group principal (must start with group:)
 * @param roles List of IAM role IDs to assign
 * @returns The Iam component
 */
function createSuperAdminBindings(
    orgId: string,
    group: string,
    roles: string[],
): Iam {
    if (!group.startsWith("group:")) {
        throw new Error(`'bindingsSuperAdmin.group' must start with 'group:' prefix. Got '${group}'.`);
    }

    const bindings: { [roleId: string]: string[] } = {};
    for (const role of roles) {
        bindings[role] = [group];
    }

    return new Iam("super-admin-bindings", {
        organisation: orgId,
        bindings: bindings,
    });
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
): Project {
    return new Project("seed", {
        folder: commonFolderId,
        billing: billingAccount,
        name: "seed",
        apis: [
            "cloudresourcemanager.googleapis.com",
            "cloudbilling.googleapis.com",
        ],
        labels: mergedLabels,
    });
}

const folders = createFolders(organisation, environments);
const superAdminIam = createSuperAdminBindings(organisation, bindingsSuperAdmin.group, bindingsSuperAdmin.bindings);

const labelsModule = new Labels("org-labels", { labels });
const mergedLabels = labelsModule.labels.apply((sanitised): { [key: string]: string } => ({
    ...sanitised,
    stack: "organisation",
}));

const seedProject = createSeedProject(folders["common"].folderId, billing, mergedLabels);

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
export const bindingsSuperAdminOutput = superAdminIam.bindings;
export const projectSeedName = seedProject.projectDisplayName;
export const projectSeedId = seedProject.projectId;
export const projectSeedNumericIdentifier = seedProject.projectNumber;
