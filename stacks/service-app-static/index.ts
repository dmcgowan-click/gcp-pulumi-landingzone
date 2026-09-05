import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as yaml from "js-yaml";
import { Labels } from "../../modules/labels";
import { IpAddress } from "../../modules/ip-address";

// Environment is the Pulumi stack name (Pulumi.<environment>.yaml).
const environment = pulumi.getStack();

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

// --- Common input (Pulumi-common.yaml) ---
const common = readYamlFile("Pulumi-common.yaml");
const namePrefix = common.namePrefix as string;

// --- Stack input (env-level Pulumi config) ---
const config = new pulumi.Config("service-app-static");
const serviceProjectID = config.require("serviceProjectID");
const userLabels = config.getObject<{ [key: string]: string }>("labels") || {};

// --- Validation ---
if (!namePrefix || namePrefix.trim() === "") {
    throw new Error("Pulumi-common.yaml 'namePrefix' must be provided and non-empty");
}
if (!serviceProjectID || serviceProjectID.trim() === "") {
    throw new Error("service-app-static:serviceProjectID must be provided and non-empty");
}

// --- Labels ---
const stackLabels: pulumi.Output<{ [key: string]: string }> = Object.keys(userLabels).length > 0
    ? new Labels("service-app-static-labels", { labels: userLabels }).labels.apply(sanitised => ({
        ...sanitised,
        stack: "service-app-static",
    } as { [key: string]: string }))
    : pulumi.output({ stack: "service-app-static" } as { [key: string]: string });

// --- Reserve a global IP address ---
const globalIp = new IpAddress(`${namePrefix}-ip-global`, {
    name: `${namePrefix}-ipadd-global-${environment}`,
    project: serviceProjectID,
    type: {
        external: {
            type: "Global",
        },
    },
    labels: stackLabels,
});

// --- Stack outputs ---
export const ipAddress = globalIp.address;
export const ipAddressName = globalIp.name;
export const ipAddressSelfLink = globalIp.selfLink;
