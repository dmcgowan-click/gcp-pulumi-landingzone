import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Iam } from "../../modules/iam";
import { Labels } from "../../modules/labels";
import { Project } from "../../modules/project";
import { CloudBuildTrigger } from "../../modules/cloudbuild-trigger";

const config = new pulumi.Config("cicd");

const organisation = config.require("organisation");
const folder = config.get("folder");
const billing = config.require("billing");
const seedProjectID = config.require("seedProjectID");
const defaultLocation = config.require("defaultLocation");
const apisAdditional = config.getObject<string[]>("apisAdditional") || [];
const artifactRegistriesConfig = config.getObject<{
    [name: string]: {
        format: string;
        mode: string;
        multiRegion?: string;
        immutable?: string;
        cleanupPolicies?: string;
        labels?: { [key: string]: string };
    };
}>("artifactRegistries") || {};
const cloudBuildConfig = config.getObject<{
    repositoryLinks: {
        [linkName: string]: {
            connection: string;
            repositories: { remoteUri: string; name?: string }[];
        };
    };
    triggers?: {
        [triggerName: string]: {
            description?: string;
            event: string;
            source: { linkName: string; remoteUri: string };
            branch?: string;
            includedFiles?: string[];
            ignoredFiles?: string[];
            configuration: { inlineCustom: unknown };
            cicdSaAssume: { orgSa?: boolean; serviceProjectIDs?: string[] };
            requireApproval?: boolean;
        };
    };
}>("cloudBuild");
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

for (const [name, def] of Object.entries(artifactRegistriesConfig)) {
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

if (cloudBuildConfig !== undefined) {
    const links = cloudBuildConfig.repositoryLinks;
    if (!links || Object.keys(links).length === 0) {
        throw new Error("cicd:cloudBuild.repositoryLinks must be defined with at least one link");
    }
    for (const [linkName, link] of Object.entries(links)) {
        if (!link.connection || link.connection.trim() === "") {
            throw new Error(`cicd:cloudBuild link '${linkName}': connection must be provided and non-empty`);
        }
        if (!link.repositories || link.repositories.length === 0) {
            throw new Error(`cicd:cloudBuild link '${linkName}': repositories must contain at least one entry`);
        }
        for (const repo of link.repositories) {
            if (!repo.remoteUri || repo.remoteUri.trim() === "") {
                throw new Error(`cicd:cloudBuild link '${linkName}': each repository must have a non-empty remoteUri`);
            }
        }
    }

    const triggersConfig = cloudBuildConfig.triggers;
    if (triggersConfig !== undefined) {
        if (Object.keys(triggersConfig).length === 0) {
            throw new Error("cicd:cloudBuild.triggers, when provided, must define at least one trigger");
        }

        // Set of valid trigger source keys derived from the created repository links.
        const sourceKeys = new Set<string>();
        for (const [linkName, link] of Object.entries(links)) {
            for (const repo of link.repositories) {
                sourceKeys.add(`${linkName}::${repo.remoteUri}`);
            }
        }

        const validEvents = ["push-to-branch", "push-new-tag", "pull-request"];
        for (const [triggerName, def] of Object.entries(triggersConfig)) {
            if (!validEvents.includes(def.event)) {
                throw new Error(`cicd:cloudBuild trigger '${triggerName}': event must be one of ${validEvents.join(", ")}. Got: '${def.event}'`);
            }
            if (!def.configuration || def.configuration.inlineCustom === undefined) {
                throw new Error(`cicd:cloudBuild trigger '${triggerName}': configuration.inlineCustom must be provided`);
            }
            if (!def.source || !sourceKeys.has(`${def.source.linkName}::${def.source.remoteUri}`)) {
                throw new Error(`cicd:cloudBuild trigger '${triggerName}': source.linkName + source.remoteUri must match a repository created under repositoryLinks`);
            }
            const hasOrgSa = def.cicdSaAssume?.orgSa === true;
            const hasServiceProjects = Array.isArray(def.cicdSaAssume?.serviceProjectIDs) && def.cicdSaAssume.serviceProjectIDs.length > 0;
            if (hasOrgSa === hasServiceProjects) {
                throw new Error(`cicd:cloudBuild trigger '${triggerName}': cicdSaAssume must set exactly one of 'orgSa' (true) or 'serviceProjectIDs' (non-empty)`);
            }
        }
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
 * @param cloudBuildEnabled Whether Cloud Build APIs should also be enabled
 * @param labels Merged labels to apply to the project
 * @returns The created Project component
 */
function createCicdProject(
    folderId: pulumi.Input<string>,
    billingAccount: string,
    additionalApis: string[],
    cloudBuildEnabled: boolean,
    labels: pulumi.Input<{ [key: string]: string }>,
): Project {
    const hardcodedApis = [
        "cloudresourcemanager.googleapis.com",
        "cloudbilling.googleapis.com",
        "iam.googleapis.com",
        "artifactregistry.googleapis.com",
    ];

    const cloudBuildApis = cloudBuildEnabled
        ? ["cloudbuild.googleapis.com", "secretmanager.googleapis.com"]
        : [];

    const apis = [...hardcodedApis, ...cloudBuildApis, ...additionalApis];

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

        new gcp.artifactregistry.Repository(`registry-${name}`, {
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

/**
 * Derives a deterministic, GCP-compliant repository slug from a git remote URI.
 *
 * @param remoteUri The git remote URI (e.g. https://github.com/owner/repo.git)
 * @returns A lowercase hyphenated slug based on the repository name
 */
function deriveRepoSlug(remoteUri: string): string {
    let slug = remoteUri.trim().replace(/\.git$/i, "");
    const segments = slug.split("/").filter(s => s.length > 0);
    slug = segments[segments.length - 1] || "repo";
    slug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "repo";
}

/**
 * Creates 2nd gen Cloud Build repositories under each link's pre-existing connection.
 *
 * @param repositoryLinks The repository link definitions from config
 * @param projectId The CICD project ID (Output from project module)
 * @param location The default location where connections and repositories reside
 * @returns The link output map and a source lookup keyed by `<linkName>::<remoteUri>`
 */
function createRepositoryLinks(
    repositoryLinks: { [linkName: string]: { connection: string; repositories: { remoteUri: string; name?: string }[] } },
    projectId: pulumi.Output<string>,
    location: string,
): { linkMap: { [name: string]: pulumi.Output<string> }; sourceLookup: { [key: string]: pulumi.Output<string> } } {
    const linkMap: { [name: string]: pulumi.Output<string> } = {};
    const sourceLookup: { [key: string]: pulumi.Output<string> } = {};

    for (const [linkName, link] of Object.entries(repositoryLinks)) {
        const parentConnection = pulumi.interpolate`projects/${projectId}/locations/${location}/connections/${link.connection}`;

        for (const repoEntry of link.repositories) {
            const repoName = repoEntry.name || `${linkName}-${deriveRepoSlug(repoEntry.remoteUri)}`;

            const repo = new gcp.cloudbuildv2.Repository(`repolink-${repoName}`, {
                name: repoName,
                location,
                project: projectId,
                remoteUri: repoEntry.remoteUri,
                parentConnection,
            });

            // Reference repo.name so the resource name carries an implicit dependency on the created repository.
            const fullName = pulumi.interpolate`projects/${projectId}/locations/${location}/connections/${link.connection}/repositories/${repo.name}`;
            linkMap[repoName] = fullName;
            sourceLookup[`${linkName}::${repoEntry.remoteUri}`] = fullName;
        }
    }

    return { linkMap, sourceLookup };
}

/**
 * Resolves the `saAssume` list for a trigger from its `cicdSaAssume` config.
 *
 * @param triggerName The trigger name (for error messages)
 * @param cicdSaAssume The cicdSaAssume config (exactly one of orgSa / serviceProjectIDs)
 * @param seedProject The seed project ID where the CICD service accounts reside
 * @returns The list of service account emails the trigger SA may impersonate
 */
function resolveCicdSaAssume(
    triggerName: string,
    cicdSaAssume: { orgSa?: boolean; serviceProjectIDs?: string[] },
    seedProject: string,
): pulumi.Input<string>[] {
    if (cicdSaAssume.orgSa === true) {
        const orgSa = gcp.serviceaccount.getAccountOutput({ accountId: "cicd-org", project: seedProject });
        return [orgSa.email];
    }

    const serviceProjectIDs = cicdSaAssume.serviceProjectIDs || [];
    return serviceProjectIDs.map(id => {
        const slug = id.replace(/-[0-9a-f]{4}$/, "");
        const sa = gcp.serviceaccount.getAccountOutput({ accountId: `cicd-${slug}`, project: seedProject });
        return sa.email;
    });
}

/**
 * Creates Cloud Build triggers via the cloudbuild-trigger module.
 *
 * @param triggers The trigger definitions from config
 * @param projectId The CICD project ID (Output from project module)
 * @param location The default location used as the trigger region
 * @param seedProject The seed project ID where the assumed SAs reside
 * @param sourceLookup Source lookup keyed by `<linkName>::<remoteUri>` (from createRepositoryLinks)
 * @returns Map of trigger name to its Cloud Build trigger ID
 */
function createTriggers(
    triggers: { [triggerName: string]: { description?: string; event: string; source: { linkName: string; remoteUri: string }; branch?: string; includedFiles?: string[]; ignoredFiles?: string[]; configuration: { inlineCustom: unknown }; cicdSaAssume: { orgSa?: boolean; serviceProjectIDs?: string[] }; requireApproval?: boolean } },
    projectId: pulumi.Output<string>,
    location: string,
    seedProject: string,
    sourceLookup: { [key: string]: pulumi.Output<string> },
): { [name: string]: pulumi.Output<string> } {
    const triggerMap: { [name: string]: pulumi.Output<string> } = {};

    for (const [triggerName, def] of Object.entries(triggers)) {
        const source = sourceLookup[`${def.source.linkName}::${def.source.remoteUri}`];
        if (!source) {
            throw new Error(`cicd:cloudBuild trigger '${triggerName}': source (linkName '${def.source.linkName}', remoteUri '${def.source.remoteUri}') does not match any repository created under repositoryLinks`);
        }

        const saAssume = resolveCicdSaAssume(triggerName, def.cicdSaAssume, seedProject);

        const trigger = new CloudBuildTrigger(triggerName, {
            name: triggerName,
            project: projectId,
            region: location,
            description: def.description,
            event: def.event as "push-to-branch" | "push-new-tag" | "pull-request",
            source,
            branch: def.branch,
            includedFiles: def.includedFiles,
            ignoredFiles: def.ignoredFiles,
            configuration: {
                inlineCustom: def.configuration.inlineCustom as gcp.types.input.cloudbuild.TriggerBuild,
            },
            saAssume,
            requireApproval: def.requireApproval,
        });

        triggerMap[triggerName] = trigger.triggerId;
    }

    return triggerMap;
}

/**
 * Resolves a map of Output string values into a single Output object.
 *
 * @param map A map of names to Output string values
 * @returns A single Output resolving to a plain name-to-value object
 */
function resolveMap(map: { [name: string]: pulumi.Output<string> }): pulumi.Output<{ [name: string]: string }> {
    const keys = Object.keys(map);
    if (keys.length === 0) {
        return pulumi.output({} as { [name: string]: string });
    }
    return pulumi.all(Object.values(map)).apply(values => {
        const result: { [name: string]: string } = {};
        for (let i = 0; i < keys.length; i++) {
            result[keys[i]] = values[i];
        }
        return result;
    });
}

// --- Main execution ---

const resolvedFolder = resolveFolder(organisation, folder);

const stackLabels: pulumi.Output<{ [key: string]: string }> = Object.keys(userLabels).length > 0
    ? new Labels("cicd-labels", { labels: userLabels }).labels.apply(sanitised => ({
        ...sanitised,
        stack: "cicd",
    } as { [key: string]: string }))
    : pulumi.output({ stack: "cicd" } as { [key: string]: string });

const cicdProject = createCicdProject(
    resolvedFolder,
    billing,
    apisAdditional,
    cloudBuildConfig !== undefined,
    stackLabels,
);

const registryMap = createArtifactRegistries(
    artifactRegistriesConfig,
    cicdProject.projectId,
    seedProjectID,
    defaultLocation,
    stackLabels,
);

const repoLinkResult = cloudBuildConfig !== undefined
    ? createRepositoryLinks(cloudBuildConfig.repositoryLinks, cicdProject.projectId, defaultLocation)
    : { linkMap: {} as { [name: string]: pulumi.Output<string> }, sourceLookup: {} as { [key: string]: pulumi.Output<string> } };

const triggerMap = (cloudBuildConfig !== undefined && cloudBuildConfig.triggers !== undefined)
    ? createTriggers(cloudBuildConfig.triggers, cicdProject.projectId, defaultLocation, seedProjectID, repoLinkResult.sourceLookup)
    : {};

// --- Stack outputs ---

export const projectCicdName = cicdProject.projectDisplayName;
export const projectCicdId = cicdProject.projectId;
export const projectCicdNumber = cicdProject.projectNumber;
export const artifactRegistries = resolveMap(registryMap);
export const repositoryLinks = resolveMap(repoLinkResult.linkMap);
export const triggers = resolveMap(triggerMap);
export const labels = stackLabels;
