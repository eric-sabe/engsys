# Azure service-principal login for a fleet

`az-sp-login.sh` keeps a fleet's own `az` profile logged in as an Azure **service principal** using a
**certificate** credential. The profile lives in its own `AZURE_CONFIG_DIR`, so an operator's
interactive `~/.azure` login on the same machine is never touched. SDK-based tools do not need the CLI
login at all: they read `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_CERTIFICATE_PATH` from the
environment (`EnvironmentCredential`). The script covers the `az` CLI path and doubles as a scheduled
self-heal (profile wiped, certificate rotated, first boot).

```bash
az-sp-login.sh /path/to/azure-sp.env      # or: AZURE_SP_ENV=/path/to/azure-sp.env az-sp-login.sh
```

There is no default env file location: pass it as the argument or set `AZURE_SP_ENV`.

The script exits 0 immediately when the profile is already logged in as the right principal: the current
`az account` user must equal `AZURE_CLIENT_ID`, and its tenant and subscription must equal
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`, and a token must mint. Any mismatch (someone logged the
profile in as another account, a dead token) falls through to a clean `az login --service-principal`.
Run it from a scheduler (for example a launchd job every 6 hours; an instance can ship its own
`jobs/launchd/az-sp-login.plist.tmpl`) and as a session preflight.

## Env file

Machine-local, `chmod 600`, never committed. Plain `KEY=VALUE` lines (it is sourced by bash):

```bash
AZURE_CONFIG_DIR=$HOME/.config/acme-fleet/azure          # isolated az profile for the fleet
AZURE_CLIENT_ID=<service principal application (client) id>
AZURE_TENANT_ID=<directory (tenant) id>
AZURE_SUBSCRIPTION_ID=<subscription id the fleet works in>
AZURE_CLIENT_CERTIFICATE_PATH=$HOME/.config/acme-fleet/azure-sp.pem   # PEM with private key + certificate, chmod 600
```

All five are required; the script fails with a clear message if one is missing or the certificate file
does not exist.

## Rotating the certificate

Do the rotation as an owner of the app registration. Add the new certificate before removing the old one
so there is never a gap.

```bash
APP_ID=<AZURE_CLIENT_ID>

# 1. Create a new certificate and append it (keeps the current credential valid). --create-cert
#    generates a self-signed certificate and writes a PEM holding its private key and certificate;
#    the command prints that file's path.
az ad app credential reset --id "$APP_ID" --create-cert --append --years 1

# 2. Put the PEM it prints at AZURE_CLIENT_CERTIFICATE_PATH (chmod 600). The next scheduled
#    az-sp-login.sh run, or a manual run, re-logs in with it.
bash az-sp-login.sh /path/to/azure-sp.env

# 3. List credentials; note the keyId of the OLD certificate (the older endDateTime).
az ad app credential list --id "$APP_ID" -o table

# 4. Delete the old one.
az ad app credential delete --id "$APP_ID" --key-id <old keyId>
```

Always pass `--append`: without it, `reset` **replaces every** existing credential and the running fleet
loses access at once. Verify with `az-sp-login.sh` after step 2 and again after step 4.
