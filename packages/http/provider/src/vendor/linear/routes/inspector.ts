/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import type { InspectorTab, RouteContext } from "../../core/index.js";
import { chip, renderInspectorPage, section, table, type Block, type Inline } from "../../core/index.js";
import { getLinearStore } from "../store.js";
import type { LinearUser } from "../entities.js";

const SERVICE_LABEL = "Linear";

const TABS: InspectorTab[] = [
  { id: "issues", label: "Issues", href: "/?tab=issues" },
  { id: "teams", label: "Teams", href: "/?tab=teams" },
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "projects", label: "Projects", href: "/?tab=projects" },
  { id: "agents", label: "Agents", href: "/?tab=agents" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes({ app, store }: RouteContext): void {
  const ls = () => getLinearStore(store);

  app.get("/", async (c) => {
    const requested = c.req.query("tab") ?? "issues";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "issues";
    const body =
      active === "teams"
        ? teamsView()
        : active === "users"
          ? usersView()
          : active === "projects"
            ? projectsView()
            : active === "agents"
              ? agentsView()
              : active === "auth"
                ? authView()
                : active === "webhooks"
                  ? webhooksView()
                  : issuesView();
    return c.html(await renderInspectorPage("Linear Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function issuesView(): Block[] {
    const rows = ls()
      .issues.all()
      .sort((a, b) => a.identifier.localeCompare(b.identifier))
      .map((issue) => {
        const team = ls().teams.findOneBy("linear_id", issue.team_id);
        const state = ls().workflowStates.findOneBy("linear_id", issue.state_id);
        const assignee = issue.assignee_id ? ls().users.findOneBy("linear_id", issue.assignee_id) : undefined;
        const delegate = issue.delegate_id ? ls().users.findOneBy("linear_id", issue.delegate_id) : undefined;
        const labels = issue.label_ids
          .map((labelId) => ls().issueLabels.findOneBy("linear_id", labelId)?.name)
          .filter((name): name is string => Boolean(name))
          .join(", ");
        return [
          linkCell(`/?tab=issues&issue=${encodeURIComponent(issue.linear_id)}`, issue.identifier),
          issue.title,
          team?.key ?? issue.team_id,
          state?.name ?? issue.state_id,
          userLabel(assignee),
          userLabel(delegate),
          labels,
          issue.updated_at,
        ];
      });
    return [section(
      "Issues",
      table(["ID", "Title", "Team", "State", "Assignee", "Delegate", "Labels", "Updated"], rows, "No issues."),
    )];
  }

  function teamsView(): Block[] {
    const rows = ls()
      .teams.all()
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((team) => {
        const stateNames = ls()
          .workflowStates.findBy("team_id", team.linear_id)
          .sort((a, b) => a.position - b.position)
          .map((state) => state.name)
          .join(", ");
        const issueCount = ls().issues.count((issue) => issue.team_id === team.linear_id);
        return [
          team.key,
          team.name,
          String(issueCount),
          stateNames,
          team.private ? "private" : "public",
        ];
      });
    return [section("Teams", table(["Key", "Name", "Issues", "States", "Access"], rows, "No teams."))];
  }

  function usersView(): Block[] {
    const rows = ls()
      .users.all()
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((user) => [
        user.display_name,
        user.email,
        user.app ? "app" : "user",
        user.admin ? "admin" : "member",
        chip(user.active ? "active" : "inactive"),
        String(ls().issues.count((issue) => issue.assignee_id === user.linear_id)),
      ]);
    return [section("Users", table(["Name", "Email", "Kind", "Role", "Status", "Assigned"], rows, "No users."))];
  }

  function projectsView(): Block[] {
    const projectRows = ls()
      .projects.all()
      .map((project) => [
        project.name,
        project.state,
        project.team_id ? (ls().teams.findOneBy("linear_id", project.team_id)?.key ?? project.team_id) : "workspace",
        String(ls().issues.count((issue) => issue.project_id === project.linear_id)),
      ]);
    const cycleRows = ls()
      .cycles.all()
      .map((cycle) => [
        cycle.name,
        String(cycle.number),
        ls().teams.findOneBy("linear_id", cycle.team_id)?.key ?? cycle.team_id,
        String(ls().issues.count((issue) => issue.cycle_id === cycle.linear_id)),
      ]);
    return [
      section("Projects", table(["Name", "State", "Team", "Issues"], projectRows, "No projects.")),
      section("Cycles", table(["Name", "Number", "Team", "Issues"], cycleRows, "No cycles."))
    ];
  }

  function agentsView(): Block[] {
    const rows = ls()
      .agentSessions.all()
      .map((session) => {
        const issue = session.issue_id ? ls().issues.findOneBy("linear_id", session.issue_id) : undefined;
        const agent = ls().users.findOneBy("linear_id", session.agent_user_id);
        return [
          session.linear_id,
          chip(session.state),
          issue?.identifier ?? "",
          userLabel(agent),
          String(ls().agentActivities.count((activity) => activity.session_id === session.linear_id)),
          session.updated_at,
        ];
      });
    return [section(
      "Agent Sessions",
      table(["ID", "State", "Issue", "Agent", "Activities", "Updated"], rows, "No agent sessions."),
    )];
  }

  function authView(): Block[] {
    const appRows = ls()
      .oauthApps.all()
      .map((oauthApp) => [
        oauthApp.name,
        oauthApp.client_id,
        oauthApp.actor,
        oauthApp.scopes.join(", "),
        oauthApp.app_user_id ? userLabel(ls().users.findOneBy("linear_id", oauthApp.app_user_id)) : "",
      ]);
    const tokenRows = ls()
      .tokens.all()
      .map((token) => [
        maskToken(token.token),
        token.type,
        token.actor_type,
        token.user_id ? userLabel(ls().users.findOneBy("linear_id", token.user_id)) : (token.app_id ?? ""),
        token.scopes.join(", "),
        token.revoked ? chip("revoked") : token.expires_at ?? chip("active"),
      ]);
    return [
      section("OAuth Apps", table(["Name", "Client ID", "Actor", "Scopes", "App User"], appRows, "No OAuth apps.")),
      section("Tokens", table(["Token", "Type", "Actor", "Subject", "Scopes", "Status"], tokenRows, "No tokens."))
    ];
  }

  function webhooksView(): Block[] {
    const webhookRows = ls()
      .webhooks.all()
      .map((webhook) => [
        webhook.label,
        webhook.url,
        chip(webhook.enabled ? "enabled" : "disabled"),
        webhook.resource_types.join(", "),
          webhook.team_id
            ? (ls().teams.findOneBy("linear_id", webhook.team_id)?.key ?? webhook.team_id)
            : "all public teams",
      ]);
    const deliveryRows = ls()
      .webhookDeliveries.all()
      .slice(-30)
      .reverse()
      .map((delivery) => [
        delivery.event,
        delivery.action,
        delivery.status == null ? "" : chip(String(delivery.status)),
        delivery.error ?? "",
        delivery.url,
        delivery.created_at,
      ]);
    return [
      section(
        "Webhook Subscriptions",
        table(["Label", "URL", "Status", "Resources", "Scope"], webhookRows, "No webhooks."),
      ),
      section(
        "Webhook Deliveries",
        table(["Event", "Action", "Status", "Error", "URL", "Created"], deliveryRows, "No deliveries."),
      )
    ];
  }
}



function linkCell(href: string, label: string): Inline {
  return { link: label, href };
}

function userLabel(user: LinearUser | undefined): string {
  return user?.display_name ?? user?.email ?? "";
}

function maskToken(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
