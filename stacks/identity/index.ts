import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as googleworkspace from "@pulumi/googleworkspace";
import * as random from "@pulumi/random";

const config = new pulumi.Config("identity");

const domain = config.require("domain");
const customerId = config.require("customerId");
const impersonateAdmin = config.require("impersonateAdmin");
const serviceAccountEmail = config.require("serviceAccountEmail");
const principals = config.requireObject<{
    groups?: {
        name: string;
        description?: string;
        users: { emailPrimaryId: string }[];
    }[];
    users?: {
        firstName: string;
        lastName: string;
        emailPrimaryId: string;
        emailSecondary?: string;
        phoneNumber?: string;
        organisationalUnit?: string;
    }[];
}>("principals");

// --- Validation ---

if (!domain) {
    throw new Error("'identity:domain' must be provided and non-empty.");
}
if (!customerId || !customerId.startsWith("C")) {
    throw new Error("'identity:customerId' must be provided and start with 'C'.");
}
if (!impersonateAdmin || !impersonateAdmin.includes("@")) {
    throw new Error("'identity:impersonateAdmin' must be provided and contain '@'.");
}
if (!serviceAccountEmail || !serviceAccountEmail.includes("@")) {
    throw new Error("'identity:serviceAccountEmail' must be provided and contain '@'.");
}

const hasUsers = principals.users && principals.users.length > 0;
const hasGroups = principals.groups && principals.groups.length > 0;
if (!hasUsers && !hasGroups) {
    throw new Error("At least one of 'principals.users' or 'principals.groups' must be non-empty.");
}

if (principals.users) {
    for (const user of principals.users) {
        if (!user.firstName || !user.lastName || !user.emailPrimaryId) {
            throw new Error(`Each user entry must have 'firstName', 'lastName', and 'emailPrimaryId' (all non-empty). Got: ${JSON.stringify(user)}`);
        }
        if (user.emailPrimaryId.includes("@")) {
            throw new Error(`'emailPrimaryId' must not contain '@' (it is the ID-only portion). Got: '${user.emailPrimaryId}'`);
        }
    }
}

if (principals.groups) {
    for (const group of principals.groups) {
        if (!group.name) {
            throw new Error(`Each group entry must have 'name'. Got: ${JSON.stringify(group)}`);
        }
        if (!group.users || group.users.length === 0) {
            throw new Error(`Each group entry must have at least one user in 'users'. Group '${group.name}' has none.`);
        }
    }
}

// --- Credential Flow ---

const oauthScopes = [
    "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/admin.directory.group",
    "https://www.googleapis.com/auth/admin.directory.group.member",
];

const accessToken = gcp.serviceaccount.getAccountAccessTokenOutput({
    targetServiceAccount: serviceAccountEmail,
    scopes: ["https://www.googleapis.com/auth/cloud-platform", ...oauthScopes],
});

const wsProvider = new googleworkspace.Provider("google-workspace", {
    customerId: customerId,
    impersonatedUserEmail: impersonateAdmin,
    accessToken: accessToken.accessToken,
    serviceAccount: serviceAccountEmail,
    oauthScopes: oauthScopes,
});

// --- User Creation ---

/**
 * Creates all Google Workspace users from the principals config.
 *
 * @param cfg The principals users config
 * @param provider The Google Workspace provider instance
 * @returns Map of emailPrimaryId to the created User resource
 */
function createUsers(
    cfg: typeof principals.users,
    provider: googleworkspace.Provider,
): { [emailPrimaryId: string]: googleworkspace.User } {
    const users: { [emailPrimaryId: string]: googleworkspace.User } = {};

    if (!cfg) {
        return users;
    }

    for (const userCfg of cfg) {
        const password = new random.RandomPassword(`password-${userCfg.emailPrimaryId}`, {
            length: 16,
            special: true,
            keepers: {
                emailPrimaryId: userCfg.emailPrimaryId,
            },
        });

        const user = new googleworkspace.User(`user-${userCfg.emailPrimaryId}`, {
            primaryEmail: `${userCfg.emailPrimaryId}@${domain}`,
            name: {
                givenName: userCfg.firstName,
                familyName: userCfg.lastName,
            },
            password: pulumi.secret(password.result),
            changePasswordAtNextLogin: true,
            recoveryEmail: userCfg.emailSecondary,
            recoveryPhone: userCfg.phoneNumber,
            orgUnitPath: userCfg.organisationalUnit || "/",
        }, { provider });

        users[userCfg.emailPrimaryId] = user;
    }

    return users;
}

// --- Group Creation ---

/**
 * Creates all Google Workspace groups and assigns memberships.
 *
 * @param cfg The principals groups config
 * @param provider The Google Workspace provider instance
 * @param users Map of created user resources (for dependsOn ordering)
 * @returns Map of group name to the created Group resource
 */
function createGroups(
    cfg: typeof principals.groups,
    provider: googleworkspace.Provider,
    users: { [emailPrimaryId: string]: googleworkspace.User },
): { [name: string]: googleworkspace.Group } {
    const groups: { [name: string]: googleworkspace.Group } = {};

    if (!cfg) {
        return groups;
    }

    for (const groupCfg of cfg) {
        const group = new googleworkspace.Group(`group-${groupCfg.name}`, {
            email: `${groupCfg.name}@${domain}`,
            description: groupCfg.description,
        }, { provider });

        for (const memberCfg of groupCfg.users) {
            const memberEmail = `${memberCfg.emailPrimaryId}@${domain}`;
            const dependsOn: pulumi.Resource[] = [];

            if (users[memberCfg.emailPrimaryId]) {
                dependsOn.push(users[memberCfg.emailPrimaryId]);
            }

            new googleworkspace.GroupMember(
                `group-${groupCfg.name}-member-${memberCfg.emailPrimaryId}`,
                {
                    groupId: group.id,
                    email: memberEmail,
                },
                { provider, dependsOn },
            );
        }

        groups[groupCfg.name] = group;
    }

    return groups;
}

// --- Main Execution ---

const createdUsers = createUsers(principals.users, wsProvider);
const createdGroups = createGroups(principals.groups, wsProvider, createdUsers);

// --- Stack Outputs ---

export const usersOutput = pulumi.output(
    Object.fromEntries(
        Object.entries(createdUsers).map(([id, user]) => [
            id,
            user.primaryEmail,
        ])
    )
);

export const groupsOutput = pulumi.output(
    Object.fromEntries(
        Object.entries(createdGroups).map(([name, group]) => [
            name,
            group.email,
        ])
    )
);
