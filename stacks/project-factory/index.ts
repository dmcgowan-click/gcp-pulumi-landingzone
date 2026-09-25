import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as yaml from "js-yaml";
import { Labels } from "../../modules/labels";
import { ServiceProject, ServiceProjectPowerUser, ServiceProjectROUser, ServiceProjectZones } from "../../modules/service-project";

// --- Config Resolution ---

const stackName = pulumi.getStack();
const lastHyphen = stackName.lastIndexOf("-");
if (lastHyphen <= 0 || lastHyphen === stackName.length - 1) {
    throw new Error(
        `Stack name '${stackName}' must match '<initiative>-<environment>' format ` +
        `(must contain at least one hyphen with non-empty parts on both sides).`
    );
}
const initiative = stackName.substring(0, lastHyphen);
const environment = stackName.substring(lastHyphen + 1);

if (environment === "org" || environment === "common") {
    throw new Error(`'<environment>' must not be 'org' or 'common'. Got: '${environment}'.`);
}

/**
 * Reads and parses a YAML file from the stack directory.
 *
 * @param filename The YAML filename to read (relative to stack directory)
 * @returns The parsed YAML content as a plain object
 */
function readYamlFile(filename: string): Record<string, unknown> {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required config file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, "utf8");
    return (yaml.load(content) as Record<string, unknown>) || {};
}

const orgCommon = readYamlFile("Pulumi-common.yaml");
const initiativeCommon = readYamlFile(`Pulumi.${initiative}-common.yaml`);

// Stack config (env-level) — read via Pulumi native config
const config = new pulumi.Config("project-factory");

// --- Validate and Load Parameters ---

// Org-common parameters
const organisation = orgCommon.organisation as string;
const billing = orgCommon.billing as string;
const seedProjectID = orgCommon.seedProjectID as string;
const defaultLocation = orgCommon.defaultLocation as string;
const cicdProjectID = orgCommon.cicdProjectID as string | undefined;

// Initiative-common parameters
const name = initiativeCommon.name as string;
const apis = (initiativeCommon.apis as string[] | undefined) || undefined;

// Overridable parameters: env-level takes priority over initiative-common
type BindingsPowerUserConfigType = {
    sa?: { enabled: boolean; name?: string };
    bindings: string[];
    bindingProjectIAM?: string[];
};
type BindingsROUserConfigType = {
    bindings: string[];
};
type DefaultProjectZoneType = {
    rootZoneName: string;
};
type AdditionalProjectZonesType = {
    [dnsName: string]: {
        visibility?: string;
        zoneName?: string;
        description?: string;
    };
};

const envBindingsPowerUserConfig = config.getObject<BindingsPowerUserConfigType>("bindingsPowerUserConfig");
const initBindingsPowerUserConfig = initiativeCommon.bindingsPowerUserConfig as BindingsPowerUserConfigType | undefined;

let bindingsPowerUserConfig: BindingsPowerUserConfigType | undefined;
if (envBindingsPowerUserConfig && initBindingsPowerUserConfig) {
    pulumi.log.warn("'bindingsPowerUserConfig' defined in both env-level and initiative-common. Using env-level.");
    bindingsPowerUserConfig = envBindingsPowerUserConfig;
} else {
    bindingsPowerUserConfig = envBindingsPowerUserConfig || initBindingsPowerUserConfig;
}

const envBindingsROUserConfig = config.getObject<BindingsROUserConfigType>("bindingsROUserConfig");
const initBindingsROUserConfig = initiativeCommon.bindingsROUserConfig as BindingsROUserConfigType | undefined;

let bindingsROUserConfig: BindingsROUserConfigType | undefined;
if (envBindingsROUserConfig && initBindingsROUserConfig) {
    pulumi.log.warn("'bindingsROUserConfig' defined in both env-level and initiative-common. Using env-level.");
    bindingsROUserConfig = envBindingsROUserConfig;
} else {
    bindingsROUserConfig = envBindingsROUserConfig || initBindingsROUserConfig;
}

const envStateBucket = config.getBoolean("stateBucket");
const initStateBucket = initiativeCommon.stateBucket as boolean | undefined;

let stateBucket: boolean;
if (envStateBucket !== undefined && initStateBucket !== undefined) {
    pulumi.log.warn("'stateBucket' defined in both env-level and initiative-common. Using env-level.");
    stateBucket = envStateBucket;
} else {
    stateBucket = envStateBucket ?? initStateBucket ?? true;
}

const envDefaultProjectZone = config.getObject<DefaultProjectZoneType>("defaultProjectZone");
const initDefaultProjectZone = initiativeCommon.defaultProjectZone as DefaultProjectZoneType | undefined;

let defaultProjectZone: DefaultProjectZoneType | undefined;
if (envDefaultProjectZone && initDefaultProjectZone) {
    pulumi.log.warn("'defaultProjectZone' defined in both env-level and initiative-common. Using env-level.");
    defaultProjectZone = envDefaultProjectZone;
} else {
    defaultProjectZone = envDefaultProjectZone || initDefaultProjectZone;
}

// additionalProjectZones is env-level only
const additionalProjectZones = config.getObject<AdditionalProjectZonesType>("additionalProjectZones");

// Env-level parameters (always from stack config)
const bindingsPowerUserPrincipal = config.get("bindingsPowerUserPrincipal");
const bindingsROUserPrincipal = config.get("bindingsROUserPrincipal");

// Cross-level validation
if (bindingsPowerUserConfig && !bindingsPowerUserPrincipal) {
    throw new Error(
        "'project-factory:bindingsPowerUserPrincipal' is required in the stack config " +
        "when 'bindingsPowerUserConfig' is provided (in either env-level or initiative-common)."
    );
}
if (bindingsROUserConfig && !bindingsROUserPrincipal) {
    throw new Error(
        "'project-factory:bindingsROUserPrincipal' is required in the stack config " +
        "when 'bindingsROUserConfig' is provided (in either env-level or initiative-common)."
    );
}

// --- Labels ---

// Collect labels from each tier
const orgLabels = (orgCommon.labels as { [key: string]: string } | undefined) || {};
const initiativeLabels = (initiativeCommon.labels as { [key: string]: string } | undefined) || {};
const envLabels = config.getObject<{ [key: string]: string }>("labels") || {};

// Merge user labels: org-common → initiative-common → env (later wins)
const mergedUserLabels: { [key: string]: string } = {
    ...orgLabels,
    ...initiativeLabels,
    ...envLabels,
};

// Sanitise user labels if any are provided, then merge with stack hardcoded labels
const stackHardcodedLabels = { stack: "project-factory", initiative: initiative, environment: environment };

let finalLabels: pulumi.Input<{ [key: string]: string }>;
if (Object.keys(mergedUserLabels).length > 0) {
    const sanitised = new Labels("labels", { labels: mergedUserLabels });
    finalLabels = sanitised.labels.apply(l => ({
        ...l,
        ...stackHardcodedLabels,
    }));
} else {
    finalLabels = stackHardcodedLabels;
}

// --- Create Service Project ---

// Build power-user bindings object for the service-project module
let bindingsPowerUser: ServiceProjectPowerUser | undefined;
if (bindingsPowerUserConfig && bindingsPowerUserPrincipal) {
    bindingsPowerUser = {
        group: bindingsPowerUserPrincipal,
        sa: bindingsPowerUserConfig.sa,
        bindings: bindingsPowerUserConfig.bindings,
        bindingProjectIAM: bindingsPowerUserConfig.bindingProjectIAM,
    };
}

// Build read-only-user bindings object for the service-project module
let bindingsROUser: ServiceProjectROUser | undefined;
if (bindingsROUserConfig && bindingsROUserPrincipal) {
    bindingsROUser = {
        group: bindingsROUserPrincipal,
        bindings: bindingsROUserConfig.bindings,
    };
}

// Build project zones object for the service-project module
let projectZones: ServiceProjectZones | undefined;
if (defaultProjectZone || additionalProjectZones) {
    projectZones = {
        publicDefault: defaultProjectZone,
        additional: additionalProjectZones,
    };
}

const serviceProject = new ServiceProject(`${initiative}-${environment}`, {
    organisation: organisation,
    billing: billing,
    environment: environment,
    seedProjectID: seedProjectID,
    name: name,
    defaultLocation: defaultLocation,
    apis: apis,
    cicdProjectID: cicdProjectID,
    bindingsPowerUser: bindingsPowerUser,
    bindingsROUser: bindingsROUser,
    stateBucket: stateBucket,
    projectZones: projectZones,
    labels: finalLabels,
});

// --- Stack Outputs ---

export const projectDisplayName = serviceProject.projectDisplayName;
export const projectId = serviceProject.projectId;
export const projectNumber = serviceProject.projectNumber;
export const projectEnvironment = serviceProject.environment;
export const powerUserServiceAccountEmail = serviceProject.powerUserServiceAccountEmail;
export const stateBucketName = serviceProject.stateBucketName;
export const labels = serviceProject.labels;
