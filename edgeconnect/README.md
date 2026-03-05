# EdgeConnect Setup

## Quick Start

1. **Create EdgeConnect config** in Dynatrace:
   `Settings > General > External Requests > EdgeConnect > New EdgeConnect`

2. **Download the YAML** — click "Deploy" on your config, then download `edgeConnect.yaml`.
   Replace the template file in this folder with the downloaded one.

3. **Run the setup script:**
   ```bash
   cd edgeconnect/
   ./run-edgeconnect.sh
   ```

   Or manually:
   ```bash
   docker run -d --restart always \
     --name edgeconnect-bizobs \
     --mount type=bind,src=$PWD/edgeConnect.yaml,dst=/edgeConnect.yaml \
     dynatrace/edgeconnect:latest
   ```

4. **Verify** — go back to EdgeConnect settings, status should show **ONLINE**.

## YAML Fields Reference

| Field | Description | Example |
|---|---|---|
| `name` | Must match config name in Dynatrace (RFC 1123) | `bizobs-forge` |
| `api_endpoint_host` | Environment URL without `https://` | `abc12345.apps.dynatrace.com` |
| `oauth.endpoint` | SSO token URL (Production or Sprint) | `https://sso.dynatrace.com/sso/oauth2/token` |
| `oauth.client_id` | From EdgeConnect config download | `dt0s02.XXXXXXXX` |
| `oauth.client_secret` | Shown **once** at creation — save it! | `dt0s02.XXXXXXXX.XXXXXXXX...` |
| `oauth.resource` | `urn:dtenvironment:<environment-id>` | `urn:dtenvironment:abc12345` |
| `restrict_hosts_to` | (Optional) Limit which hosts to forward to | `YOUR_SERVER_IP`, `*.example.com` |

## SSO Endpoints
- **Production:** `https://sso.dynatrace.com/sso/oauth2/token`
- **Sprint/Labs:** `https://sso.dynatracelabs.com/sso/oauth2/token`

## Docs
https://docs.dynatrace.com/docs/ingest-from/edgeconnect
