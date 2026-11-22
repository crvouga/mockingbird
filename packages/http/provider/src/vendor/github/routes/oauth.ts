/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { randomBytes } from "../../core/crypto.js";
import type { Context } from "../../core/index.js";
import type { RouteContext, Store, AuthUser, AppEnv } from "../../core/index.js";
import {
  unauthorized,
  renderErrorPage,
  renderProviderPage,
  renderSignInPage,
  table,
  type Block,
  type LinkItem,
  type NavItem,
  matchesRedirectUri,
  constantTimeSecretEqual,
  parseCookies,
  debug,
} from "../../core/index.js";
import { getGitHubStore } from "../store.js";
import { formatUser, formatUserFull } from "../helpers.js";

type PendingCode = {
  login: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  created_at: number;
};

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("github.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("github.oauth.pendingCodes", map);
  }
  return map;
}

function getTokenToClientId(store: Store): Map<string, string> {
  let map = store.getData<Map<string, string>>("github.oauth.tokenToClientId");
  if (!map) {
    map = new Map();
    store.setData("github.oauth.tokenToClientId", map);
  }
  return map;
}

function getSessionMap(store: Store): Map<string, string> {
  let map = store.getData<Map<string, string>>("github.oauth.sessionMap");
  if (!map) {
    map = new Map();
    store.setData("github.oauth.sessionMap", map);
  }
  return map;
}

/** On read: drops entries older than {@link PENDING_CODE_TTL_MS}. */
function getPendingCodeIfValid(store: Store, code: string): PendingCode | undefined {
  const map = getPendingCodes(store);
  const pending = map.get(code);
  if (!pending) return undefined;
  if (store.now() - pending.created_at > PENDING_CODE_TTL_MS) {
    map.delete(code);
    return undefined;
  }
  return pending;
}

const SERVICE_LABEL = "GitHub";

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const gh = getGitHubStore(store);

  function resolveSessionUser(c: Context<AppEnv>): { login: string; id: number } | null {
    const authUser = c.get("authUser") as AuthUser | undefined;
    if (authUser) {
      const user = gh.users.findOneBy("login", authUser.login);
      if (user) return { login: user.login, id: user.id };
    }
    const cookieHeader = c.req.header("Cookie") ?? "";
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies["_emu_session"];
    if (sessionId) {
      const login = getSessionMap(store).get(sessionId);
      if (login) {
        const user = gh.users.findOneBy("login", login);
        if (user) return { login: user.login, id: user.id };
      }
    }
    return null;
  }

  // ---------- OAuth authorize page ----------

  app.get("/login/oauth/authorize", async (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";

    const oauthAppsConfigured = gh.oauthApps.all().length > 0;
    let oauthAppForSubtitle: { name: string } | undefined;
    if (oauthAppsConfigured) {
      const oauthApp = gh.oauthApps.findOneBy("client_id", client_id);
      if (!oauthApp) {
        return c.html(await renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, oauthApp.redirect_uris)) {
        console.warn(
          `[OAuth] redirect_uri mismatch: got "${redirect_uri}", registered: ${JSON.stringify(oauthApp.redirect_uris)}`,
        );
        return c.html(await renderErrorPage(
            "Redirect URI mismatch",
            "The redirect_uri is not registered for this application.",
            SERVICE_LABEL,
          ),
          400,
        );
      }
      oauthAppForSubtitle = oauthApp;
    }

    const users = [...gh.users.all()].sort((a, b) => a.login.localeCompare(b.login));

    const subtitleText = oauthAppForSubtitle
      ? ["Authorize ", { strong: oauthAppForSubtitle.name }, " to access your account."]
      : "Choose a seeded user to authorize this application.";

    const userButtons = users
      .map((u) => {
        const brief = formatUser(u, baseUrl);
        const full = formatUserFull(u, baseUrl);
        return ({
          letter: (brief.login[0] ?? "?").toUpperCase(),
          login: full.login,
          name: full.name ?? undefined,
          email: full.email ?? undefined,
          formAction: "/login/oauth/callback",
          hiddenFields: {
            login: u.login,
            redirect_uri,
            scope,
            state,
            client_id,
          },
        });
      });


    return c.html(await renderSignInPage("Sign in to GitHub", subtitleText, userButtons, SERVICE_LABEL));
  });

  // ---------- OAuth callback (user selection) ----------

  app.post("/login/oauth/callback", async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const login = String(body.login ?? "");
    const redirect_uri = String(body.redirect_uri ?? "");
    const scope = String(body.scope ?? "");
    const state = String(body.state ?? "");
    const client_id = String(body.client_id ?? "");

    const code = randomBytes(20).toString("hex");
    getPendingCodes(store).set(code, {
      login,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      created_at: store.now(),
    });

    debug(
      "github.oauth",
      `[OAuth callback] generated code: ${code.slice(0, 8)}... for login=${login}, pendingCodes size: ${getPendingCodes(store).size}`,
    );

    const sessionId = randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    getSessionMap(store).set(sessionId, login);
    c.header("Set-Cookie", `_emu_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);

    const sep = redirect_uri.includes("?") ? "&" : "?";
    const target = `${redirect_uri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    debug("github.oauth", `[OAuth callback] redirecting to: ${target.slice(0, 120)}...`);
    return c.redirect(target, 302);
  });

  // ---------- Token exchange ----------

  app.post("/login/oauth/access_token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const accept = c.req.header("Accept") ?? "";
    debug("github.oauth", `[OAuth token] Content-Type: ${contentType}`);
    debug("github.oauth", `[OAuth token] Accept: ${accept}`);
    debug("github.oauth", `[OAuth token] pendingCodes size: ${getPendingCodes(store).size}`);
    debug(
      "github.oauth",
      `[OAuth token] pendingCodes keys: ${[...getPendingCodes(store).keys()].map((k) => k.slice(0, 8) + "...").join(", ")}`,
    );

    const rawText = await c.req.text();
    debug("github.oauth", `[OAuth token] raw body: ${rawText.slice(0, 500)}`);

    let raw: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try {
        raw = JSON.parse(rawText);
      } catch {
        raw = {};
      }
    } else {
      raw = Object.fromEntries(new URLSearchParams(rawText));
    }

    debug("github.oauth", `[OAuth token] parsed keys: ${Object.keys(raw).join(", ")}`);

    const code = String(raw.code ?? "");
    const bodyClientId = String(raw.client_id ?? "");
    const bodyClientSecret = String(raw.client_secret ?? "").slice(0, 4) + "****";

    debug("github.oauth", `[OAuth token] code: ${code.slice(0, 8)}... (len=${code.length})`);
    debug("github.oauth", `[OAuth token] client_id: ${bodyClientId}`);
    debug("github.oauth", `[OAuth token] client_secret: ${bodyClientSecret}`);

    const actualSecret = String(raw.client_secret ?? "");

    const incorrectClientCredentials = () => {
      debug("github.oauth", `[OAuth token] REJECTED: incorrect_client_credentials`);
      return c.json(
        {
          error: "incorrect_client_credentials",
          error_description: "The client_id and/or client_secret passed are incorrect.",
        },
        200,
      );
    };

    const oauthAppsConfigured = gh.oauthApps.all().length > 0;
    if (oauthAppsConfigured) {
      const oauthApp = gh.oauthApps.findOneBy("client_id", bodyClientId);
      if (!oauthApp) {
        debug("github.oauth", `[OAuth token] REJECTED: client_id not found in oauthApps`);
        return incorrectClientCredentials();
      }
      if (!constantTimeSecretEqual(actualSecret, oauthApp.client_secret)) {
        debug("github.oauth", `[OAuth token] REJECTED: client_secret mismatch`);
        return incorrectClientCredentials();
      }
      debug("github.oauth", `[OAuth token] client credentials OK (app: ${oauthApp.name})`);
    } else {
      debug("github.oauth", `[OAuth token] no oauth apps configured, skipping client validation`);
    }

    const pending = getPendingCodeIfValid(store, code);
    if (!pending) {
      debug("github.oauth", `[OAuth token] REJECTED: code not found in pendingCodes or expired`);
      return c.json(
        { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." },
        200,
      );
    }

    debug("github.oauth", `[OAuth token] code valid, login=${pending.login}, scope=${pending.scope}`);
    getPendingCodes(store).delete(code);

    const user = gh.users.findOneBy("login", pending.login);
    if (!user) {
      debug("github.oauth", `[OAuth token] REJECTED: user "${pending.login}" not found in store`);
      return c.json(
        { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." },
        200,
      );
    }

    const token = "gho_" + randomBytes(20).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const scopes = pending.scope ? pending.scope.split(/[,\s]+/).filter(Boolean) : ["repo", "user"];

    if (tokenMap) {
      tokenMap.set(token, { login: user.login, id: user.id, scopes });
    }

    const oauthApp = gh.oauthApps.findOneBy("client_id", pending.clientId);
    if (oauthApp) {
      const existingGrant = gh.oauthGrants.all().find((g) => g.user_id === user.id && g.client_id === pending.clientId);
      const orgAccess: Record<string, "granted" | "denied" | "requested"> = {};
      for (const org of gh.orgs.all()) {
        const isMember = gh.teamMembers
          .all()
          .some((tm) => tm.user_id === user.id && gh.teams.get(tm.team_id)?.org_id === org.id);
        if (isMember) orgAccess[org.login] = "granted";
      }

      if (existingGrant) {
        gh.oauthGrants.update(existingGrant.id, { scopes, org_access: orgAccess });
      } else {
        gh.oauthGrants.insert({
          user_id: user.id,
          oauth_app_id: oauthApp.id,
          client_id: pending.clientId,
          scopes,
          org_access: orgAccess,
        });
      }
      getTokenToClientId(store).set(token, pending.clientId);
    }

    debug("github.oauth", `[OAuth token] SUCCESS: issued token for ${user.login} (scopes: ${scopes.join(",")})`);

    const wantsFormEncoded = accept.includes("application/x-www-form-urlencoded");
    const scopeOut = pending.scope;

    if (wantsFormEncoded) {
      const formBody = `access_token=${encodeURIComponent(token)}&token_type=bearer&scope=${encodeURIComponent(scopeOut)}`;
      c.header("Content-Type", "application/x-www-form-urlencoded");
      return c.body(formBody, 200);
    }

    return c.json({
      access_token: token,
      token_type: "bearer",
      scope: scopeOut,
    });
  });

  // ---------- User emails ----------

  app.get("/user/emails", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      throw unauthorized();
    }
    const user = gh.users.findOneBy("login", authUser.login);
    if (!user) {
      throw unauthorized();
    }
    const email = user.email || `${user.login}@users.noreply.localhost`;
    return c.json([
      {
        email,
        primary: true,
        verified: true,
        visibility: "public",
      },
    ]);
  });

  // ---------- Settings: list authorized apps ----------

  const SCOPE_LABELS: Record<string, string> = {
    repo: "Full control of private repositories",
    "read:user": "Read all user profile data",
    "user:email": "Access user email addresses (read-only)",
    user: "Full control of user profile",
    workflow: "Update GitHub action workflows",
    "admin:org": "Full control of orgs and teams",
    "admin:repo_hook": "Full control of repository hooks",
    "read:org": "Read org and team membership",
    "write:repo_hook": "Write repository hooks",
    "read:repo_hook": "Read repository hooks",
    delete_repo: "Delete repositories",
    gist: "Create gists",
    notifications: "Access notifications",
    "write:packages": "Upload packages",
    "read:packages": "Download packages",
    "admin:gpg_key": "Full control of GPG keys",
    "admin:public_key": "Full control of public keys",
  };

  function scopeLabel(scope: string): string {
    return SCOPE_LABELS[scope] ?? scope;
  }

  const SETTINGS_NAV: NavItem[] = [{ label: "Authorized apps", href: "/settings/applications", current: true }];

  app.get("/settings/applications", async (c) => {
    const sessionUser = resolveSessionUser(c);
    if (!sessionUser) {
      return c.html(await renderErrorPage("Unauthorized", "You must be authenticated to view this page.", SERVICE_LABEL),
        401,
      );
    }

    const grants = gh.oauthGrants.findBy("user_id", sessionUser.id);
    const items: LinkItem[] = grants.map((grant) => {
      const oauthApp = gh.oauthApps.findOneBy("client_id", grant.client_id);
      const name = oauthApp?.name ?? grant.client_id;
      return {
        href: `/settings/connections/applications/${grant.client_id}`,
        title: name,
        description: grant.scopes.length > 0 ? grant.scopes.join(", ") : "No scopes",
        letter: (name[0] ?? "?").toUpperCase(),
      };
    });

    return c.html(
      await renderProviderPage({
        layout: "app",
        service: SERVICE_LABEL,
        title: "Authorized OAuth Apps",
        description: "Applications you have granted access to your account.",
        nav: SETTINGS_NAV,
        blocks: [
          {
            type: "links",
            items,
            empty: "No authorized applications. Apps you authorize will appear here.",
          },
        ],
      }),
    );
  });

  // ---------- Settings: app detail ----------

  app.get("/settings/connections/applications/:client_id", async (c) => {
    const sessionUser = resolveSessionUser(c);
    if (!sessionUser) {
      return c.html(await renderErrorPage("Unauthorized", "You must be authenticated to view this page.", SERVICE_LABEL),
        401,
      );
    }

    const clientId = c.req.param("client_id");

    const grant = gh.oauthGrants.all().find((g) => g.user_id === sessionUser.id && g.client_id === clientId);
    if (!grant) {
      return c.html(await renderErrorPage("Not Found", "No authorization found for this application.", SERVICE_LABEL), 404);
    }

    const oauthApp = gh.oauthApps.findOneBy("client_id", clientId);
    const appName = oauthApp?.name ?? clientId;
    const lastUsed = new Date(grant.updated_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const orgs = Object.entries(grant.org_access);
    const blocks: Block[] = [
      {
        type: "section",
        title: "Permissions",
        action: {
          type: "form",
          action: `/settings/connections/applications/${clientId}/revoke`,
          label: "Revoke access",
          variant: "danger",
        },
        blocks: [
          {
            type: "checklist",
            items: grant.scopes.map(scopeLabel),
            empty: "No specific permissions granted.",
          },
        ],
      },
    ];
    if (orgs.length > 0) {
      blocks.push({
        type: "section",
        title: "Organization access",
        description: "Applications act on your behalf. Organizations control which apps may access their private data.",
        blocks: [
          table(
            ["Organization", "Access"],
            orgs.map(([org, status]) => [
              org,
              { chip: status, status: status === "granted" ? "ok" : status === "denied" ? "error" : "neutral" },
            ]),
            "No organizations.",
            "Organization access",
          ),
        ],
      });
    }

    return c.html(
      await renderProviderPage({
        layout: "app",
        service: SERVICE_LABEL,
        title: appName,
        description: `Last used ${lastUsed}`,
        nav: SETTINGS_NAV,
        blocks,
      }),
    );
  });

  // ---------- Settings: revoke ----------

  app.post("/settings/connections/applications/:client_id/revoke", async (c) => {
    const sessionUser = resolveSessionUser(c);
    if (!sessionUser) {
      return c.html(await renderErrorPage("Unauthorized", "You must be authenticated to perform this action.", SERVICE_LABEL),
        401,
      );
    }

    const clientId = c.req.param("client_id");

    const grant = gh.oauthGrants.all().find((g) => g.user_id === sessionUser.id && g.client_id === clientId);
    if (grant) {
      gh.oauthGrants.delete(grant.id);
    }

    if (tokenMap) {
      for (const [token, tokenUser] of tokenMap.entries()) {
        if (tokenUser.login === sessionUser.login && getTokenToClientId(store).get(token) === clientId) {
          tokenMap.delete(token);
          getTokenToClientId(store).delete(token);
        }
      }
    }

    return c.redirect("/settings/applications", 302);
  });
}
