import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { Project } from "../../modules/project";

const config = new pulumi.Config("cicd");

const organisation = config.require("organisation");
const folder = config.get("folder");
const billing = config.require("billing");
const seedProjectID = config.require("seedProjectID");
const defaultLocation = config.require("defaultLocation");
const apisAdditional = config.getObject<string[]>("apisAdditional") || [];
const artifactRegistries = config.getObject<{
    [name: string]: {
        format: string;
        mode: string;
        multiRegion?: string;
        immutable?: string;
        cleanupPolicies?: string;
        labels?: { [key: string]: string };
    };
}>("artifactRegistries") || {};
const userLabels = config.getObject<{ [key: string]: string }>("labels") || {};

// --- Validation ---

if (!organisation || organisation.trim() === "") {
    throw new Error("cicd:organisation must be provided and non-empty");
}
if (!billing || billing.trim() === "") {
    throw new Error("cicd:billing must be provided and non-empty");
}
if (!seedProjectID || seedProjectID.trim() === "") {
    throw new Error("cicd:seedProjectID must be provided and non-empty");
}
if (!defaultLocation || defaultLocation.trim() === "") {
    throw new Error("cicd:defaultLocation must be provided and non-empty");
}

for (const [name, def] of Object.entries(artifactRegistries)) {
    const validFormats = ["docker", "npm", "python"];
    if (!validFormats.includes(def.format)) {
        throw new Error(`Artifact registry '${name}': format must be one of ${validFormats.join(", ")}. Got: '${def.format}'`);
    }
    if (def.mode !== "standard") {
        throw new Error(`Artifact registry '${name}': only 'standard' mode is supported. Got: '${def.mode}'`);
    }
    if (def.format !== "docker" && def.immutable !== undefined) {
        throw new Error(`Artifact registry '${name}': 'immutable' is only applicable to docker format registries.`);
    }
}

// --- Functions ---

/**
 * Resolves the common folder ID. Returns the provided ID or looks up a folder named "common" under the organisation.
 *
 * @param orgId The organisation numeric ID
 * @param folderId Optional folder numeric ID (returned as-is if provided)
 * @returns The resolved folder numeric ID
 */
function resolveFolder(orgId: string, folderId: string | undefined): pulumi.Output<string> {
    if (folderId) {
        return pulumi.output(folderId);
    }

    const folders = gcp.organizations.getFoldersOutput({
        parentId: `organizations/${orgId}`,
    });

    return folders.apply(result => {
        const matches = result.folders.filter(f => f.displayName === "common");
        if (matches.length === 0) {
            throw new Error(`No folder with display name "common" found under organizations/${orgId}`);
        }
        if (matches.length > 1) {
            throw new Error(`Multiple folders with display name "common" found under organizations/${orgId}`);
        }
        return matches[0].name.replace("folders/", "");
    });
}

/**
 * Creates the CICD project via the project module.
 *
 * @param folderId The common folder numeric ID
 * @param billingAccount The billing account ID
 * @param additionalApis Additional APIs to enable beyond the hardcoded set
 * @param labels Merged labels to apply to the project
 * @returns The created Project component
 */
function createCicdProject(
    folderId: pulumi.Input<string>,
    billingAccount: string,
    additionalApis: string[],
    labels: pulumi.Input<{ [key: string]: string }>,
): Project {
    const hardcodedApis = [
        "cloudresourcemanager.googleapis.com",
        "cloudbilling.googleapis.com",
        "iam.googleapis.com",
        "artifactregistry.googleapis.com",
    ];

    const apis = [...hardcodedApis, ...additionalApis];

    return new Project("cicd", {
        folder: folderId,
        billing: billingAccount,
        name: "cicd",
        apis,
        labels,
    });
}

/**
 * Creates artifact registries, a shared RW service account, and IAM bindings on the CICD project.
 *
 * @param registries The artifact registry definitions from config
 * @param projectId The CICD project ID (Output from project module)
 * @param seedProject The seed project ID where the SA is created
 * @param location The default location for registries without multiRegion
 * @param projectLabels The project-level merged labels
 * @returns Map of registry name to full GCP resource name
 */
function createArtifactRegistries(
    registries: { [name: string]: { format: string; mode: string; multiRegion?: string; immutable?: string; cleanupPolicies?: string; labels?: { [key: string]: string } } },
    projectId: pulumi.Output<string>,
    seedProject: string,
    location: string,
    projectLabels: pulumi.Output<{ [key: string]: string }>,
): { [name: string]: pulumi.Output<string> } {
    const registryMap: { [name: string]: pulumi.Output<string> } = {};

    for (const [name, def] of Object.entries(registries)) {
        const registryLocation = def.multiRegion || location;
        const cleanupPolicyValue = (def.cleanupPolicies || "delete").toLowerCase();
        const cleanupAction = cleanupPolicyValue === "keep" ? "KEEP" : "DELETE";
        const dockerImmutable = def.format === "docker" && def.immutable === "enabled";

        // Compute labels: registry-level labels (if any) merged with project-level labels
        const repoLabels: pulumi.Output<{ [key: string]: string }> = def.labels && Object.keys(def.labels).length > 0
            ? new Labels(`registry-labels-${name}`, { labels: def.labels }).labels.apply(sanitised =>
                projectLabels.apply(pl => ({ ...pl, ...sanitised }))
            )
            : projectLabels;

        const cleanupCondition: { olderThan: string; tagState?: string } = {
            olderThan: "2592000s",
        };
        if (def.format === "docker") {
            cleanupCondition.tagState = "UNTAGGED";
        }

        const repo = new gcp.artifactregistry.Repository(`registry-${name}`, {
            repositoryId: name,
            project: projectId,
            location: registryLocation,
            description: `Registry ${name} for ${def.format} artifacts`,
            format: def.format.toUpperCase(),
            mode: "STANDARD_REPOSITORY",
            dockerConfig: def.format === "docker" ? {
                immutableTags: dockerImmutable,
            } : undefined,
            cleanupPolicyDryRun: false,
            cleanupPolicies: [{
                id: `${name}-default-cleanup`,
                action: cleanupAction,
                condition: cleanupCondition,
            }],
            labels: repoLabels,
        });

        registryMap[name] = pulumi.interpolate`projects/${projectId}/locations/${registryLocation}/repositories/${name}`;
    }

    // Create shared RW service account and IAM bindings
    if (Object.keys(registries).length > 0) {
        const sa = new gcp.serviceaccount.Account("cicd-artifact-rw", {
            accountId: "cicd-artifact-rw",
            displayName: "cicd-artifact-rw",
            description: "Service Account for cicd-artifact-rw - Artifact Registries Read / Write. Project wide bindings on this project",
            project: seedProject,
        });

        new Iam("cicd-artifact-iam", {
            project: projectId,
            bindings: {
                "roles/artifactregistry.writer": [pulumi.interpolate`serviceAccount:${sa.email}`],
                "roles/artifactregistry.viewer": [pulumi.interpolate`serviceAccount:${sa.email}`],
            },
        });
    }

    return registryMap;
}

// --- Main execution ---

const resolvedFolder = resolveFolder(organisation, folder);

const stackLabels: pulumi.Output<{ [key: string]: string }> = Object.keys(userLabels).length > 0
    ? new Labels("cicd-labels", { labels: userLabels }).labels.apply(sanitised => ({
        ...sanitised,
        stack: "cicd",
    } as { [key: string]: string }))
    : pulumi.output({ stack: "cicd" } as { [key: string]: string });

const cicdProject = createCicdProject(resolvedFolder, billing, apisAdditional, stackLabels);

const registryMap = createArtifactRegistries(
    artifactRegistries,
    cicdProject.projectId,
    seedProjectID,
    defaultLocation,
    stackLabels,
);

const registriesOutput = Object.keys(registryMap).length > 0
    ? pulumi.all(Object.values(registryMap)).apply(values => {
        const result: { [name: string]: string } = {};
        const keys = Object.keys(registryMap);
        for (let i = 0; i < keys.length; i++) {
            result[keys[i]] = values[i];
        }
        return result;
    })
    : pulumi.output({} as { [name: string]: string });

// --- Stack outputs ---

export const projectCicdName = cicdProject.projectDisplayName;
export const projectCicdId = cicdProject.projectId;
export const projectCicdNumber = cicdProject.projectNumber;
export const artifactRegistriesExport = registriesOutput;
export const labels = stackLabels;
