---
name: project-supabase-oauth-server-capabilities
description: "What Supabase Auth advertises as an OAuth server (userinfo yes, CIMD no, resource_parameter unadvertised), and that every project token shares aud \"authenticated\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 829c625c-bcb6-4c1a-8235-98fab892df47
  modified: 2026-08-12T00:04:32.623Z
---

Probed against production Aug 2026 with `debug/mcp-oauth-resource-probe.ts`,
then confirmed by a real ChatGPT connection.

Advertised at `${SUPABASE_URL}/auth/v1/.well-known/oauth-authorization-server`:
`authorization_endpoint`, `token_endpoint`, `registration_endpoint` (DCR), S256
PKCE, scopes `openid profile email phone offline_access`, and **a
`userinfo_endpoint`** (so ChatGPT Enterprise workspace domain verification is
reachable, contrary to my initial assumption).

**Absent:** `resource_parameter_supported` (RFC 8707) and
`client_id_metadata_document_supported` (so CIMD is unavailable, DCR stays the
path). Supabase nonetheless **accepts** a `resource` parameter rather than
rejecting it, so it never blocked the work.

**Security note worth revisiting:** every project token appears to carry
`aud: "authenticated"`, which would make any Supabase access token for the
project, including a dashboard session token, a valid MCP bearer. We do not
verify audience today. Status quo, not introduced by the ChatGPT work.

Probe gotcha: the value to pass as `--code` is the `code=` in the redirect,
NOT the `code_challenge` from the authorize URL.
