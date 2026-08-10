### Identity

<!-- This stack is flaky and prone to error due the way authentication works. A few attempts may be required to build it correctly -->

Create a Pulumi stack under `stacks/identity` to create users and groups

* Use `@pulumi/gcp`, `@pulumi/googleworkspace`, `@pulumi/random`, `@pulumi/pulumi`
* Dependencies (`package.json`):
  * `@pulumi/pulumi`: `^3`
  * `@pulumi/gcp`: `^7`
  * `@pulumi/random`: `^4`
  * `@pulumi/googleworkspace`: `file:sdks/googleworkspace` (local SDK — generated via `pulumi package add terraform-provider hashicorp/googleworkspace`, run from the stack directory)
* Structure
  * `createUsers(config, provider)` — creates all Google Workspace users, returns map of created user resources
  * `createGroups(config, provider, users)` — creates groups and assigns memberships (depends on users)
* Accept an input based on the following YAML definition

```yaml
domain: <domain name for google identity>
customerId: <Google Workspace customer ID (starts with C)>
impersonateAdmin: <admin email for domain-wide delegation>
serviceAccountEmail: <service account email from organisation stack>
principals:
  groups:
    - name: <name>
      description: <description of group (optional)>
      users:
        - emailPrimaryId: <user primary email, ID only, part of Google Identity>
      groups: # group principals to add as members (single-level only — referenced groups must not themselves nest further groups created in this stack)
        - emailPrimaryId: <group email ID, maps to a group name in this list or a pre-existing Google Cloud Identity group>
  users:
    - firstName: <first name>
      lastName: <last name>
      emailPrimaryId: <user primary email, ID only, part of Google Identity>
      emailSecondary: <user secondary email, full email address (optional)>
      phoneNumber: <phone number (optional)>
      organisationalUnit: <organisational unit (optional, defaults to /)>
```

* Authentication
  * Uses a service account with domain-wide delegation (created by the Organisation stack)
  * **Manual prerequisites** (performed once before this stack can run):
    1. In **GCP Console** → IAM & Admin → Service Accounts → select the SA created by the Organisation stack
       * Copy the **Unique ID** (numeric) — this is the OAuth Client ID
    2. In **Google Admin Console** → Security → Access and data control → API Controls → Domain-wide Delegation
       * Click "Add new" → paste the Client ID from step 1
       * Add the following OAuth scopes:
         * `https://www.googleapis.com/auth/cloud-platform` 
         * `https://www.googleapis.com/auth/admin.directory.user`
         * `https://www.googleapis.com/auth/admin.directory.group`
         * `https://www.googleapis.com/auth/admin.directory.group.member`
    3. Identify a **super admin user** in Google Workspace who has logged in at least once and accepted the Terms of Service — this is the `impersonateAdmin`
    4. Obtain the **Customer ID** from Google Admin Console → Account → Account Settings
    5. Grant the calling principal (whoever runs `pulumi up`) the `Service Account Token Creator` role on the domain-delegated SA
  * **Credential flow** (within this stack, no separate stack required):
    1. Define the Admin Directory OAuth scopes as a constant array:
       * `https://www.googleapis.com/auth/admin.directory.user`
       * `https://www.googleapis.com/auth/admin.directory.group`
       * `https://www.googleapis.com/auth/admin.directory.group.member`
    2. Mint a fresh SA access token at runtime using `gcp.serviceaccount.getAccountAccessTokenOutput`:
       * `targetServiceAccount` = `serviceAccountEmail` from config
       * `scopes` = `["https://www.googleapis.com/auth/cloud-platform", ...oauthScopes]` — `cloud-platform` is required for the provider to call `IAMCredentials.SignJwt` for DWD
    3. Pass the minted `accessToken` and `serviceAccount` email to the provider
    > **NOTE — Why not `impersonated_service_account` credentials?**
    > The `impersonated_service_account` credential type (supported by `golang.org/x/oauth2/google`) cannot perform domain-wide delegation with the Google Workspace provider. The provider's DWD flow requires `JWTConfigFromJSON`, which expects a `service_account` type with a private key for local JWT signing. `impersonated_service_account` has no private key, so the provider silently falls back to a non-DWD flow, resulting in 403 errors.
    >
    > **Limitation of the `accessToken` approach:** The short-lived token (~1 hour) is stored in Pulumi state. On subsequent runs with `--refresh`, Pulumi reinitializes the provider using the stale token from state before the program can mint a fresh one, causing `ACCESS_TOKEN_EXPIRED` errors. **Do NOT use `--refresh` with this stack.** The Makefile omits `--refresh` for this reason.
  * **Provider configuration:**
    * Instantiate a `google-workspace` provider with:
      * `customerId` — from config
      * `impersonatedUserEmail` — from config (`impersonateAdmin`)
      * `accessToken` — the freshly minted SA access token from step 2
      * `serviceAccount` — `serviceAccountEmail` from config (enables DWD via `SignJwt`)
      * `oauthScopes` — the Admin Directory scopes from step 1
    * All Google Workspace resources must use this explicit provider instance
  * **Config inputs for authentication:**
    * `identity:customerId` — Google Workspace customer ID (starts with `C`)
    * `identity:impersonateAdmin` — super admin email for user impersonation
    * `identity:serviceAccountEmail` — SA email from Organisation stack
* Validation
  * `domain` must be provided and non-empty
  * `customerId` must be provided and start with `C`
  * `impersonateAdmin` must be provided and contain `@`
  * `serviceAccountEmail` must be provided and contain `@`
  * At least one of `principals.users` or `principals.groups` must be non-empty
  * Each user entry must have `firstName`, `lastName`, and `emailPrimaryId` (all non-empty)
  * Each group entry must have `name` and at least one member — either in `users` or `groups` (or both). `description` is optional.
  * `emailPrimaryId` must not contain `@` (it is the ID-only portion, domain is appended automatically)
  * `groups[].groups[]` entries may reference group `name` values defined in `principals.groups` (created in same run) or pre-existing Google Cloud Identity groups. They must not contain `@`.
* Resource Naming
  * User resources: `user-<emailPrimaryId>` (e.g. `user-jdoe`)
  * Group resources: `group-<name>` (e.g. `group-pulumi-admins`)
  * Group member resources: `group-<name>-member-<emailPrimaryId>` (e.g. `group-pulumi-admins-member-jdoe`)
  * Password resources: `password-<emailPrimaryId>` (e.g. `password-jdoe`)
* Requirements
  * Create Identity Users
    * `primaryEmail` = `<emailPrimaryId>@<domain>` (concatenate the ID-only value with the config domain)
    * `name.givenName` = `firstName`
    * `name.familyName` = `lastName`
    * `recoveryEmail` = `emailSecondary` (if provided)
    * `recoveryPhone` = `phoneNumber` (if provided)
    * `orgUnitPath` = `organisationalUnit` (if provided, defaults to `/`)
    * Password generation:
      * Use `@pulumi/random` `RandomPassword` with `length: 16`, `special: true`
      * Use `keepers` tied to `emailPrimaryId` to ensure the password is stable across re-runs (only regenerated if the user identity changes)
      * Mark as `pulumi.secret()` — must not appear in plaintext in state or outputs
      * Set `changePasswordAtNextLogin: true` on the user resource
  * Create Identity Groups
    * Nesting is single-level only — a group's `groups[]` entries must not themselves have `groups[]` members created in this stack.
    * To handle dependencies, build two group lists:
      * List one: groups whose `name` appears in another group's `groups[]` array — create these groups first (they are depended upon)
      * List two: groups whose `name` does NOT appear in any other group's `groups[]` array — create these groups after, with explicit `dependsOn` on any groups from list one that they reference in their own `groups[]`
    * `email` = `<name>@<domain>` (concatenate group name with the config domain)
    * `description` = `description`
    * Assign each `emailPrimaryId` under `groups[].groups` as a `GROUP` member of the group:
      * Construct member email as `<emailPrimaryId>@<domain>`
      * Set member `type` to `GROUP`
      * Groups may reference entries defined in `principals.groups` (created in same run) or pre-existing Google Cloud Identity groups
      * Add explicit `dependsOn` on the corresponding group resource (if created in this stack) to ensure ordering
    * Assign each `emailPrimaryId` under `groups[].users` to the group:
      * Construct member email as `<emailPrimaryId>@<domain>`
      * Users may reference entries defined in `principals.users` (created in same run) or pre-existing Google Workspace users
      * Add explicit `dependsOn` on the corresponding user resource (if created in this stack) to ensure ordering
      * Rely on API error if the user does not exist
* Return
  * users — `pulumi.Output<{ [emailPrimaryId: string]: string }>` — map of email ID to full primary email
  * groups — `pulumi.Output<{ [name: string]: string }>` — map of group name to group email
