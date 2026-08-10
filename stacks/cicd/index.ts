import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Labels } from "../../modules/labels";
import { Project } from "../../modules/project";

const config = new pulumi.Config("cicd");

const organisation = config.require("organisation");
const folder = config.get("folder");
const billing = config.require("billing");
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

// --- Main execution ---

if (!organisation || organisation.trim() === "") {
    throw new Error("cicd:organisation must be provided and non-empty");
}
if (!billing || billing.trim() === "") {
    throw new Error("cicd:billing must be provided and non-empty");
}
if (!defaultLocation || defaultLocation.trim() === "") {
    throw new Error("cicd:defaultLocation must be provided and non-empty");
}

const resolvedFolder = resolveFolder(organisation, folder);

const stackLabels = pulumi.output(
    Object.keys(userLabels).length > 0
        ? new Labels("cicd-labels", { labels: userLabels }).labels.apply(sanitised => ({
            ...sanitised,
            stack: "cicd",
        } as { [key: string]: string }))
        : pulumi.output({ stack: "cicd" } as { [key: string]: string }),
).apply(l => l);

const cicdProject = createCicdProject(resolvedFolder, billing, apisAdditional, stackLabels);

// Create artifact registries
const registryMap: { [name: string]: pulumi.Output<string> } = {};
for (const [name, def] of Object.entries(artifactRegistries)) {
    const validFormats = ["docker", "npm", "python"];
    if (!validFormats.includes(def.format)) {
        throw new Error(`Artifact registry '${name}': format must be one of ${validFormats.join(", ")}. Got: '${def.format}'`);
    }
    if (def.mode !== "standard") {
        throw new Error(`Artifact registry '${name}': only 'standard' mode is supported. Got: '${def.mode}'`);
    }

    const registryLocation = def.multiRegion || defaultLocation;
    const cleanupPolicyValue = (def.cleanupPolicies || "delete").toLowerCase();
    const cleanupAction = cleanupPolicyValue === "keep" ? "KEEP" : "DELETE";
    const dockerImmutable = def.format === "docker" && def.immutable === "enabled";

    const repo = new gcp.artifactregistry.Repository(`registry-${name}`, {
        repositoryId: name,
        project: cicdProject.projectId,
        location: registryLocation,
        format: def.format.toUpperCase(),
        mode: "STANDARD_REPOSITORY",
        dockerConfig: def.format === "docker" ? {
            immutableTags: dockerImmutable,
        } : undefined,
        cleanupPolicyDryRun: false,
        cleanupPolicies: [{
            id: `${name}-default-cleanup`,
            action: cleanupAction,
            condition: {
                olderThan: "2592000s",
            },
        }],
        labels: stackLabels,
    });
    registryMap[name] = repo.id;
}

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

// Stack outputs
export const projectCicdName = cicdProject.projectDisplayName;
export const projectCicdId = cicdProject.projectId;
export const projectCicdNumber = cicdProject.projectNumber;
export const artifactRegistriesOutput = registriesOutput;
export const labels = cicdProject.labels;
