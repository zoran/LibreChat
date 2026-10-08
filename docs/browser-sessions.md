# Optional browser workspaces

Browser workspaces provide automatic, separate LibreChat USER identities without employee login or
registration. A returning browser restores its own history and preferences through an HttpOnly
credential. This feature is disabled unless explicitly configured:

```yaml
registration:
  browserSession:
    enabled: true
    maxAgeSeconds: 15552000 # 180 days, fixed from enrollment; no sliding renewal
    enrollmentMax: 100 # new workspaces per client IP per hour
```

Configure `DOMAIN_CLIENT` as the actual HTTPS application origin and qualify proxy trust before
enabling. Secure cookies require HTTPS. Enrollment requires current browsers with Web Locks and
persistent local storage. Tune the enrollment limit for the verified client-IP/forwarding behavior;
a shared NAT address must not unexpectedly block employees. Multiple replicas need the existing
shared limiter store configured for a common budget; an in-memory store enforces it per process.
This is a single-tenant provider. It rejects an already resolved tenant and does not accept a browser-supplied tenant or account ID.

The browser receives `__Host-librechat-browser` with Secure, HttpOnly, SameSite=Strict, Path=/ and no
Domain. Native Session storage retains only its hash and expiration. Enrollment creates an explicit
USER principal and initial balance/session in one MongoDB transaction, so a replica set supporting
transactions is required. It never uses first-user administrator registration. Administrators must
be provisioned through the existing authenticated/operator flows before admitting employees.

The persistent credential does not rotate on every access-token refresh. Its fixed deadline bounds
both inactive and active reuse; explicit forgetting/revocation ends further refresh. Normal native
access JWTs retain the configured `SESSION_EXPIRY` behavior (15 minutes by default). Already issued
JWTs are not immediately revoked by forgetting the browser; do not claim a stronger revocation SLA.
Native account deletion and administrative session deletion retain their current owners.

The browser stores only `active`/`paused` lifecycle state in `librechat.browser.state`, with a
transient `new` value during first enrollment. It contains no user ID, credential or conversation.
It prevents expired cookies or explicit logout from silently creating a different workspace. First
enrollment is serialized across tabs. Other tabs stop using their cached workspace when browser
access is forgotten. Real login, password recovery, 2FA, administrator and public-share entry paths
do not automatically enroll a browser principal.

“Forget browser access” revokes the credential, without deleting persisted history. The recovery
screen offers an explicit new workspace. Use the existing account-deletion flow to remove data.
Session expiry is not a history retention/deletion policy. Clearing cookies and local storage,
using another device or sharing a managed browser profile changes what can be recovered: there is
no fingerprinting, employee identity verification or cross-device recovery mechanism.

This component uses no infrastructure-specific identity service or product import. It continues to
use native authorization for conversations, messages, settings, files and jobs. Before production,
qualify two isolated browsers against those APIs, restart/replica recovery, expiry/forget behavior,
actual proxy headers and the managed Windows browser. Local source tests do not establish deployed
browser acceptance. Keep the feature off until the whole component and its HTTPS path are qualified.
