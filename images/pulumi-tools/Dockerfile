# pulumi-tools: lightweight pulumi/pulumi-nodejs (node-only) plus the extra tooling the
# Makefile and CI build steps need: rsync, yq, and the Google Cloud CLI (gcloud + gsutil).
FROM pulumi/pulumi-nodejs

# yq (apt package is python-yq, which supports the `yq -r` usage in the Makefile) + rsync,
# then the Google Cloud CLI from its apt repo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        apt-transport-https ca-certificates curl gnupg make rsync yq \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
        > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*
