import { getPool, withAllTenants } from "./client.js";
import { sealToken, openToken } from "./token-crypto.js";

/**
 * Social accounts somebody has connected.
 *
 * ============================================================
 * THE TOKEN NEVER LEAVES THIS FILE IN THE CLEAR
 * ============================================================
 *
 * `listConnections` — what every screen calls — does not select the encrypted
 * columns at all. Not "selects and strips them": does not ask for them. A field
 * that is never fetched cannot be accidentally spread into a JSON response, and
 * spreading a row into a response is how credentials leak in practice.
 *
 * `connectionSecret` is the one way to get a usable token, it is named so that
 * a reviewer notices it, and it is called by exactly one thing: the code that
 * talks to the platform.
 */

export interface SocialConnection {
  id: string;
  provider: string;
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
  scopes: string[];
  connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Whose it is. NULL means the business's own account. */
  employeeId: string | null;
  /** Whether the stored credential is still readable — see openToken. */
  usable: boolean;
}

interface Row {
  id: string;
  provider: string;
  external_id: string;
  display_name: string | null;
  avatar_url: string | null;
  scopes: string[];
  connected_at: string;
  last_synced_at: string | null;
  last_error: string | null;
  employee_id: string | null;
  has_token: boolean;
}

const toConnection = (row: Row): SocialConnection => ({
  id: row.id,
  provider: row.provider,
  externalId: row.external_id,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  scopes: row.scopes ?? [],
  connectedAt: row.connected_at,
  lastSyncedAt: row.last_synced_at,
  lastError: row.last_error,
  employeeId: row.employee_id,
  usable: row.has_token,
});

/**
 * What one person has connected.
 *
 * `employeeId` null asks for the BUSINESS's connections — the owner's. A staff
 * member passes their own id and gets only theirs; there is no argument that
 * returns everybody's, because no screen needs one.
 */
export async function listConnections(
  organizationId: string,
  employeeId: string | null
): Promise<SocialConnection[]> {
  const { rows } = await getPool().query<Row>(
    `select id, provider, external_id, display_name, avatar_url, scopes,
            connected_at, last_synced_at, last_error, employee_id,
            -- Presence only. The ciphertext itself is never selected here.
            (access_token_enc is not null) as has_token
       from social_connections
      where organization_id = $1
        and employee_id is not distinct from $2
      order by provider`,
    [organizationId, employeeId]
  );
  return rows.map(toConnection);
}

export interface SaveConnectionInput {
  organizationId: string;
  employeeId: string | null;
  provider: string;
  externalId: string;
  displayName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/**
 * Store a connection, replacing any previous one for the same person and
 * provider.
 *
 * Reconnecting is the ordinary case — a token expires, a scope is added, a
 * person switches account — and each of those must leave ONE row. Accumulating
 * them would leave dead credentials in the table with nothing to distinguish
 * the live one.
 */
export async function saveConnection(input: SaveConnectionInput): Promise<void> {
  await getPool().query(
    `insert into social_connections
       (organization_id, employee_id, provider, external_id, display_name, avatar_url,
        access_token_enc, refresh_token_enc, expires_at, scopes, connected_at, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), null)
     on conflict (organization_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
     do update set
       external_id       = excluded.external_id,
       display_name      = excluded.display_name,
       avatar_url        = excluded.avatar_url,
       access_token_enc  = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at        = excluded.expires_at,
       scopes            = excluded.scopes,
       connected_at      = now(),
       -- Cleared on reconnect. A stale error beside a working connection is a
       -- worse lie than no error at all.
       last_error        = null,
       updated_at        = now()`,
    [
      input.organizationId,
      input.employeeId,
      input.provider,
      input.externalId,
      input.displayName,
      input.avatarUrl,
      sealToken(input.accessToken),
      input.refreshToken ? sealToken(input.refreshToken) : null,
      input.expiresAt,
      input.scopes,
    ]
  );
}

/**
 * The usable credential for one connection.
 *
 * THE ONLY function that returns a token in the clear, named so it is obvious
 * in a diff. Returns null when the row is missing or the ciphertext will not
 * open — a key rotation, a truncated column — and the caller's response to both
 * is the same: ask the person to reconnect.
 */
export async function connectionSecret(
  organizationId: string,
  employeeId: string | null,
  provider: string
): Promise<{ accessToken: string; refreshToken: string | null; scopes: string[] } | null> {
  const { rows } = await getPool().query<{
    access_token_enc: string;
    refresh_token_enc: string | null;
    scopes: string[];
  }>(
    `select access_token_enc, refresh_token_enc, scopes
       from social_connections
      where organization_id = $1
        and employee_id is not distinct from $2
        and provider = $3`,
    [organizationId, employeeId, provider]
  );
  if (!rows[0]) return null;

  const accessToken = openToken(rows[0].access_token_enc);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: openToken(rows[0].refresh_token_enc),
    scopes: rows[0].scopes ?? [],
  };
}

/**
 * The token an outbound message on this number must be SENT with.
 *
 * A coexistence number lives on the staff member's own WhatsApp Business
 * Account, which the shared system-user token has no access to — so a reply
 * from it has to go out with the token captured when that number was connected.
 * Returns null for every other number (the shared company line, and dedicated
 * numbers on the platform's own WABA), where the shared token is correct and the
 * caller falls back to it.
 *
 * CROSS-TENANT ON PURPOSE, and the reason is the same one the delivery-status
 * path has: the sender knows only a phone_number_id — an opaque routing key, not
 * tenant data — and must resolve its credential whichever business owns the
 * number. Wrapped in withAllTenants with a stated reason so the step out of RLS
 * is deliberate and shows up in the logs, never silent.
 *
 * Returns null rather than throwing when the row is missing or the ciphertext
 * will not open (a rotated key, a truncated column): the caller then uses the
 * shared token, and for a coexistence number that send fails in a way that reads
 * as "reconnect", which is the honest outcome.
 */
export async function whatsappSendTokenForNumber(phoneNumberId: string): Promise<string | null> {
  return withAllTenants(
    "outbound WhatsApp: resolve the sending number's own credential",
    async () => {
      const { rows } = await getPool().query<{ access_token_enc: string }>(
        `select access_token_enc from social_connections
          where provider = 'whatsapp' and external_id = $1
          limit 1`,
        [phoneNumberId]
      );
      if (!rows[0]) return null;
      return openToken(rows[0].access_token_enc);
    }
  );
}

/**
 * Which business owns a connected Facebook Page or Instagram account.
 *
 * The inbound social processor knows only a Meta page id from the delivery — an
 * opaque routing key, not tenant data — and must find the business that connected
 * that Page whichever tenant it belongs to. Same cross-tenant shape, and same
 * stated reason, as whatsappSendTokenForNumber: wrapped in withAllTenants so the
 * step out of RLS is deliberate and shows in the logs.
 *
 * Returns null when no business has connected this Page — which is EVERY Page
 * today, because the connect flow (a later slice) is what writes these rows. So
 * this resolves nothing yet and the processor drops the delivery, exactly the
 * dormant-until-connected state the whole channel is in.
 */
export async function organizationForConnectedPage(pageId: string): Promise<string | null> {
  return withAllTenants(
    "inbound social: resolve the business that connected this Page",
    async () => {
      const { rows } = await getPool().query<{ organization_id: string }>(
        `select organization_id from social_connections
          where provider in ('facebook', 'instagram') and external_id = $1
          limit 1`,
        [pageId]
      );
      return rows[0]?.organization_id ?? null;
    }
  );
}

/**
 * The connected Page/IG a business replies AS on a given channel — id and token.
 *
 * A social reply is sent by the Page, so the outbound path needs two things it
 * cannot get from the conversation: the Page id (the sender) and its access
 * token (the credential). Both live on the business's own connection row
 * (employee_id null) for that provider — the one the connect flow writes.
 *
 * withAllTenants, the same as whatsappSendTokenForNumber and for the same reason:
 * the outbound conversation route runs without a tenant scope (it resolved the
 * conversation cross-tenant), and this filters by organization_id itself. The
 * step out of RLS is named so it shows in the logs.
 *
 * Returns null when nothing is connected — which is EVERY business today, so a
 * social reply fails with an honest "not connected yet" until the connect flow
 * (a later slice) writes the row. The token is decrypted here and nowhere else.
 */
export async function pageConnectionForOutbound(
  organizationId: string,
  provider: "facebook" | "instagram"
): Promise<{ pageId: string; token: string } | null> {
  return withAllTenants(
    "outbound social: resolve the connected Page's id and credential",
    async () => {
      const { rows } = await getPool().query<{ external_id: string; access_token_enc: string | null }>(
        `select external_id, access_token_enc from social_connections
          where organization_id = $1 and provider = $2 and employee_id is null
          limit 1`,
        [organizationId, provider]
      );
      const row = rows[0];
      if (!row || !row.access_token_enc) return null;
      const token = openToken(row.access_token_enc);
      if (!token) return null;
      return { pageId: row.external_id, token };
    }
  );
}

/**
 * Every connected staff mailbox due a background sync.
 *
 * The email sweep needs the (org, employee) pairs whose Gmail is connected, so
 * it can pull each one's client mail into the inbox on a schedule rather than
 * only when that person happens to open it. Names only the routing keys — no
 * token — for the same reason listConnections does: a function that never
 * selects the ciphertext cannot leak it. The sweep resolves each token through
 * `connectionSecret` per tenant, one at a time.
 *
 * Cross-tenant by nature: it reads every business's staff connections in one
 * pass. The caller states that reason via `withAllTenants`, the same shape as
 * the calendar sync's `listCalendarsForSync`, so the step out of RLS is
 * deliberate and shows in the logs instead of silently returning nothing under
 * DB_TENANT_ASSERT=strict.
 *
 * `employee_id is not null` because a mailbox is always a person's: the connect
 * flow refuses a business-level Gmail. `access_token_enc is not null` skips a
 * row whose credential has been cleared, which nothing can sync anyway.
 */
export async function listGmailConnectionsForSync(): Promise<
  Array<{ organizationId: string; employeeId: string }>
> {
  const { rows } = await getPool().query<{ organization_id: string; employee_id: string }>(
    `select organization_id, employee_id
       from social_connections
      where provider = 'gmail'
        and employee_id is not null
        and access_token_enc is not null`
  );
  return rows.map((r) => ({ organizationId: r.organization_id, employeeId: r.employee_id }));
}

/**
 * Every connected business mailbox (IMAP) due a background sync.
 *
 * The IMAP twin of `listGmailConnectionsForSync`. It also returns the address
 * (`external_id`), because unlike Gmail — where the address comes from the token's
 * profile — an IMAP connection IS its address, and the sweep needs it to log in.
 * The password itself is fetched per row through `connectionSecret`, never here.
 */
export async function listImapConnectionsForSync(): Promise<
  Array<{ organizationId: string; employeeId: string; email: string }>
> {
  const { rows } = await getPool().query<{
    organization_id: string;
    employee_id: string;
    external_id: string;
  }>(
    `select organization_id, employee_id, external_id
       from social_connections
      where provider = 'imap'
        and employee_id is not null
        and access_token_enc is not null`
  );
  return rows.map((r) => ({
    organizationId: r.organization_id,
    employeeId: r.employee_id,
    email: r.external_id,
  }));
}

/** Forget a connection entirely, token included. */
export async function removeConnection(
  organizationId: string,
  employeeId: string | null,
  provider: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from social_connections
      where organization_id = $1
        and employee_id is not distinct from $2
        and provider = $3`,
    [organizationId, employeeId, provider]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Record that a read succeeded, or why it did not.
 *
 * Kept separate from the connection itself so a failing sync never rewrites the
 * credential — the commonest cause of a failed read is an expired token, and
 * the worst possible response to that is to touch the token.
 */
export async function recordSync(
  organizationId: string,
  employeeId: string | null,
  provider: string,
  error: string | null
): Promise<void> {
  await getPool().query(
    `update social_connections
        set last_synced_at = case when $4::text is null then now() else last_synced_at end,
            last_error     = $4,
            updated_at     = now()
      where organization_id = $1
        and employee_id is not distinct from $2
        and provider = $3`,
    [organizationId, employeeId, provider, error]
  );
}

/**
 * Replace only the access token, keeping the refresh token that produced it.
 *
 * ============================================================
 * WHY NOT saveConnection
 * ============================================================
 *
 * A Google refresh response does NOT return a new refresh token. Round-tripping
 * through `saveConnection` would write null over the working one, and the
 * connection would die an hour later with no way to renew — a failure that
 * looks like the platform breaking a week after somebody set it up.
 *
 * So refreshing touches exactly the two columns that changed.
 */
export async function refreshStoredAccessToken(
  organizationId: string,
  employeeId: string | null,
  provider: string,
  accessToken: string,
  expiresAt: Date | null
): Promise<void> {
  await getPool().query(
    `update social_connections
        set access_token_enc = $4,
            expires_at       = $5,
            last_error       = null,
            updated_at       = now()
      where organization_id = $1
        and employee_id is not distinct from $2
        and provider = $3`,
    [organizationId, employeeId, provider, sealToken(accessToken), expiresAt]
  );
}

/** When the stored access token expires, or null if unknown. */
export async function connectionExpiry(
  organizationId: string,
  employeeId: string | null,
  provider: string
): Promise<Date | null> {
  const { rows } = await getPool().query<{ expires_at: Date | null }>(
    `select expires_at from social_connections
      where organization_id = $1 and employee_id is not distinct from $2 and provider = $3`,
    [organizationId, employeeId, provider]
  );
  return rows[0]?.expires_at ?? null;
}
